const express = require("express");
const crypto  = require("crypto");
const axios   = require("axios");
const OpenAI  = require("openai");

const app = express();

// Necesitamos el body "crudo" para poder verificar la firma que manda Meta
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const APP_SECRET      = process.env.APP_SECRET;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const AI_PROMPT       = process.env.AI_PROMPT || "Eres el asistente de Roberto, entrenador fitness. Responde de forma amigable y breve en español.";
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN; // Instagram User Access Token (Instagram Login)
const IG_ACCOUNT_ID   = process.env.IG_ACCOUNT_ID;   // tu <IG_ID>

// Retraso mínimo/máximo (en segundos) antes de responder, para darle tiempo
// al lead de mandar varias líneas seguidas sin que el bot le conteste una por una.
const MIN_DELAY_SECONDS = parseInt(process.env.MIN_DELAY_SECONDS || "8", 10);
const MAX_DELAY_SECONDS = parseInt(process.env.MAX_DELAY_SECONDS || "15", 10);

// ---------------------------------------------------------------
// Seguimientos automáticos (follow-ups)
// ---------------------------------------------------------------
// Meta solo permite mandar mensajes a un usuario dentro de las 24 horas
// posteriores a SU ÚLTIMO mensaje. Pasado ese tiempo, el envío se rechaza
// (a menos que se tenga el permiso especial "human_agent", que es otro
// proceso de aprobación aparte). Por eso cada seguimiento se valida contra
// esa ventana antes de programarse y antes de enviarse.
//
// Configúralo en Render con la variable de entorno SEGUIMIENTOS, en formato
// JSON, como un arreglo de { "horas": X, "mensaje": "..." }. "horas" es
// el tiempo de inactividad del usuario (desde su último mensaje) que debe
// pasar para disparar ese seguimiento. Ejemplo:
//
// SEGUIMIENTOS=[{"horas":1,"mensaje":"Oye, ¿sigues por ahí? 😊"},{"horas":5,"mensaje":"Cualquier duda me dices, aquí ando 🙌"}]
//
// Si no defines la variable, se usan estos valores por defecto:
const SEGUIMIENTOS_DEFAULT = [
  { horas: 1,  mensaje: "Hola de nuevo 👋 ¿sigues por ahí? Con gusto te sigo ayudando." },
  { horas: 4,  mensaje: "Oye, cualquier duda que tengas aquí ando, no hay prisa 🙌" },
  { horas: 20, mensaje: "Última señal antes de que se cierre esta conversación por hoy — si te interesa seguimos platicando 😊" }
];

let SEGUIMIENTOS_CONFIG;
try {
  SEGUIMIENTOS_CONFIG = process.env.SEGUIMIENTOS
    ? JSON.parse(process.env.SEGUIMIENTOS)
    : SEGUIMIENTOS_DEFAULT;
} catch (err) {
  console.error("⚠️ SEGUIMIENTOS mal formado en las variables de entorno, usando valores por defecto:", err.message);
  SEGUIMIENTOS_CONFIG = SEGUIMIENTOS_DEFAULT;
}
// Ordenamos por tiempo ascendente, por si acaso el usuario los puso desordenados
SEGUIMIENTOS_CONFIG = [...SEGUIMIENTOS_CONFIG].sort((a, b) => a.horas - b.horas);

const VENTANA_24H_MS = 24 * 60 * 60 * 1000;
// Dejamos un pequeño colchón de seguridad para no arriesgarnos a que el envío
// llegue justo al límite y Meta lo rechace por unos segundos de diferencia.
const COLCHON_SEGURIDAD_MS = 2 * 60 * 1000; // 2 minutos

// Último momento en que CADA usuario escribió (no cuando el bot respondió).
// Es la referencia real para calcular la ventana de 24h de Meta.
const ultimoMensajeUsuario = new Map();

// Timers de seguimiento activos por usuario, para poder cancelarlos si el
// usuario vuelve a escribir antes de que se disparen.
const timersSeguimiento = new Map();

function cancelarSeguimientos(senderId) {
  const timers = timersSeguimiento.get(senderId);
  if (timers) {
    timers.forEach(t => clearTimeout(t));
    timersSeguimiento.delete(senderId);
  }
}

