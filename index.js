const express = require("express");
const crypto  = require("crypto");
const axios   = require("axios");
const OpenAI  = require("openai");
const { createClient } = require("@supabase/supabase-js");

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

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Clave para proteger los endpoints de diagnóstico/admin (historial, seguimientos, etc.)
// Genera una clave larga y aleatoria y ponla en Render como ADMIN_API_KEY.
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

function requireAdminKey(req, res, next) {
  const key = req.get("x-admin-key") || req.query.key;
  if (!ADMIN_API_KEY || key !== ADMIN_API_KEY) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

// Retraso mínimo/máximo (en segundos) antes de responder, para darle tiempo
// al lead de mandar varias líneas seguidas sin que el bot le conteste una por una.
const MIN_DELAY_SECONDS = parseInt(process.env.MIN_DELAY_SECONDS || "8", 10);
const MAX_DELAY_SECONDS = parseInt(process.env.MAX_DELAY_SECONDS || "15", 10);

// Cuántos mensajes (de ambos lados) mantenemos como máximo por usuario,
// para no mandar un historial infinito a la IA (costo y límite de tokens).
const MAX_HISTORIAL = parseInt(process.env.MAX_HISTORIAL || "20", 10);

// ---------------------------------------------------------------
// Seguimientos automáticos (follow-ups) — CONFIGURACIÓN
// ---------------------------------------------------------------
// Meta solo permite mandar mensajes a un usuario dentro de las 24 horas
// posteriores a SU ÚLTIMO mensaje. Pasado ese tiempo, el envío se rechaza
// (a menos que se tenga el permiso especial "human_agent", que es otro
// proceso de aprobación aparte, y solo para mensajes mandados por una
// persona real, no por el bot).
//
// Configúralo en Render con la variable de entorno SEGUIMIENTOS, en formato
// JSON, como un arreglo de pasos: { "horas": X, "mensajes": ["...", "...", ...] }.
// Puedes poner tantos pasos como quieras. "horas" es el tiempo de inactividad
// del usuario (desde su último mensaje) que debe pasar para disparar ese paso.
// "mensajes" es una LISTA de mensajes posibles para ese paso: cada vez que ese
// paso se dispara para un usuario, se manda el siguiente de la lista (rotando,
// sin repetir ninguno hasta haber usado todos).
//
// Ejemplo:
// SEGUIMIENTOS=[{"horas":0.3,"mensajes":["...","...","..."]},{"horas":3,"mensajes":["...","..."]},{"horas":20,"mensajes":["..."]}]
const SEGUIMIENTOS_DEFAULT = [
  {
    horas: 0.3,
    mensajes: [
      "Hola de nuevo 👋 ¿sigues por ahí? Con gusto te sigo ayudando.",
      "Oye, ¿te distrajiste? Aquí sigo si quieres retomar 😊",
      "¿Todo bien? Quedé pendiente de tu mensaje 🙌"
    ]
  },
  {
    horas: 3,
    mensajes: [
      "Oye, cualquier duda sobre los planes o los horarios, aquí ando para resolverte 💪",
      "¿Te quedaste con alguna pregunta sobre el entrenamiento? Con gusto te explico mejor.",
      "Si quieres te comparto más detalles de cómo trabajamos, solo dime 🙌"
    ]
  },
  {
    horas: 20,
    mensajes: [
      "Última oportunidad de platicar hoy — si te interesa seguimos, aquí ando 😊",
      "Antes de que se cierre por hoy: ¿te gustaría que te comparta los horarios disponibles?",
      "Cierro por hoy, pero si quieres retomar mañana aquí estoy 💪"
    ]
  }
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
SEGUIMIENTOS_CONFIG = [...SEGUIMIENTOS_CONFIG].sort((a, b) => a.horas - b.horas);

const VENTANA_24H_MS      = 24 * 60 * 60 * 1000;
const COLCHON_SEGURIDAD_MS = 2 * 60 * 1000; // 2 minutos de margen de seguridad

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Estos dos SÍ pueden quedarse en memoria: solo importan mientras dura una
// ráfaga de mensajes de pocos segundos, con el servidor ya despierto y activo.
const buffers = new Map();       // { senderId: { mensajes: [], timer, enProceso } }
const yaRespondidos = new Set(); // dedupe de message IDs recientes

// ---------------------------------------------------------------
// Acceso a la base de datos (Supabase) — historial y seguimientos
// ---------------------------------------------------------------

async function obtenerConversacion(senderId) {
  const { data, error } = await supabase
    .from("conversaciones")
    .select("*")
    .eq("sender_id", senderId)
    .maybeSingle();

  if (error) {
    console.error("❌ Error leyendo conversación de Supabase:", error.message);
    return { sender_id: senderId, historial: [], rotacion: {}, ultimo_mensaje_usuario: null };
  }

  if (!data) {
    return { sender_id: senderId, historial: [], rotacion: {}, ultimo_mensaje_usuario: null };
  }

  return data;
}

async function guardarConversacion(senderId, campos) {
  const { error } = await supabase
    .from("conversaciones")
    .upsert({ sender_id: senderId, actualizado_en: new Date().toISOString(), ...campos });

  if (error) console.error("❌ Error guardando conversación en Supabase:", error.message);
}

async function agregarAlHistorialDB(senderId, role, content) {
  const conv = await obtenerConversacion(senderId);
  const historial = [...(conv.historial || []), { role, content }];
  while (historial.length > MAX_HISTORIAL) historial.shift();
  await guardarConversacion(senderId, { historial });
  return historial;
}

async function registrarMensajeUsuario(senderId) {
  await guardarConversacion(senderId, { ultimo_mensaje_usuario: new Date().toISOString() });
}

async function cancelarSeguimientosPendientesDB(senderId) {
  const { error } = await supabase
    .from("seguimientos_programados")
    .delete()
    .eq("sender_id", senderId)
    .eq("enviado", false);

  if (error) console.error("❌ Error cancelando seguimientos en Supabase:", error.message);
}

async function programarSeguimientosDB(senderId) {
  await cancelarSeguimientosPendientesDB(senderId);

  const conv = await obtenerConversacion(senderId);
  if (!conv.ultimo_mensaje_usuario) return;

  const ultimoMsg = new Date(conv.ultimo_mensaje_usuario).getTime();
  const limiteVentana = ultimoMsg + VENTANA_24H_MS - COLCHON_SEGURIDAD_MS;

  const filas = [];
  for (let i = 0; i < SEGUIMIENTOS_CONFIG.length; i++) {
    const { horas, mensajes } = SEGUIMIENTOS_CONFIG[i];
    if (!Array.isArray(mensajes) || mensajes.length === 0) continue;

    const momentoDisparo = ultimoMsg + horas * 60 * 60 * 1000;
    if (momentoDisparo > limiteVentana) continue; // se saldría de la ventana de 24h
    if (momentoDisparo <= Date.now()) continue;    // ya pasó ese punto

    filas.push({
      sender_id: senderId,
      paso_index: i,
      disparar_en: new Date(momentoDisparo).toISOString(),
      enviado: false
    });
  }

  if (filas.length === 0) return;

  const { error } = await supabase.from("seguimientos_programados").insert(filas);
  if (error) console.error("❌ Error programando seguimientos en Supabase:", error.message);
}

// Llamado periódicamente (por UptimeRobot pegándole a /cron/seguimientos)
// para revisar qué seguimientos ya se deben mandar.
async function procesarSeguimientosPendientesDB() {
  const botActivo = await estaBotActivo();
  if (!botActivo) {
    console.log("⏸️ Bot apagado: se omite el envío de seguimientos programados.");
    return { procesados: 0, bot_apagado: true };
  }

  const ahoraISO = new Date().toISOString();

  const { data: pendientes, error } = await supabase
    .from("seguimientos_programados")
    .select("*")
    .eq("enviado", false)
    .lte("disparar_en", ahoraISO);

  if (error) {
    console.error("❌ Error consultando seguimientos pendientes:", error.message);
    return { procesados: 0 };
  }

  let procesados = 0;

  for (const fila of pendientes || []) {
    const { id, sender_id: senderId, paso_index: pasoIndex } = fila;

    const conv = await obtenerConversacion(senderId);
    const ultimoMsg = conv.ultimo_mensaje_usuario ? new Date(conv.ultimo_mensaje_usuario).getTime() : 0;
    const sigueVigente = Date.now() <= (ultimoMsg + VENTANA_24H_MS - COLCHON_SEGURIDAD_MS);

    // Siempre marcamos como procesado (enviado=true) para no reintentar en bucle,
    // ya sea que se mande el mensaje o que se descarte por estar fuera de ventana.
    if (!sigueVigente) {
      console.log(`⏭️ Seguimiento (paso ${pasoIndex}) para ${senderId} descartado: fuera de la ventana de 24h.`);
      await supabase.from("seguimientos_programados").update({ enviado: true }).eq("id", id);
      continue;
    }

    const pasoConfig = SEGUIMIENTOS_CONFIG[pasoIndex];
    if (!pasoConfig) {
      await supabase.from("seguimientos_programados").update({ enviado: true }).eq("id", id);
      continue;
    }

    const rotacion = conv.rotacion || {};
    const indiceActual = rotacion[pasoIndex] || 0;
    const mensaje = pasoConfig.mensajes[indiceActual % pasoConfig.mensajes.length];
    rotacion[pasoIndex] = (indiceActual + 1) % pasoConfig.mensajes.length;

    try {
      console.log(`🔔 Enviando seguimiento (paso ${pasoIndex}, ${pasoConfig.horas} h) a ${senderId}: "${mensaje}"`);
      await enviarMensajeInstagram(senderId, mensaje);
      await agregarAlHistorialDB(senderId, "assistant", mensaje);
      await guardarConversacion(senderId, { rotacion });
      await supabase.from("seguimientos_programados").update({ enviado: true }).eq("id", id);
      procesados++;
    } catch (err) {
      console.error(`❌ Error enviando seguimiento a ${senderId}:`, err.response?.data || err.message);
      // No lo marcamos como enviado para reintentarlo en el siguiente ciclo del cron
    }
  }

  return { procesados };
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
  if (!signature || !APP_SECRET) return false;

  const expected = "sha256=" + crypto
    .createHmac("sha256", APP_SECRET)
    .update(req.rawBody)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
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

  const mensajesAResponder = buffer.mensajes;
  buffer.mensajes = [];
  buffer.enProceso = true;

  const mensajeCompleto = mensajesAResponder.join("\n");
  console.log(`📨 Mensaje agrupado de ${senderId}: "${mensajeCompleto}"`);

  const botActivo = await estaBotActivo();
  if (!botActivo) {
    console.log(`⏸️ Bot apagado: se ignora el mensaje de ${senderId} (no se genera ni envía respuesta).`);
    buffer.enProceso = false;
    if (buffer.mensajes.length > 0) {
      const delay = segundosAleatorios(MIN_DELAY_SECONDS, MAX_DELAY_SECONDS);
      buffer.timer = setTimeout(() => procesarBuffer(senderId), delay);
    } else {
      buffers.delete(senderId);
    }
    return;
  }

  try {
    const conv = await obtenerConversacion(senderId);
    const historial = conv.historial || [];

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

      await agregarAlHistorialDB(senderId, "user", mensajeCompleto);
      await agregarAlHistorialDB(senderId, "assistant", respuesta);

      await enviarMensajeInstagram(senderId, respuesta);

      console.log(`✅ Respondido a ${senderId} (una sola respuesta por ${mensajesAResponder.length} línea(s))`);
    }
  } catch (err) {
    console.error(`❌ Error al responder:`, err.response?.data || err.message);
  }

  buffer.enProceso = false;

  if (buffer.mensajes.length > 0) {
    const delay = segundosAleatorios(MIN_DELAY_SECONDS, MAX_DELAY_SECONDS);
    buffer.timer = setTimeout(() => procesarBuffer(senderId), delay);
  } else {
    buffers.delete(senderId);
    // Ya no hay más mensajes pendientes: a partir de aquí empieza a contar
    // el tiempo de inactividad para los seguimientos (persistidos en DB).
    await programarSeguimientosDB(senderId);
  }
}

function encolarMensaje(senderId, mensaje) {
  let buffer = buffers.get(senderId);

  if (!buffer) {
    buffer = { mensajes: [], timer: null, enProceso: false };
    buffers.set(senderId, buffer);
  }

  buffer.mensajes.push(mensaje);

  if (buffer.enProceso) return;

  if (buffer.timer) clearTimeout(buffer.timer);

  const delay = segundosAleatorios(MIN_DELAY_SECONDS, MAX_DELAY_SECONDS);
  buffer.timer = setTimeout(() => procesarBuffer(senderId), delay);
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

  for (const entry of body.entry || []) {
    const eventos = [];

    for (const change of entry.changes || []) {
      if (change.field === "messages" && change.value) {
        eventos.push(change.value);
      }
    }

    for (const event of entry.messaging || []) {
      eventos.push(event);
    }

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
      // desde este momento, y cancelamos cualquier seguimiento pendiente
      // (la conversación está activa de nuevo).
      await registrarMensajeUsuario(senderId);
      await cancelarSeguimientosPendientesDB(senderId);

      encolarMensaje(senderId, mensaje);
    }
  }
});

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Instagram AI Responder activo 🤖" });
});