function programarSeguimientos(senderId) {
  cancelarSeguimientos(senderId);

  const ultimoMsg = ultimoMensajeUsuario.get(senderId);
  if (!ultimoMsg) return;

  const limiteVentana = ultimoMsg + VENTANA_24H_MS - COLCHON_SEGURIDAD_MS;
  const timers = [];

  for (const { horas, mensaje } of SEGUIMIENTOS_CONFIG) {
    const momentoDisparo = ultimoMsg + horas * 60 * 60 * 1000;

    if (momentoDisparo > limiteVentana) {
      console.log(`⏭️ Seguimiento de ${horas} h para ${senderId} omitido: caería fuera de la ventana de 24h de Meta.`);
      continue;
    }

    const delay = momentoDisparo - Date.now();
    if (delay <= 0) continue; // ya pasó ese punto, no tiene caso programarlo

    const timer = setTimeout(async () => {
      // Verificación final por si acaso, justo antes de enviar
      const sigueVigente = Date.now() <= (ultimoMensajeUsuario.get(senderId) + VENTANA_24H_MS - COLCHON_SEGURIDAD_MS);
      if (!sigueVigente) {
        console.log(`⏭️ Seguimiento de ${horas} h para ${senderId} cancelado al momento de enviar: ya se salió de la ventana de 24h.`);
        return;
      }
      console.log(`🔔 Enviando seguimiento (${horas} h) a ${senderId}: "${mensaje}"`);
      await enviarMensajeInstagram(senderId, mensaje);
      agregarAlHistorial(senderId, "assistant", mensaje);
    }, delay);

    timers.push(timer);
  }

  timersSeguimiento.set(senderId, timers);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const yaRespondidos = new Set();

// Buffer de mensajes pendientes por usuario, para agrupar mensajes seguidos
// y garantizar que solo se mande UNA respuesta por ráfaga de mensajes.
// Estructura: { senderId: { mensajes: [], timer, enProceso } }
const buffers = new Map();

// Historial de conversación por usuario, para que el bot recuerde lo hablado
// y continúe la conversación en vez de responder cada mensaje "desde cero".
// Estructura: { senderId: [ { role: "user"|"assistant", content: "..." }, ... ] }
// NOTA: esto vive en memoria (RAM). Si el servidor se reinicia o se duerme
// (plan gratuito de Render), el historial se pierde. Para memoria permanente
// habría que guardar esto en una base de datos externa.
const historiales = new Map();


// Cuántos mensajes (de ambos lados) mantenemos como máximo por usuario,
// para no mandar un historial infinito a la IA (costo y límite de tokens).
const MAX_HISTORIAL = parseInt(process.env.MAX_HISTORIAL || "20", 10);

function obtenerHistorial(senderId) {
  if (!historiales.has(senderId)) historiales.set(senderId, []);
  return historiales.get(senderId);
}

function agregarAlHistorial(senderId, role, content) {
  const historial = obtenerHistorial(senderId);
  historial.push({ role, content });
  // Recortamos por si se hace muy largo
  while (historial.length > MAX_HISTORIAL) historial.shift();
}

function segundosAleatorios(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

async function enviarMensajeInstagram(senderId, texto) {
  await axios.post(
    `https://graph.instagram.com/v25.0/${IG_ACCOUNT_ID}/messages`,
    {
      recipient: { id: senderId },
      message:   { text: texto }
    },
    {
      headers: { "Authorization": `Bearer ${IG_ACCESS_TOKEN}` }
    }
  );
}

async function procesarBuffer(senderId) {
  const buffer = buffers.get(senderId);
  if (!buffer || buffer.mensajes.length === 0) return;

  // Tomamos una "foto" de los mensajes acumulados hasta ahora y la vaciamos,
  // pero NO borramos el buffer del Map: si llegan mensajes nuevos mientras
  // esperamos la respuesta de la IA, se van a acumular aquí mismo y se
  // agruparán en la SIGUIENTE respuesta, nunca se manda una segunda en paralelo.
  const mensajesAResponder = buffer.mensajes;
  buffer.mensajes = [];
  buffer.enProceso = true;

  const mensajeCompleto = mensajesAResponder.join("\n");
  console.log(`📨 Mensaje agrupado de ${senderId}: "${mensajeCompleto}"`);

  try {
    const historial = obtenerHistorial(senderId);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: AI_PROMPT },
        ...historial,
        { role: "user", content: mensajeCompleto }
      ],
      max_tokens: 300,
      temperature: 0.7
    });

    const respuesta = completion.choices[0]?.message?.content?.trim();
    if (respuesta) {
      console.log(`🤖 Respuesta IA: "${respuesta}"`);

      // Guardamos el intercambio en el historial para recordarlo después
      agregarAlHistorial(senderId, "user", mensajeCompleto);
      agregarAlHistorial(senderId, "assistant", respuesta);

      await enviarMensajeInstagram(senderId, respuesta);

      console.log(`✅ Respondido a ${senderId} (una sola respuesta por ${mensajesAResponder.length} línea(s))`);
    }
  } catch (err) {
    console.error(`❌ Error al responder:`, err.response?.data || err.message);
  }

  buffer.enProceso = false;

  // Si mientras respondíamos llegaron mensajes nuevos, programamos otra
  // ronda de espera para responderlos juntos (una sola respuesta más).
  if (buffer.mensajes.length > 0) {
    const delay = segundosAleatorios(MIN_DELAY_SECONDS, MAX_DELAY_SECONDS);
    buffer.timer = setTimeout(() => procesarBuffer(senderId), delay);
  } else {
    buffers.delete(senderId);
    // Ya no hay más mensajes pendientes de este usuario: a partir de aquí
    // empieza a contar el tiempo de inactividad para los seguimientos.
    programarSeguimientos(senderId);
  }
}

function encolarMensaje(senderId, mensaje) {
  let buffer = buffers.get(senderId);

  if (!buffer) {
    buffer = { mensajes: [], timer: null, enProceso: false };
    buffers.set(senderId, buffer);
  }

  buffer.mensajes.push(mensaje);

  // Si ya estamos generando una respuesta para este usuario, no tocamos el
  // timer: el mensaje quedó guardado y se incluirá en la siguiente ronda
  // (procesarBuffer lo reprograma automáticamente al terminar).
  if (buffer.enProceso) return;

  // Cada mensaje nuevo reinicia el temporizador: solo respondemos cuando
  // pasan MIN-MAX segundos SIN que llegue un mensaje nuevo del mismo usuario.
  if (buffer.timer) clearTimeout(buffer.timer);

  const delay = segundosAleatorios(MIN_DELAY_SECONDS, MAX_DELAY_SECONDS);
  buffer.timer = setTimeout(() => procesarBuffer(senderId), delay);
}


// ---------------------------------------------------------------
// Verificación del webhook (GET, lo hace Meta una sola vez al configurarlo)
// ---------------------------------------------------------------
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado por Meta");
    res.status(200).send(challenge);
  } else {
    console.log("❌ Token inválido");
    res.sendStatus(403);
  }
});

// ---------------------------------------------------------------
// Verifica que el POST realmente venga de Meta (firma HMAC con tu App Secret)
// ---------------------------------------------------------------
function verifySignature(req) {
  const signature = req.get("x-hub-signature-256");

  // --- LOGS TEMPORALES DE DEPURACIÓN, quitar después ---
  console.log("🔍 Firma recibida:", signature);
  console.log("🔍 APP_SECRET está definido:", !!APP_SECRET, "longitud:", APP_SECRET?.length);
  // -------------------------------------------------------

  if (!signature || !APP_SECRET) return false;

  const expected = "sha256=" + crypto
    .createHmac("sha256", APP_SECRET)
    .update(req.rawBody)
    .digest("hex");

  console.log("🔍 Firma esperada:", expected);

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------
// Recepción de mensajes
// ---------------------------------------------------------------
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Meta espera respuesta rápida (<5s)

  if (!verifySignature(req)) {
    console.warn("⚠️ Firma inválida, se ignora el request");
    return;
  }

  const body = req.body;
  if (body.object !== "instagram") return;

  // --- DIAGNÓSTICO TEMPORAL: log de TODO lo que llega, para ver la forma real del payload ---
  console.log("📦 Payload completo:", JSON.stringify(body, null, 2));
  // -------------------------------------------------------------------------------------------

  for (const entry of body.entry || []) {
    const eventos = [];

    // Formato real observado en el probador de webhooks de Meta:
    // entry.changes[].field === "messages", con el evento en change.value
    for (const change of entry.changes || []) {
      if (change.field === "messages" && change.value) {
        eventos.push(change.value);
      }
    }

    // Por si acaso, también soportamos el formato entry.messaging (Messenger Platform clásico)
    for (const event of entry.messaging || []) {
      eventos.push(event);
    }

    // Si los mensajes están cayendo en "standby" (conflicto de Handover Protocol con otra app),
    // esto lo va a mostrar en el log aunque no lo procesemos todavía.
    if (entry.standby) {
      console.log("⚠️ Evento recibido en STANDBY (otra app tiene el control principal):", JSON.stringify(entry.standby));
    }

    for (const event of eventos) {
      const senderId = event.sender?.id;
      const mensaje  = event.message?.text;

      if (!senderId || !mensaje) continue;
      if (event.message?.is_echo) continue;

      const msgId = event.message?.mid;
      if (msgId && yaRespondidos.has(msgId)) continue;
      if (msgId) yaRespondidos.add(msgId);

      console.log(`📨 Mensaje recibido de ${senderId}: "${mensaje}" (esperando a ver si manda más líneas...)`);

      // El usuario volvió a escribir: reiniciamos la ventana de 24h de Meta
      // desde este momento, y cancelamos cualquier seguimiento que ya no
      // tenga sentido mandar (la conversación está activa de nuevo).
      ultimoMensajeUsuario.set(senderId, Date.now());
      cancelarSeguimientos(senderId);

      // En vez de responder de inmediato, lo metemos al buffer del usuario.
      // Se responderá una sola vez, agrupando todo lo que mande, después de
      // que pasen entre MIN_DELAY_SECONDS y MAX_DELAY_SECONDS sin mensajes nuevos.
      encolarMensaje(senderId, mensaje);
    }

  }
});

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Instagram AI Responder activo 🤖" });
});