// ---------------------------------------------------------------
// Endpoint de "cron": UptimeRobot le pega aquí cada 5-10 minutos.
// Esto cumple DOS funciones a la vez: mantiene el servidor despierto
// (evita que Render lo duerma) Y procesa los seguimientos pendientes.
// ---------------------------------------------------------------
app.get("/cron/seguimientos", async (req, res) => {
  try {
    const resultado = await procesarSeguimientosPendientesDB();
    res.json({ status: "ok", ...resultado, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error("❌ Error en /cron/seguimientos:", err.message);
    res.status(500).json({ status: "error", error: err.message });
  }
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
        <p>Procesamos el contenido de los mensajes directos recibidos, el identificador
        de Instagram del remitente, y el historial de la conversación (guardado en una
        base de datos para poder dar seguimiento y continuidad a la conversación),
        únicamente con el fin de generar y enviar respuestas automáticas relevantes.
        No compartimos esta información con terceros, salvo el envío del texto del
        mensaje al proveedor de IA (OpenAI) para generar la respuesta.</p>
        <h2>Uso de terceros</h2>
        <p>Utilizamos la API de OpenAI para generar las respuestas automáticas, y una
        base de datos (Supabase) para almacenar el historial de conversación de forma
        segura. Consulta las políticas de privacidad de cada proveedor para más
        información sobre cómo procesan los datos que reciben.</p>
        <h2>Contacto</h2>
        <p>Para dudas sobre esta política, contáctanos en: rperezro23@gmail.com</p>
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
        <p>Si deseas solicitar la eliminación de cualquier dato asociado a tu cuenta de
        Instagram que haya sido procesado por esta app (incluyendo el historial de
        conversación guardado), envía tu solicitud a: rperezro23@gmail.com, indicando tu
        nombre de usuario de Instagram. Procesaremos tu solicitud en un plazo máximo
        de 30 días.</p>
      </body>
    </html>
  `);
});

// --- ENDPOINTS DE DIAGNÓSTICO ---

app.get("/check-subscription", requireAdminKey, async (req, res) => {
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

app.get("/force-subscribe", requireAdminKey, async (req, res) => {
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

// Ver el historial y estado guardado en Supabase para un usuario (debug)
app.get("/historial/:senderId", requireAdminKey, async (req, res) => {
  const conv = await obtenerConversacion(req.params.senderId);
  res.json(conv);
});

// Intercambia el token actual (corto) por uno de larga duración (60 días).
// Úsalo UNA VEZ con tu token actual, copia el resultado y actualiza IG_ACCESS_TOKEN en Render.
app.get("/get-long-lived-token", requireAdminKey, async (req, res) => {
  try {
    const response = await axios.get("https://graph.instagram.com/access_token", {
      params: {
        grant_type: "ig_exchange_token",
        client_secret: APP_SECRET,
        access_token: IG_ACCESS_TOKEN
      }
    });
    await guardarFechaTokenDB(response.data.expires_in);
    res.json({
      mensaje: "Copia access_token y actualiza IG_ACCESS_TOKEN en Render. Ya quedó registrada la fecha para /token-info.",
      ...response.data,
      expira_en_dias: response.data.expires_in ? Math.round(response.data.expires_in / 86400) : null
    });
  } catch (err) {
    res.status(500).json(err.response?.data || { error: err.message });
  }
});

// Refresca un token de larga duración ANTES de que expire (debe tener al menos 24h de generado).
// Extiende la validez por 60 días más. Ejecútalo periódicamente (ej. cada 45-50 días).
app.get("/refresh-token", requireAdminKey, async (req, res) => {
  try {
    const response = await axios.get("https://graph.instagram.com/refresh_access_token", {
      params: {
        grant_type: "ig_refresh_token",
        access_token: IG_ACCESS_TOKEN
      }
    });
    await guardarFechaTokenDB(response.data.expires_in);
    res.json({
      mensaje: "Copia access_token y actualiza IG_ACCESS_TOKEN en Render. Ya quedó registrada la fecha para /token-info.",
      ...response.data,
      expira_en_dias: response.data.expires_in ? Math.round(response.data.expires_in / 86400) : null
    });
  } catch (err) {
    res.status(500).json(err.response?.data || { error: err.message });
  }
});

// ---------------------------------------------------------------
// Seguimiento de vencimiento del token (guardado nosotros mismos)
// ---------------------------------------------------------------
// Los tokens de "Instagram API con Instagram Login" (graph.instagram.com)
// NO se pueden consultar con graph.facebook.com/debug_token (da error 190,
// "Cannot get application info"): ese endpoint es solo para tokens de
// Facebook Login. Meta no ofrece un endpoint de consulta directa para este
// tipo de token, así que llevamos la cuenta nosotros: cada vez que se
// genera o refresca el token (60 días de duración), guardamos la fecha
// en Supabase, y calculamos desde ahí cuánto le queda.

// ---------------------------------------------------------------
// Interruptor de encendido/apagado del bot
// ---------------------------------------------------------------
// Reutiliza la misma tabla app_config (clave/valor) que ya usamos para
// la fecha del token. Mientras esté "off", el bot NO manda respuestas
// automáticas ni seguimientos, pero el webhook sigue vivo (no se rompe
// nada, solo se abstiene de contestar).

async function estaBotActivo() {
  const { data, error } = await supabase
    .from("app_config")
    .select("*")
    .eq("key", "bot_status")
    .maybeSingle();

  if (error) {
    console.error("❌ Error leyendo estado del bot, se asume ENCENDIDO por seguridad:", error.message);
    return true;
  }

  // Si nunca se ha tocado el interruptor, por defecto está encendido.
  if (!data) return true;

  return data.estado !== "off";
}

async function ponerEstadoBot(estado) {
  const ahoraISO = new Date().toISOString();
  const { error } = await supabase
    .from("app_config")
    .upsert({ key: "bot_status", estado, actualizado_en: ahoraISO });

  if (error) console.error("❌ Error guardando estado del bot:", error.message);
}

async function guardarFechaTokenDB(expiresInSeconds) {
  const ahoraISO = new Date().toISOString();
  const { error } = await supabase
    .from("app_config")
    .upsert({
      key: "ig_token",
      obtenido_en: ahoraISO,
      expira_en_segundos: expiresInSeconds || 5184000, // 60 días por defecto
      actualizado_en: ahoraISO
    });
  if (error) console.error("❌ Error guardando fecha del token en Supabase:", error.message);
}

async function obtenerInfoTokenDB() {
  const { data, error } = await supabase
    .from("app_config")
    .select("*")
    .eq("key", "ig_token")
    .maybeSingle();

  if (error) {
    console.error("❌ Error leyendo info del token de Supabase:", error.message);
    return null;
  }
  return data;
}

// Consulta cuánto tiempo de vida le queda al token actual, según la fecha
// que guardamos la última vez que se generó o refrescó (ver /get-long-lived-token
// y /refresh-token). Si nunca se ha usado ninguno de esos dos endpoints desde
// que existe esta función, no habrá dato guardado todavía.
app.get("/token-info", requireAdminKey, async (req, res) => {
  try {
    const info = await obtenerInfoTokenDB();

    if (!info) {
      return res.status(404).json({
        error: "Todavía no hay una fecha guardada para el token. " +
          "Corre /get-long-lived-token o /refresh-token una vez (con este código ya desplegado) " +
          "para que quede registrada, y después vuelve a consultar /token-info."
      });
    }

    const obtenidoEn = new Date(info.obtenido_en).getTime();
    const expiraEnMs = obtenidoEn + (info.expira_en_segundos * 1000);
    const diasRestantes = Math.round((expiraEnMs - Date.now()) / 86400000);

    res.json({
      obtenido_en: info.obtenido_en,
      expira_aproximadamente_en: new Date(expiraEnMs).toISOString(),
      dias_restantes: diasRestantes,
      estado: diasRestantes <= 10
        ? "⚠️ Quedan pocos días, corre /refresh-token pronto"
        : "✅ OK"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Consultar/cambiar el estado del bot (encendido/apagado)
app.get("/bot/estado", requireAdminKey, async (req, res) => {
  const activo = await estaBotActivo();
  res.json({ activo, estado: activo ? "on" : "off" });
});

app.get("/bot/encender", requireAdminKey, async (req, res) => {
  await ponerEstadoBot("on");
  res.json({ mensaje: "✅ Bot ENCENDIDO", estado: "on" });
});

app.get("/bot/apagar", requireAdminKey, async (req, res) => {
  await ponerEstadoBot("off");
  res.json({ mensaje: "⏸️ Bot APAGADO (no responderá mensajes ni mandará seguimientos)", estado: "off" });
});

// Página sencilla con dos botones para encender/apagar el bot sin tener
// que escribir URLs a mano. Pide la clave de admin una sola vez y la
// guarda en el navegador (localStorage) para no pedirla cada vez.
app.get("/panel", (req, res) => {
  res.type("html").send(`
    <html>
      <head>
        <title>Panel del Bot - Instagram AI Responder</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
      </head>
      <body style="font-family: sans-serif; max-width: 480px; margin: 60px auto; text-align: center; line-height: 1.6;">
        <h1>Panel del Bot</h1>
        <p id="estado" style="font-size: 20px; font-weight: bold;">Cargando estado...</p>
        <button id="btnOn" style="padding: 14px 28px; font-size: 16px; margin: 8px; background: #2ecc71; color: white; border: none; border-radius: 8px; cursor: pointer;">✅ Encender</button>
        <button id="btnOff" style="padding: 14px 28px; font-size: 16px; margin: 8px; background: #e74c3c; color: white; border: none; border-radius: 8px; cursor: pointer;">⏸️ Apagar</button>
        <p id="mensaje" style="color: #666; margin-top: 20px;"></p>

        <script>
          function getKey() {
            let key = localStorage.getItem("admin_key");
            if (!key) {
              key = prompt("Ingresa tu ADMIN_API_KEY:");
              if (key) localStorage.setItem("admin_key", key);
            }
            return key;
          }

          async function llamar(endpoint) {
            const key = getKey();
            if (!key) return;
            const res = await fetch(endpoint + "?key=" + encodeURIComponent(key));
            if (res.status === 401) {
              localStorage.removeItem("admin_key");
              alert("Clave incorrecta, intenta de nuevo.");
              return;
            }
            const data = await res.json();
            return data;
          }

          async function actualizarEstado() {
            const data = await llamar("/bot/estado");
            if (!data) return;
            document.getElementById("estado").textContent = data.activo ? "🟢 Bot ENCENDIDO" : "🔴 Bot APAGADO";
          }

          document.getElementById("btnOn").addEventListener("click", async () => {
            const data = await llamar("/bot/encender");
            if (data) document.getElementById("mensaje").textContent = data.mensaje;
            actualizarEstado();
          });

          document.getElementById("btnOff").addEventListener("click", async () => {
            const data = await llamar("/bot/apagar");
            if (data) document.getElementById("mensaje").textContent = data.mensaje;
            actualizarEstado();
          });

          actualizarEstado();
        </script>
      </body>
    </html>
  `);
});

// Ver los seguimientos programados/pendientes para un usuario (debug)
app.get("/seguimientos/:senderId?", requireAdminKey, async (req, res) => {
  if (!req.params.senderId) {
    return res.json({ configuracion: SEGUIMIENTOS_CONFIG });
  }
  const { data, error } = await supabase
    .from("seguimientos_programados")
    .select("*")
    .eq("sender_id", req.params.senderId)
    .order("disparar_en", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ configuracion: SEGUIMIENTOS_CONFIG, seguimientos: data });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