// ---------------------------------------------------------------
// Política de privacidad y eliminación de datos
// (requeridas por Meta para poder publicar la app)
// ---------------------------------------------------------------
app.get("/privacy", (req, res) => {
  res.type("html").send(`
    <html>
      <head><title>Política de Privacidad - Instagram AI Responder</title></head>
      <body style="font-family: sans-serif; max-width: 700px; margin: 40px auto; line-height: 1.6;">
        <h1>Política de Privacidad</h1>
        <p>Última actualización: ${new Date().toLocaleDateString("es-MX")}</p>
        <p>Esta aplicación ("Instagram AI Responder") es una herramienta de uso privado que
        automatiza respuestas a mensajes directos (DM) recibidos en la cuenta de Instagram
        conectada, utilizando inteligencia artificial (OpenAI).</p>
        <h2>Datos que procesamos</h2>
        <p>Procesamos el contenido de los mensajes directos recibidos y el identificador
        de Instagram del remitente, únicamente con el fin de generar y enviar una respuesta
        automática. No almacenamos el contenido de los mensajes de forma permanente ni lo
        compartimos con terceros, salvo el envío del texto del mensaje al proveedor de IA
        (OpenAI) para generar la respuesta.</p>
        <h2>Uso de terceros</h2>
        <p>Utilizamos la API de OpenAI para generar las respuestas automáticas. Consulta la
        política de privacidad de OpenAI para más información sobre cómo procesan los datos
        que reciben.</p>
        <h2>Contacto</h2>
        <p>Para dudas sobre esta política, contáctanos en: [tu correo aquí]</p>
      </body>
    </html>
  `);
});

app.get("/data-deletion", (req, res) => {
  res.type("html").send(`
    <html>
      <head><title>Eliminación de Datos - Instagram AI Responder</title></head>
      <body style="font-family: sans-serif; max-width: 700px; margin: 40px auto; line-height: 1.6;">
        <h1>Instrucciones para Eliminación de Datos</h1>
        <p>Esta aplicación no almacena de forma permanente el contenido de los mensajes
        directos procesados. Si deseas solicitar la eliminación de cualquier dato asociado
        a tu cuenta de Instagram que haya sido procesado por esta app, envía tu solicitud a:
        [tu correo aquí], indicando tu nombre de usuario de Instagram. Procesaremos tu
        solicitud en un plazo máximo de 30 días.</p>
      </body>
    </html>
  `);
});

// --- ENDPOINTS TEMPORALES DE DIAGNÓSTICO, quitar cuando todo funcione ---

// Ver qué apps están suscritas actualmente a esta cuenta de Instagram
app.get("/check-subscription", async (req, res) => {
  try {
    const response = await axios.get(
      `https://graph.instagram.com/v25.0/${IG_ACCOUNT_ID}/subscribed_apps`,
      { headers: { "Authorization": `Bearer ${IG_ACCESS_TOKEN}` } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json(err.response?.data || { error: err.message });
  }
});

// Forzar la suscripción al campo "messages" para esta cuenta
app.get("/force-subscribe", async (req, res) => {
  try {
    const response = await axios.post(
      `https://graph.instagram.com/v25.0/${IG_ACCOUNT_ID}/subscribed_apps`,
      null,
      {
        params: { subscribed_fields: "messages" },
        headers: { "Authorization": `Bearer ${IG_ACCESS_TOKEN}` }
      }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json(err.response?.data || { error: err.message });
  }
});

// Ver el historial de conversación guardado en memoria para un usuario (debug)
app.get("/historial/:senderId", (req, res) => {
  const historial = historiales.get(req.params.senderId) || [];
  res.json({ senderId: req.params.senderId, historial });
});

// Ver la configuración de seguimientos activa y el estado de un usuario (debug)
app.get("/seguimientos/:senderId?", (req, res) => {
  const info = { configuracion: SEGUIMIENTOS_CONFIG };
  if (req.params.senderId) {
    const ultimo = ultimoMensajeUsuario.get(req.params.senderId);
    info.senderId = req.params.senderId;
    info.ultimoMensajeUsuario = ultimo ? new Date(ultimo).toISOString() : null;
    info.seguimientosPendientes = (timersSeguimiento.get(req.params.senderId) || []).length;
  }
  res.json(info);
});
// -------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
