const express = require("express");
const crypto  = require("crypto");
const axios   = require("axios");
const OpenAI  = require("openai");
const { toFile } = OpenAI;
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
ffmpeg.setFfmpegPath(require("@ffmpeg-installer/ffmpeg").path);

const app = express();

// Render está detrás de un proxy: sin esto, req.protocol siempre da "http"
// aunque el usuario haya entrado por https, lo cual rompe el redirect_uri
// que mandamos a Meta en el flujo de OAuth (Meta exige que coincida exacto).
app.set("trust proxy", true);

// Necesitamos el body "crudo" para poder verificar la firma que manda Meta.
// El límite se sube a 25mb porque los audios pregrabados se suben en base64
// dentro del body JSON (ver /audios/subir) y con el límite por defecto (100kb)
// cualquier audio real lo rechazaría.
app.use(express.json({
  limit: "25mb",
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const APP_SECRET      = process.env.APP_SECRET;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const AI_PROMPT       = process.env.AI_PROMPT || "Eres el asistente de Roberto, entrenador fitness. Responde de forma amigable y breve en español.";
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN; // Instagram User Access Token (Instagram Login) — legado, ver "cuenta conectada" en Supabase
const IG_ACCOUNT_ID   = process.env.IG_ACCOUNT_ID;   // tu <IG_ID> — legado, ver "cuenta conectada" en Supabase
const IG_APP_ID        = process.env.IG_APP_ID;       // ID de "Instagram API with Instagram Login" (Instagram Business Login) — NO es el App ID general de Meta

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Clave para proteger los endpoints de diagnóstico/admin (historial, seguimientos, etc.)
// Genera una clave larga y aleatoria y ponla en Render como ADMIN_API_KEY.
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

// ---------------------------------------------------------------
// Sesión de admin vía cookie (para que /panel y /cuentas puedan
// verificar el acceso ANTES de mandar cualquier HTML al navegador,
// en vez de mostrar el diseño completo y luego pedir la clave con
// un prompt() que se puede cancelar dejando el diseño visible).
// No usamos cookie-parser para no agregar una dependencia nueva:
// se parsea el header Cookie a mano.
// ---------------------------------------------------------------

const COOKIE_NOMBRE   = "admin_session";
const COOKIE_MAX_AGE  = 60 * 60 * 24 * 30; // 30 días, en segundos

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return header.split(";").reduce((acc, parte) => {
    const idx = parte.indexOf("=");
    if (idx === -1) return acc;
    const k = parte.slice(0, idx).trim();
    const v = decodeURIComponent(parte.slice(idx + 1).trim());
    acc[k] = v;
    return acc;
  }, {});
}

function ponerCookieSesion(res, req) {
  const seguro = req.protocol === "https" ? " Secure;" : "";
  res.setHeader("Set-Cookie",
    `${COOKIE_NOMBRE}=${encodeURIComponent(ADMIN_API_KEY)}; HttpOnly;${seguro} SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}; Path=/`
  );
}

function borrarCookieSesion(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NOMBRE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`);
}

function requireAdminKey(req, res, next) {
  const key = req.get("x-admin-key") || req.query.key || parseCookies(req)[COOKIE_NOMBRE];
  if (!ADMIN_API_KEY || key !== ADMIN_API_KEY) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

// Protege páginas completas (no endpoints JSON): si no hay sesión válida,
// redirige a /login ANTES de renderizar nada del diseño del panel.
function requireAdminSesion(req, res, next) {
  const key = parseCookies(req)[COOKIE_NOMBRE];
  if (!ADMIN_API_KEY || key !== ADMIN_API_KEY) {
    return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
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

// Seguimientos especiales para cuando ya se envió el enlace de calificación
// (calendario / formulario). Por defecto está vacío: el admin lo configura
// desde /panel una vez que sepa qué mensaje quiere mandar.
const SEGUIMIENTOS_ENLACE_DEFAULT = [
  {
    horas: 4,
    mensajes: [
      "Ey, ¿cómo vas? ¿Pudiste encontrar un espacio que te quede bien? 😊",
      "Oye, ¿alcanzaste a agendar? Cualquier duda con el enlace, aquí ando 🙌"
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

// El cliente de OpenAI se crea más abajo, después de cargar la configuración
// (así puede usar la clave guardada en Supabase en vez de solo la de Render).

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
    return { sender_id: senderId, historial: [], rotacion: {}, ultimo_mensaje_usuario: null, califica: false, calificado_en: null, razon_calificacion: null, no_califica: false, no_califica_en: null, razon_no_califica: null, agendo: false, agendo_en: null, enlace_enviado: false, enlace_enviado_en: null, enlace_pasos_enviados: 0, etapa: null, visto_hasta: null, ultimo_mensaje_bot_en: null, etiquetas: [], monto_pagado: 0, primer_mensaje_en: null, bot_pausado: false, resumen_lead: null, resumen_lead_generado_en: null, primer_mensaje_texto: null };
  }

  if (!data) {
    return { sender_id: senderId, historial: [], rotacion: {}, ultimo_mensaje_usuario: null, califica: false, calificado_en: null, razon_calificacion: null, no_califica: false, no_califica_en: null, razon_no_califica: null, agendo: false, agendo_en: null, enlace_enviado: false, enlace_enviado_en: null, enlace_pasos_enviados: 0, etapa: null, visto_hasta: null, ultimo_mensaje_bot_en: null, etiquetas: [], monto_pagado: 0, primer_mensaje_en: null, bot_pausado: false, resumen_lead: null, resumen_lead_generado_en: null, primer_mensaje_texto: null };
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
  while (historial.length > configActual.max_historial) historial.shift();

  const campos = { historial };
  // Se registra el momento exacto en que se mandó el último mensaje DEL BOT
  // (no del cliente) — sirve para los seguimientos con "solo si está visto":
  // se compara contra la marca de "leído" (visto_hasta) que manda Instagram,
  // para saber si el cliente ya vio ESE mensaje en particular antes de
  // mandarle el siguiente seguimiento.
  if (role === "assistant") campos.ultimo_mensaje_bot_en = new Date().toISOString();

  await guardarConversacion(senderId, campos);

  // "historial" (arriba) se recorta a propósito para no inflar el costo de
  // cada respuesta de la IA — pero eso significa que los mensajes viejos se
  // pierden de ahí para siempre. Para que /chats pueda mostrar la
  // conversación COMPLETA con scroll hacia atrás, cada mensaje se guarda
  // ADEMÁS en esta tabla aparte, sin ningún límite.
  await guardarMensajeChatCompleto(senderId, role, content);

  return historial;
}

// Guarda un mensaje en el registro completo (sin recorte) usado por /chats
// para el scroll hacia atrás. Es un registro puramente de lectura para el
// panel — nunca se usa como contexto de la IA (eso sigue siendo "historial").
async function guardarMensajeChatCompleto(senderId, role, content) {
  const { error } = await supabase
    .from("mensajes_chat")
    .insert({ sender_id: senderId, role, content, creado_en: new Date().toISOString() });
  if (error) console.error("❌ Error guardando mensaje en mensajes_chat:", error.message);
}

async function registrarMensajeUsuario(senderId, textoMensaje) {
  const campos = { ultimo_mensaje_usuario: new Date().toISOString() };

  // "primer_mensaje_en" y "primer_mensaje_texto" se guardan UNA SOLA VEZ —
  // la primera vez que este sender_id le escribe al bot. La fecha sirve
  // para poder filtrar el dashboard por periodo/mes de forma correcta. El
  // TEXTO sirve para que cualquier etapa (ej. "no califica", que necesita
  // saber qué lead magnet pidió al inicio) pueda referirse a él de forma
  // confiable, sin depender de que ese mensaje siga estando en el
  // historial reciente — en una conversación larga que pasó por varias
  // etapas, el primer mensaje casi seguro ya se recortó del historial que
  // ve la IA en ese momento (por el límite de mensajes que se mantienen).
  const conv = await obtenerConversacion(senderId);
  if (!conv.primer_mensaje_en) campos.primer_mensaje_en = campos.ultimo_mensaje_usuario;
  if (!conv.primer_mensaje_texto && textoMensaje) campos.primer_mensaje_texto = textoMensaje;

  await guardarConversacion(senderId, campos);
}

async function cancelarSeguimientosPendientesDB(senderId) {
  const { error } = await supabase
    .from("seguimientos_programados")
    .delete()
    .eq("sender_id", senderId)
    .eq("enviado", false);

  if (error) console.error("❌ Error cancelando seguimientos en Supabase:", error.message);
}

// Programa el siguiente seguimiento automático para un usuario. Mientras el
// lead tenga la etiqueta "enlace_enviado" y todavía no se le hayan mandado
// TODOS los pasos configurados en "seguimientos_enlace", se sigue usando esa
// lista especial — incluso si el lead responde algo como "gracias" en el
// medio (eso NO cancela el modo enlace, solo cancela el mensaje puntual que
// estaba pendiente y este método lo vuelve a programar). Recién cuando ya se
// mandaron todos los pasos del enlace, se pasa a usar los "seguimientos"
// normales. La ventana límite de 24h de Instagram se calcula siempre a
// partir del último mensaje del usuario (así lo exige Meta), pero las horas
// de espera de los pasos del enlace se cuentan desde que se envió el enlace.
async function programarSeguimientosDB(senderId) {
  await cancelarSeguimientosPendientesDB(senderId);

  const conv = await obtenerConversacion(senderId);
  if (!conv.ultimo_mensaje_usuario) return;

  const ultimoMsg = new Date(conv.ultimo_mensaje_usuario).getTime();
  const limiteVentana = ultimoMsg + VENTANA_24H_MS - COLCHON_SEGURIDAD_MS;

  const pasosEnlaceConfig = configActual.seguimientos_enlace || [];
  const pasosEnlaceYaEnviados = conv.enlace_pasos_enviados || 0;
  const esSeguimientoEnlace = Boolean(conv.enlace_enviado) && pasosEnlaceYaEnviados < pasosEnlaceConfig.length;

  const pasos = esSeguimientoEnlace ? pasosEnlaceConfig : (configActual.seguimientos || []);
  const tipo = esSeguimientoEnlace ? "enlace" : "normal";
  const referencia = (esSeguimientoEnlace && conv.enlace_enviado_en)
    ? new Date(conv.enlace_enviado_en).getTime()
    : ultimoMsg;

  const filas = [];
  for (let i = 0; i < pasos.length; i++) {
    if (esSeguimientoEnlace && i < pasosEnlaceYaEnviados) continue; // ese paso ya se mandó antes

    const { horas, mensajes } = pasos[i];
    if (!Array.isArray(mensajes) || mensajes.length === 0) continue;

    const momentoDisparo = referencia + horas * 60 * 60 * 1000;
    if (momentoDisparo > limiteVentana) continue; // se saldría de la ventana de 24h
    if (momentoDisparo <= Date.now()) continue;    // ya pasó ese punto

    filas.push({
      sender_id: senderId,
      paso_index: i,
      tipo,
      disparar_en: new Date(momentoDisparo).toISOString(),
      enviado: false
    });
  }

  if (filas.length === 0) return;

  const { error } = await supabase.from("seguimientos_programados").insert(filas);
  if (error) console.error("❌ Error programando seguimientos en Supabase:", error.message);
}

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
    const { id, sender_id: senderId, paso_index: pasoIndex, tipo } = fila;
    const esEnlace = tipo === "enlace";

    const conv = await obtenerConversacion(senderId);
    const ultimoMsg = conv.ultimo_mensaje_usuario ? new Date(conv.ultimo_mensaje_usuario).getTime() : 0;
    const sigueVigente = Date.now() <= (ultimoMsg + VENTANA_24H_MS - COLCHON_SEGURIDAD_MS);

    if (!sigueVigente) {
      console.log(`⏭️ Seguimiento (${tipo}, paso ${pasoIndex}) para ${senderId} descartado: fuera de la ventana de 24h.`);
      await supabase.from("seguimientos_programados").update({ enviado: true }).eq("id", id);
      continue;
    }

    // Si el lead quedó marcado como "NO CALIFICA" (ej. dijo tener menos de 40
    // años, o que quiere subir de peso en vez de bajar) y tienes activada la
    // opción de no seguirle insistiendo a esos leads, este seguimiento se
    // descarta por completo — no tiene sentido invertir en re-enganchar a
    // alguien que ya se auto-descartó con un criterio duro.
    if (configActual.no_seguir_si_no_califica && conv.no_califica) {
      console.log(`🚫 Seguimiento (${tipo}, paso ${pasoIndex}) para ${senderId} descartado: el lead está marcado como "no califica".`);
      await supabase.from("seguimientos_programados").update({ enviado: true }).eq("id", id);
      continue;
    }

    // Si el lead ya CONFIRMÓ que agendó (etiqueta "agendo", distinta de solo
    // haber recibido el enlace) y tienes activada la opción de no seguirle
    // insistiendo, se descarta CUALQUIER seguimiento — tanto los normales
    // como los especiales del enlace — porque ya logró lo que se buscaba.
    if (configActual.parar_seguimientos_si_agendo && conv.agendo) {
      console.log(`📅 Seguimiento (${tipo}, paso ${pasoIndex}) para ${senderId} descartado: el lead ya confirmó que agendó.`);
      await supabase.from("seguimientos_programados").update({ enviado: true }).eq("id", id);
      continue;
    }

    const listaPasos = esEnlace ? configActual.seguimientos_enlace : configActual.seguimientos;
    const pasoConfig = listaPasos ? listaPasos[pasoIndex] : null;
    if (!pasoConfig) {
      await supabase.from("seguimientos_programados").update({ enviado: true }).eq("id", id);
      continue;
    }

    // "Solo enviar si está visto": este paso no se manda hasta que el
    // cliente haya leído el ÚLTIMO mensaje que le mandó el bot (comparando
    // la marca de "leído" que manda Instagram contra la fecha del último
    // mensaje del bot). Si todavía no lo vio, NO se marca como enviado —
    // se deja pendiente para que el próximo cron lo vuelva a revisar (la
    // ventana de 24h de arriba sigue aplicando como límite natural).
    if (pasoConfig.solo_si_visto) {
      const vistoHasta = conv.visto_hasta ? new Date(conv.visto_hasta).getTime() : 0;
      const ultimoMensajeBot = conv.ultimo_mensaje_bot_en ? new Date(conv.ultimo_mensaje_bot_en).getTime() : 0;
      const yaVisto = ultimoMensajeBot > 0 && vistoHasta >= ultimoMensajeBot;

      if (!yaVisto) {
        console.log(`👁️ Seguimiento (${tipo}, paso ${pasoIndex}) para ${senderId} en espera: el cliente todavía no ha visto el mensaje anterior.`);
        continue;
      }
    }

    // Franja horaria permitida: si un seguimiento le tocaría a las 3am (ej.
    // porque el cliente escribió de madrugada y el paso está programado a
    // pocas horas después), no tiene sentido mandarlo mientras está
    // dormido — se espera a que la hora actual (en la zona horaria de
    // México) caiga dentro del rango configurado. NO se marca como
    // enviado — se queda pendiente para que el próximo cron lo revise de
    // nuevo, y se manda en cuanto se entra a la franja permitida (no
    // espera a que llegue exactamente la MISMA hora al día siguiente).
    if (configActual.franja_horaria_activa) {
      const horaActualMexico = new Date().toLocaleTimeString("en-GB", {
        timeZone: "America/Mexico_City", hour: "2-digit", minute: "2-digit", hour12: false
      }); // "HH:MM"
      const [horaDesde, minDesde] = (configActual.franja_horaria_desde || "08:00").split(":").map(Number);
      const [horaHasta, minHasta] = (configActual.franja_horaria_hasta || "23:00").split(":").map(Number);
      const [horaActual, minActual] = horaActualMexico.split(":").map(Number);

      const minutosDesde = horaDesde * 60 + minDesde;
      const minutosHasta = horaHasta * 60 + minHasta;
      const minutosActual = horaActual * 60 + minActual;

      const dentroDeFranja = minutosDesde <= minutosHasta
        ? (minutosActual >= minutosDesde && minutosActual <= minutosHasta) // franja normal, ej. 08:00-23:00
        : (minutosActual >= minutosDesde || minutosActual <= minutosHasta); // franja que cruza medianoche, ej. 22:00-06:00

      if (!dentroDeFranja) {
        console.log(`🌙 Seguimiento (${tipo}, paso ${pasoIndex}) para ${senderId} en espera: son las ${horaActualMexico} en México, fuera de la franja permitida (${configActual.franja_horaria_desde}-${configActual.franja_horaria_hasta}).`);
        continue;
      }
    }

    // Se namespacea la clave de rotación por tipo, para que el paso 0 normal
    // y el paso 0 del enlace no compartan el mismo contador de rotación.
    const claveRotacion = `${tipo}_${pasoIndex}`;
    const rotacion = conv.rotacion || {};
    const indiceActual = rotacion[claveRotacion] || 0;
    const mensaje = pasoConfig.mensajes[indiceActual % pasoConfig.mensajes.length];
    rotacion[claveRotacion] = (indiceActual + 1) % pasoConfig.mensajes.length;

    try {
      console.log(`🔔 Enviando seguimiento (${tipo}, paso ${pasoIndex}, ${pasoConfig.horas} h) a ${senderId}: "${mensaje}"`);
      await enviarContenidoConMarcadores(senderId, mensaje);

      const camposAGuardar = { rotacion };
      if (esEnlace) {
        // Avanza el contador de pasos del enlace ya enviados, para que
        // programarSeguimientosDB sepa cuáles faltan y cuándo ya se mandaron
        // todos (momento en el que se vuelve al seguimiento normal).
        const yaEnviados = conv.enlace_pasos_enviados || 0;
        camposAGuardar.enlace_pasos_enviados = Math.max(yaEnviados, pasoIndex + 1);
      }
      await guardarConversacion(senderId, camposAGuardar);

      await supabase.from("seguimientos_programados").update({ enviado: true }).eq("id", id);
      procesados++;
    } catch (err) {
      console.error(`❌ Error enviando seguimiento a ${senderId}:`, err.response?.data || err.message);
    }
  }

  return { procesados };
}

// ---------------------------------------------------------------
// Cuenta de Instagram conectada (guardada en Supabase, tabla app_config,
// key "ig_cuenta_conectada"). Reemplaza las variables de entorno fijas
// IG_ACCESS_TOKEN / IG_ACCOUNT_ID, para poder conectar/desconectar cuentas
// desde el panel sin tocar Render. Por ahora solo se soporta 1 cuenta activa
// a la vez (conectar una nueva sobrescribe a la anterior).
// ---------------------------------------------------------------

async function obtenerCuentaActiva() {
  const { data, error } = await supabase
    .from("app_config")
    .select("*")
    .eq("key", "ig_cuenta_conectada")
    .maybeSingle();

  if (error) {
    console.error("❌ Error leyendo cuenta conectada de Supabase:", error.message);
  }

  if (data && data.valor && data.valor.access_token) {
    return data.valor;
  }

  // Fallback de compatibilidad: si nunca se ha conectado nada desde el
  // panel nuevo, se sigue usando lo que haya en las variables de entorno.
  if (IG_ACCESS_TOKEN && IG_ACCOUNT_ID) {
    return {
      ig_id: IG_ACCOUNT_ID,
      access_token: IG_ACCESS_TOKEN,
      username: null,
      account_type: null,
      metodo: "env_legacy",
      conectada_en: null
    };
  }

  return null;
}

async function guardarCuentaConectada(cuenta) {
  const { error } = await supabase
    .from("app_config")
    .upsert({ key: "ig_cuenta_conectada", valor: cuenta, actualizado_en: new Date().toISOString() });

  if (error) console.error("❌ Error guardando cuenta conectada en Supabase:", error.message);
}

async function eliminarCuentaConectada() {
  const { error } = await supabase
    .from("app_config")
    .delete()
    .eq("key", "ig_cuenta_conectada");

  if (error) console.error("❌ Error eliminando cuenta conectada en Supabase:", error.message);
}

// ---------------------------------------------------------------
// Conexión con Calendly: se usa para saber, con certeza real (no solo
// porque el lead lo dijo), si alguien ya agendó su llamada. Funciona con
// un webhook — Calendly avisa automáticamente en el instante en que
// alguien reserva, y esa reserva se hace coincidir con la conversación
// correcta usando la respuesta a una pregunta personalizada del formulario
// de Calendly ("¿cuál es tu usuario de Instagram?").
// ---------------------------------------------------------------

function calendlyHeaders() {
  return { Authorization: `Bearer ${configActual.calendly_token}`, "Content-Type": "application/json" };
}

// Obtiene la URI de la organización de Calendly del dueño del token — hace
// falta para poder crear la suscripción del webhook con alcance "organization".
async function obtenerUsuarioCalendly() {
  const resp = await axios.get("https://api.calendly.com/users/me", { headers: calendlyHeaders() });
  return resp.data?.resource; // { uri, current_organization, name, email, ... }
}

// Crea (o reemplaza) la suscripción del webhook en Calendly, apuntando al
// endpoint de este servidor. Se llama una sola vez, desde el botón
// "Conectar Calendly" en /panel — no hace falta repetirlo salvo que se
// quiera reconectar.
async function crearWebhookCalendly(urlCallback) {
  const usuario = await obtenerUsuarioCalendly();
  if (!usuario?.current_organization) {
    throw new Error("No se pudo obtener la organización de Calendly con ese token.");
  }

  const resp = await axios.post(
    "https://api.calendly.com/webhook_subscriptions",
    {
      url: urlCallback,
      events: ["invitee.created"],
      organization: usuario.current_organization,
      scope: "organization"
    },
    { headers: calendlyHeaders() }
  );

  return { webhookUri: resp.data?.resource?.uri, organizationUri: usuario.current_organization };
}

// Busca en Supabase qué conversación corresponde a un usuario de Instagram
// (comparando sin mayúsculas ni "@" de más), para poder marcarla como
// "agendó" cuando llega el aviso de Calendly.
async function buscarSenderIdPorUsername(username) {
  const limpio = (username || "").trim().replace(/^@/, "").toLowerCase();
  if (!limpio) return null;

  const { data, error } = await supabase
    .from("conversaciones")
    .select("sender_id")
    .ilike("username", limpio)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("❌ Error buscando conversación por username para Calendly:", error.message);
    return null;
  }
  return data?.sender_id || null;
}

// Cachea la URI de la organización de Calendly (no cambia nunca para una
// misma cuenta) para no pedirla de nuevo en cada verificación.
let calendlyOrgUriCache = null;

// Verifica EN VIVO, consultando directamente la API de Calendly (endpoints
// de solo lectura — funcionan en el plan gratuito, no hace falta el plan de
// pago que sí exigen los webhooks), si un username de Instagram tiene una
// reserva activa agendada. Se usa en el momento exacto en que un lead dice
// "ya agendé" — no antes (no hay por qué gastar llamadas revisando a nadie
// que no lo haya dicho) ni con webhooks (que costarían el plan Standard).
async function verificarReservaEnCalendly(username) {
  const limpio = (username || "").trim().replace(/^@/, "").toLowerCase();
  if (!limpio || !configActual.calendly_token?.trim() || !configActual.calendly_pregunta_instagram?.trim()) {
    return { encontrado: false, motivo: "Calendly no está configurado (falta token, pregunta, o el lead no tiene username)." };
  }

  try {
    if (!calendlyOrgUriCache) {
      const usuario = await obtenerUsuarioCalendly();
      calendlyOrgUriCache = usuario?.current_organization || null;
    }
    if (!calendlyOrgUriCache) return { encontrado: false, motivo: "No se pudo obtener la organización de Calendly." };

    const ahora = new Date();
    const en90dias = new Date(ahora.getTime() + 90 * 24 * 60 * 60 * 1000);

    const respEventos = await axios.get("https://api.calendly.com/scheduled_events", {
      headers: calendlyHeaders(),
      params: {
        organization: calendlyOrgUriCache,
        status: "active",
        min_start_time: ahora.toISOString(),
        max_start_time: en90dias.toISOString(),
        count: 100
      }
    });

    const eventos = respEventos.data?.collection || [];

    for (const evento of eventos) {
      const respInvitados = await axios.get(`${evento.uri}/invitees`, { headers: calendlyHeaders() });
      const invitados = respInvitados.data?.collection || [];

      for (const invitado of invitados) {
        const preguntasYRespuestas = invitado.questions_and_answers || [];
        const encontrada = preguntasYRespuestas.find(qa => qa.question?.trim() === configActual.calendly_pregunta_instagram.trim());
        const respuestaUsername = (encontrada?.answer || "").trim().replace(/^@/, "").toLowerCase();

        if (respuestaUsername && respuestaUsername === limpio) {
          // Calendly detecta y guarda la zona horaria del propio invitado
          // al momento de reservar (ej. "America/New_York") — se usa para
          // poder decirle la hora de su llamada en SU hora, no en la de
          // Roberto, sin tener que preguntársela ni adivinarla.
          return { encontrado: true, event: evento, timezoneInvitado: invitado.timezone || null };
        }
      }
    }

    return { encontrado: false, motivo: "No se encontró ninguna reserva activa con ese usuario de Instagram." };
  } catch (err) {
    console.error("❌ Error verificando reserva en Calendly:", err.response?.data || err.message);
    return { encontrado: false, motivo: "Error consultando Calendly: " + (err.response?.data?.message || err.message) };
  }
}

// ---------------------------------------------------------------
// Perfil (username + foto) de cada persona que escribe por Instagram.
// Se cachea en memoria para no pedirle su perfil a Meta en cada refresco
// del chat en vivo (la pantalla de /chats hace polling cada pocos segundos).
// ---------------------------------------------------------------
const perfilesCache = new Map(); // senderId -> { username, profile_pic, name, obtenido_en }
const PERFIL_CACHE_MS = 60 * 60 * 1000; // 1 hora

async function obtenerPerfilInstagram(senderId) {
  const cacheado = perfilesCache.get(senderId);
  if (cacheado && (Date.now() - cacheado.obtenido_en) < PERFIL_CACHE_MS) {
    return cacheado;
  }

  try {
    const cuenta = await obtenerCuentaActiva();
    if (!cuenta) return cacheado || null;

    const resp = await axios.get(`https://graph.instagram.com/v25.0/${senderId}`, {
      params: { fields: "name,username,profile_pic" },
      headers: { "Authorization": `Bearer ${cuenta.access_token}` }
    });

    const perfil = {
      username: resp.data.username || null,
      profile_pic: resp.data.profile_pic || null,
      name: resp.data.name || null,
      obtenido_en: Date.now()
    };
    perfilesCache.set(senderId, perfil);

    // Se guarda también en Supabase (no solo en la caché en memoria, que se
    // pierde si el servidor reinicia) — sirve para poder buscar una
    // conversación POR SU username más adelante, ej. al hacer coincidir una
    // reserva de Calendly con el lead correcto. No se espera (fire-and-forget)
    // para no atrasar la respuesta de este endpoint, que se llama seguido.
    if (perfil.username) {
      guardarConversacion(senderId, { username: perfil.username }).catch(() => {});
    }

    return perfil;
  } catch (err) {
    console.error(`⚠️ No se pudo obtener el perfil de ${senderId}:`, err.response?.data || err.message);
    return cacheado || null;
  }
}

// "state" de OAuth: valor aleatorio de un solo uso para evitar que alguien
// dispare el callback de conexión sin haber pasado por /oauth/instagram/start.
// Alcanza con memoria (vive pocos minutos, mientras el usuario hace login en Meta).
const oauthEstados = new Map(); // state -> timestamp de creación

function generarOauthState() {
  const state = crypto.randomBytes(16).toString("hex");
  oauthEstados.set(state, Date.now());
  for (const [s, creadoEn] of oauthEstados) {
    if (Date.now() - creadoEn > 10 * 60 * 1000) oauthEstados.delete(s); // limpieza, 10 min de vida
  }
  return state;
}

function validarOauthState(state) {
  if (!state || !oauthEstados.has(state)) return false;
  oauthEstados.delete(state);
  return true;
}

// ---------------------------------------------------------------
// Diseño compartido (estilo "dashboard de monitoreo") para /panel,
// /cuentas, /privacy y /data-deletion — mismo lenguaje visual en
// las 4 páginas. Layout centrado dentro del área de contenido
// (sidebar fija a la izquierda + contenido centrado a la derecha).
// ---------------------------------------------------------------

const FUENTES_HTML = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
`;

function estilosBase() {
  return `
<style>
  :root{
    --bg:#0A0D13; --surface:#10141C; --surface-2:#161B25; --surface-3:#1D2330;
    --border:#232A38; --text:#EDF0F4; --muted:#7C879B; --muted-dim:#4B5568;
    --green:#31D97C; --green-soft:rgba(49,217,124,.14);
    --red:#FF5D5D; --red-soft:rgba(255,93,93,.14);
    --radius:12px; --radius-lg:18px;
    --mono:'JetBrains Mono',monospace; --display:'Space Grotesk',sans-serif; --body:'Inter',sans-serif;
  }
  *{ box-sizing:border-box; }
  html{ font-size:17px; }
  body{ margin:0; background:var(--bg); color:var(--text); font-family:var(--body); }
  a{ color:var(--green); }

  /* --- Layout general: sidebar fija + contenido centrado --- */
  .app-shell{ display:flex; min-height:100vh; }

  /* --- Sidebar --- */
  .sidebar{
    position:fixed; top:0; left:0; bottom:0; width:236px; background:var(--surface);
    border-right:1px solid var(--border); padding:26px 18px; display:flex;
    flex-direction:column; gap:30px; z-index:10;
  }
  .brand{ display:flex; align-items:center; gap:10px; padding:0 4px; }
  .brand-dot{ width:10px; height:10px; border-radius:50%; background:var(--green); flex-shrink:0;
    box-shadow:0 0 0 0 rgba(49,217,124,.5); animation:pulse 2.2s ease-out infinite; }
  .brand-name{ font-family:var(--display); font-weight:600; font-size:16.5px; letter-spacing:.005em; }
  nav.side-nav{ display:flex; flex-direction:column; gap:4px; }
  .side-link{
    display:flex; align-items:center; justify-content:space-between; gap:10px;
    padding:11px 12px; border-radius:10px; color:var(--muted); text-decoration:none;
    font-size:15.5px; font-weight:500; transition:background .15s, color .15s;
  }
  .side-link:hover{ background:var(--surface-2); color:var(--text); }
  .side-link.active{ background:var(--green-soft); color:var(--green); }
  .side-tag{
    font-family:var(--mono); font-size:10.5px; padding:3px 7px; border-radius:5px;
    background:var(--surface-3); color:var(--muted-dim); letter-spacing:.04em;
  }
  .side-link.active .side-tag{ background:rgba(49,217,124,.18); color:var(--green); }
  .sidebar-footer{ margin-top:auto; font-family:var(--mono); font-size:11px; color:var(--muted-dim);
    letter-spacing:.03em; padding:0 4px; line-height:1.6; }

  /* El área a la derecha de la sidebar centra el bloque de contenido
     (mismo margen izquierdo y derecho dentro del espacio disponible) */
  .content-area{
    margin-left:236px; flex:1; display:flex; justify-content:center;
    padding:44px 46px 100px;
  }
  .main{ width:100%; max-width:1360px; }

  @media (max-width:860px){
    .app-shell{ display:block; }
    .sidebar{ position:static; width:100%; flex-direction:row; align-items:center;
      padding:15px 18px; border-right:none; border-bottom:1px solid var(--border);
      overflow-x:auto; gap:20px; }
    .sidebar-footer{ display:none; }
    nav.side-nav{ flex-direction:row; }
    .content-area{ margin-left:0; padding:26px 18px 100px; justify-content:center; }
    .main{ max-width:none; }
  }

  @keyframes pulse{
    0%{ box-shadow:0 0 0 0 rgba(49,217,124,.5); }
    70%{ box-shadow:0 0 0 8px rgba(49,217,124,0); }
    100%{ box-shadow:0 0 0 0 rgba(49,217,124,0); }
  }

  /* --- Encabezado de página --- */
  .page-header{
    display:flex; align-items:flex-start; justify-content:space-between;
    gap:24px; flex-wrap:wrap; margin-bottom:14px;
  }
  .page-header-left{ flex:1; min-width:280px; }
  .page-eyebrow{ font-family:var(--mono); font-size:12.5px; letter-spacing:.14em;
    text-transform:uppercase; color:#3FC7E8; margin:0 0 10px; }
  .page-title{ font-family:var(--display); font-weight:700; font-size:38px; margin:0;
    letter-spacing:.005em; line-height:1.12; }
  .page-sub{ color:var(--muted); font-size:15.5px; line-height:1.65; margin:16px 0 30px; max-width:680px; }

  /* --- Botón hero (conectar cuenta) --- */
  .btn-hero{
    font-family:var(--display); font-weight:600; font-size:15px; white-space:nowrap;
    border:none; border-radius:11px; padding:15px 22px; cursor:pointer; color:#04140D;
    background:linear-gradient(90deg, #31D97C, #34C9E8);
    box-shadow:0 0 0 1px rgba(49,217,124,.15), 0 8px 24px -8px rgba(49,217,124,.55);
    transition:filter .15s, transform .1s; flex-shrink:0;
  }
  .btn-hero:hover{ filter:brightness(1.06); }
  .btn-hero:active{ transform:scale(.985); }

  /* --- Cluster de estado del bot en el encabezado del panel --- */
  .header-status{ display:flex; align-items:center; gap:14px; flex-wrap:wrap; flex-shrink:0; }
  .header-status-text{ text-align:right; }
  .header-status-label{ font-size:12.5px; color:var(--muted); margin-bottom:4px; }
  .header-status-value{ font-family:var(--display); font-weight:600; font-size:19px;
    display:flex; align-items:center; gap:8px; justify-content:flex-end; }
  .header-status-value.green{ color:var(--green); }
  .header-status-value.red{ color:var(--red); }
  @media (max-width:640px){
    .header-status{ width:100%; justify-content:space-between; }
    .header-status-text{ text-align:left; }
    .header-status-value{ justify-content:flex-start; }
  }

  /* --- Grid de 2 columnas (usado en /panel) --- */
  .grid-2col{ display:grid; grid-template-columns:1fr 1fr; gap:18px; align-items:start; }
  @media (max-width:980px){ .grid-2col{ grid-template-columns:1fr; } }
  .col{ display:flex; flex-direction:column; }

  /* --- Tarjetas de estadística (estilo monitoreo) --- */
  .stats-row{ display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin-bottom:26px; }
  @media (max-width:700px){ .stats-row{ grid-template-columns:1fr; } }
  .stat-card{ background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg); padding:19px 20px; }
  .stat-label{ font-size:13px; color:var(--muted); margin-bottom:10px; font-weight:500; }
  .stat-value{ font-family:var(--display); font-size:22px; font-weight:600; display:flex; align-items:center; gap:9px; }
  .stat-value.green{ color:var(--green); }
  .stat-value.red{ color:var(--red); }
  .status-dot{ width:9px; height:9px; border-radius:50%; background:var(--green); flex-shrink:0;
    box-shadow:0 0 0 0 rgba(49,217,124,.5); animation:pulse 1.8s ease-out infinite; }
  .status-dot.off{ background:var(--red); animation:none; box-shadow:none; }
  .stat-note{ font-size:12.5px; color:var(--muted-dim); margin-top:8px; font-family:var(--mono); }

  /* --- Tarjetas de contenido genéricas --- */
  .card{ background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg); padding:24px 26px; margin-bottom:16px; }
  .card h2{ font-family:var(--display); font-size:18px; font-weight:600; margin:0 0 5px; }
  .card .hint{ color:var(--muted); font-size:14px; margin:0 0 16px; line-height:1.6; }
  .card p{ color:#C9D1DE; font-size:16px; line-height:1.75; margin:0 0 7px; }
  .card p:last-child{ margin-bottom:0; }

  /* --- Bloques de ayuda colapsables (details/summary nativo) --- */
  details.ayuda{ margin:0 0 16px; }
  details.ayuda summary{
    cursor:pointer; list-style:none; color:#3FC7E8; font-size:13.5px; font-weight:600;
    display:flex; align-items:center; gap:6px; user-select:none; padding:2px 0;
  }
  details.ayuda summary::-webkit-details-marker{ display:none; }
  details.ayuda summary::before{
    content:"▸"; display:inline-block; font-size:11px; color:#3FC7E8;
    transition:transform .15s; flex-shrink:0;
  }
  details.ayuda[open] summary::before{ transform:rotate(90deg); }
  details.ayuda summary:hover{ color:#6BD8F0; }
  details.ayuda .hint-contenido{ margin-top:10px; }
  details.ayuda .hint-contenido p.hint{ margin:0 0 12px; }
  details.ayuda .hint-contenido p.hint:last-child{ margin-bottom:0; }

  label{ display:block; font-size:14px; color:var(--muted); margin:0 0 7px; font-weight:500; }
  textarea, input[type=number], input[type=text]{
    width:100%; background:var(--surface-3); border:1px solid var(--border); color:var(--text);
    border-radius:10px; padding:12px 14px; font-family:var(--body); font-size:15.5px; resize:vertical; outline:none;
  }
  textarea:focus, input:focus{ border-color:var(--green); }
  textarea{ min-height:96px; line-height:1.55; }
  .row2{ display:grid; grid-template-columns:1fr 1fr; gap:14px; }

  .volver{ display:inline-block; margin-top:10px; color:var(--muted); font-size:14.5px; text-decoration:none; }
  .volver:hover{ color:var(--green); }
</style>`;
}

function sidebarHTML(activo) {
  const link = (href, tag, label, key) => `
    <a class="side-link${activo === key ? " active" : ""}" href="${href}">
      <span>${label}</span><span class="side-tag">${tag}</span>
    </a>`;
  return `
<div class="sidebar">
  <div class="brand">
    <div class="brand-dot"></div>
    <div class="brand-name">IG AI Responder</div>
  </div>
  <nav class="side-nav">
    ${link("/dashboard", "DSH", "Dashboard", "dashboard")}
    ${link("/cuentas", "CTA", "Cuentas", "cuentas")}
    ${link("/panel", "CFG", "Configuración", "panel")}
    ${link("/chats", "CHT", "Chats", "chats")}
  </nav>
  <div class="sidebar-footer">Robertoperez.coach<br>v1.0<br><a href="/logout" style="color:var(--muted-dim);">Cerrar sesión</a></div>
</div>`;
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

// Registro temporal de los IDs de mensaje (mid) que el propio bot mandó —
// Instagram manda un "echo" por CADA mensaje saliente de la cuenta, sin
// importar si lo mandó el bot por la API o un humano escribiendo a mano
// directo en la app de Instagram. Esto permite distinguir ambos casos: si
// el mid del echo está aquí, ya lo guardamos nosotros mismos al mandarlo
// (se ignora el echo para no duplicarlo); si NO está, es un mensaje que
// alguien mandó manualmente desde la app, y sí hay que registrarlo.
const midsBotEnviados = new Map(); // mid -> timestamp de cuando se mandó

function registrarMidBot(mid) {
  if (!mid) return;
  midsBotEnviados.set(mid, Date.now());
}

function esMidDelBot(mid) {
  return Boolean(mid && midsBotEnviados.has(mid));
}

// Limpieza periódica: los echoes llegan casi de inmediato después de
// mandar un mensaje, no hace falta guardar los mids por mucho tiempo — se
// purgan los que ya tienen más de 10 minutos para no acumular memoria.
setInterval(() => {
  const ahora = Date.now();
  for (const [mid, ts] of midsBotEnviados) {
    if (ahora - ts > 10 * 60 * 1000) midsBotEnviados.delete(mid);
  }
}, 5 * 60 * 1000);

async function enviarMensajeInstagram(senderId, texto) {
  const cuenta = await obtenerCuentaActiva();
  if (!cuenta) throw new Error("No hay ninguna cuenta de Instagram conectada.");

  const resp = await axios.post(
    `https://graph.instagram.com/v25.0/${cuenta.ig_id}/messages`,
    {
      recipient: { id: senderId },
      message:   { text: texto }
    },
    {
      headers: { "Authorization": `Bearer ${cuenta.access_token}` }
    }
  );
  registrarMidBot(resp.data?.message_id);
}

// Manda un audio pregrabado como adjunto ("attachment" tipo audio). Instagram
// lo entrega en el chat como un mensaje de audio reproducible normal, igual
// que cualquier nota de voz — la diferencia es que el archivo ya existe (no
// se graba en el momento), pero para quien lo recibe se ve/escucha igual.
async function enviarAudioInstagram(senderId, urlAudio) {
  const cuenta = await obtenerCuentaActiva();
  if (!cuenta) throw new Error("No hay ninguna cuenta de Instagram conectada.");

  const resp = await axios.post(
    `https://graph.instagram.com/v25.0/${cuenta.ig_id}/messages`,
    {
      recipient: { id: senderId },
      message: {
        attachment: {
          type: "audio",
          payload: { url: urlAudio }
        }
      }
    },
    {
      headers: { "Authorization": `Bearer ${cuenta.access_token}` }
    }
  );
  registrarMidBot(resp.data?.message_id);
}

// Manda una imagen como adjunto ("attachment" tipo image). Se usa tanto para
// fotos pregrabadas ([[foto:clave]] desde el prompt o los seguimientos) como
// para fotos sueltas mandadas a mano desde /chats (ej. casos de éxito).
async function enviarImagenInstagram(senderId, urlImagen) {
  const cuenta = await obtenerCuentaActiva();
  if (!cuenta) throw new Error("No hay ninguna cuenta de Instagram conectada.");

  const resp = await axios.post(
    `https://graph.instagram.com/v25.0/${cuenta.ig_id}/messages`,
    {
      recipient: { id: senderId },
      message: {
        attachment: {
          type: "image",
          payload: { url: urlImagen }
        }
      }
    },
    {
      headers: { "Authorization": `Bearer ${cuenta.access_token}` }
    }
  );
  registrarMidBot(resp.data?.message_id);
}

// Pequeña espera asíncrona, usada por el envío secuencial de mensajes para
// respetar los marcadores [[pausa:N]] (ver más abajo) y por los reintentos.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Instagram rechaza por completo cualquier mensaje de más de 1000 caracteres
// (error "The length of the message sent is over 1000 characters"), y ese
// rechazo hace que la respuesta se pierda del todo. Se usa un margen de
// seguridad debajo del límite real para no rozarlo.
const LIMITE_CARACTERES_INSTAGRAM = 950;

// Además del límite duro de Instagram de arriba, se usa uno mucho más chico
// para dividir cualquier texto que sea largo (más de ~4 líneas visuales en
// una pantalla de celular) en varias burbujas más cortas — aunque el texto
// esté muy por debajo del límite real de Instagram, un bloque de texto
// grande se siente pesado de leer en un chat, así que se corta igual que si
// el propio prompt hubiera usado [[pausa:N]] entre cada parte.
const LIMITE_CARACTERES_BURBUJA_NATURAL = 180;

// Divide un texto largo en varios mensajes que respeten el límite de
// caracteres de Instagram. Es una red de seguridad: si el prompt no dejó
// suficientemente claro que la IA debe ser breve y de todos modos genera una
// respuesta muy larga, en vez de que Instagram la rechace y se pierda, se
// manda en varias burbujas seguidas. Intenta cortar en saltos de párrafo o de
// línea primero, y si no encuentra un buen punto de corte cerca del límite,
// corta en el espacio más cercano (para no partir una palabra a la mitad).
function dividirTextoLargo(texto, limite = LIMITE_CARACTERES_INSTAGRAM) {
  if (texto.length <= limite) return [texto];

  const partes = [];
  let restante = texto;

  while (restante.length > limite) {
    let corte = restante.lastIndexOf("\n\n", limite);
    if (corte < limite * 0.4) corte = restante.lastIndexOf("\n", limite);
    if (corte < limite * 0.4) {
      // Al cortar por ". " hay que quedarse CON el punto en la parte actual
      // (+1) — si no, el punto queda colgando al inicio de la siguiente
      // burbuja (ej. ". La buena noticia es que...", con el punto suelto).
      const cortePorPunto = restante.lastIndexOf(". ", limite);
      if (cortePorPunto >= limite * 0.4) corte = Math.min(cortePorPunto + 1, limite);
    }
    if (corte < limite * 0.4) corte = restante.lastIndexOf(" ", limite);
    if (corte < limite * 0.4) corte = limite; // no se encontró un buen punto de corte, se corta a la fuerza

    partes.push(restante.slice(0, corte).trim());
    restante = restante.slice(corte).trim();
  }
  if (restante) partes.push(restante);

  return partes.filter(Boolean);
}

// El envío de adjuntos (audio/foto) a la API de Instagram a veces falla de
// forma intermitente del lado de Meta ("Upload failed", code 100) sin que
// haya nada mal con el archivo. Este helper reintenta una vez más antes de
// darse por vencido, con una breve espera en medio.
async function conReintento(fn, intentos = 1, esperaMs = 1500) {
  let ultimoError;
  for (let i = 0; i <= intentos; i++) {
    try {
      return await fn();
    } catch (err) {
      ultimoError = err;
      if (i === intentos) break;
      console.warn(`⚠️ Falló el intento ${i + 1} de enviar el adjunto, reintentando en ${esperaMs}ms:`, err.response?.data || err.message);
      await sleep(esperaMs);
    }
  }
  throw ultimoError;
}

// Marcadores dentro de un texto que, en vez de mandarse todos pegados en un
// solo mensaje, se resuelven como una SECUENCIA de mensajes independientes:
//   [[audio:clave]]  -> manda un audio ya subido en /panel
//   [[foto:clave]]   -> manda una foto ya subida en /panel
//   [[pausa:N]]      -> no manda nada, solo espera N segundos antes de mandar
//                       lo que sigue como un mensaje NUEVO (burbuja aparte)
//   [[etapa:clave]]  -> no manda nada, solo cambia la ETAPA actual de la
//                       conversación (ver sección de Etapas más abajo)
// Sirve tanto para la respuesta principal de la IA como para los mensajes de
// seguimiento automático (normal o del enlace) — cualquier mensaje de texto
// del sistema puede llevar estos marcadores. Ejemplo de uso en el prompt:
//   "Perfecto, te dejo el enlace por aquí 👇[[pausa:8]]https://calendly.com/..."
// manda primero el texto, espera 8 segundos, y luego manda el enlace solo,
// en su propio mensaje (para que no salga todo pegado en un mismo bloque).
// Nota: el regex es tolerante a espacios extra que a veces mete la IA por su
// cuenta (ej. "[[ audio: clave ]]" o "[[pausa: 5]]") — así no se pierde el
// marcador solo porque el modelo lo escribió con un espacio de más.
const MARCADOR_MULTIMEDIA_REGEX = /\[\[\s*(audio|foto|pausa|etapa)\s*:\s*([a-zA-Z0-9_.-]+)\s*\]\]/gi;

// Convierte el contenido crudo (con marcadores) en una lista ordenada de
// "partes" a mandar en secuencia, respetando el orden en el que aparecen en
// el string original: { tipo:"texto", valor }, { tipo:"audio"|"foto", clave },
// { tipo:"pausa", segundos } o { tipo:"etapa", clave }.
function parsearPartes(contenidoCrudo) {
  const partesCrudas = [];
  let ultimoIndice = 0;
  const regex = new RegExp(MARCADOR_MULTIMEDIA_REGEX.source, "gi");
  let match;

  while ((match = regex.exec(contenidoCrudo)) !== null) {
    const textoPrevio = contenidoCrudo.slice(ultimoIndice, match.index).trim();
    if (textoPrevio) partesCrudas.push({ tipo: "texto", valor: textoPrevio });

    const tipoMarcador = match[1].toLowerCase();
    const valorMarcador = match[2];

    if (tipoMarcador === "pausa") {
      const segundos = parseFloat(valorMarcador);
      if (Number.isFinite(segundos) && segundos > 0) {
        partesCrudas.push({ tipo: "pausa", segundos });
      }
    } else if (tipoMarcador === "etapa") {
      partesCrudas.push({ tipo: "etapa", clave: valorMarcador.toLowerCase() });
    } else {
      partesCrudas.push({ tipo: tipoMarcador, clave: valorMarcador.toLowerCase() });
    }

    ultimoIndice = match.index + match[0].length;
  }

  const textoFinal = contenidoCrudo.slice(ultimoIndice).trim();
  if (textoFinal) partesCrudas.push({ tipo: "texto", valor: textoFinal });

  // Cualquier parte de texto que sea larga (más de ~4 líneas visuales) se
  // divide automáticamente en varias burbujas más cortas, con una pausa
  // natural entre cada una — igual que si el propio prompt hubiera usado
  // [[pausa:N]] a propósito. Esto es una red de seguridad a nivel de código:
  // no depende de que la IA se acuerde de partir sus respuestas largas por
  // su cuenta (ya vimos que las instrucciones de solo-prompt a veces no se
  // siguen de forma consistente), así que siempre queda parejo.
  const partes = [];
  for (const parte of partesCrudas) {
    if (parte.tipo === "texto" && parte.valor.length > LIMITE_CARACTERES_BURBUJA_NATURAL) {
      const bloques = dividirTextoLargo(parte.valor, LIMITE_CARACTERES_BURBUJA_NATURAL);
      bloques.forEach((bloque, i) => {
        partes.push({ tipo: "texto", valor: bloque });
        if (i < bloques.length - 1) {
          // Pausa corta y natural entre cada burbuja (4 a 6 segundos),
          // simulando que se está escribiendo en el momento.
          partes.push({ tipo: "pausa", segundos: Math.round((4 + Math.random() * 2) * 10) / 10 });
        }
      });
    } else {
      partes.push(parte);
    }
  }

  return partes;
}

// Manda un contenido crudo (con marcadores [[audio:..]], [[foto:..]],
// [[pausa:N]] y [[etapa:..]]) como una secuencia de mensajes independientes,
// respetando las pausas indicadas entre cada uno y aplicando el cambio de
// etapa cuando corresponda (sin mandar nada al cliente por ese marcador).
// Se usa tanto para la respuesta principal de la IA como para los mensajes
// de seguimiento automático (normal o del enlace). Devuelve el texto de
// todas las partes de texto que se mandaron (unidas con salto de línea),
// útil para lógicas que necesitan revisar el contenido textual real enviado
// (ej. la detección del enlace de calificación).
async function enviarContenidoConMarcadores(senderId, contenidoCrudo) {
  const partes = parsearPartes(contenidoCrudo);

  const textosEnviados = [];
  let algoSeMando = false;

  for (const parte of partes) {
    if (parte.tipo === "pausa") {
      await sleep(parte.segundos * 1000);
      continue;
    }

    if (parte.tipo === "etapa") {
      const etapaExiste = (configActual.etapas || []).some(e => e.clave === parte.clave);
      if (!etapaExiste) {
        console.warn(`⚠️ Se pidió cambiar a la etapa "${parte.clave}" pero no existe en /panel. Se ignora ese marcador.`);
        continue;
      }
      console.log(`🧭 Cambiando la etapa de ${senderId} a "${parte.clave}"`);
      await guardarConversacion(senderId, { etapa: parte.clave });
      continue;
    }

    if (parte.tipo === "texto") {
      // Si queda algo parecido a un marcador sin cerrar/mal escrito (ej. la
      // IA olvidó un corchete o puso mal la clave), lo avisamos en consola
      // con el texto exacto — así se puede ver en los logs de Render qué
      // generó el modelo cuando el marcador "no se toma".
      if (/\[\[/.test(parte.valor) || /\]\]/.test(parte.valor)) {
        console.warn(`⚠️ Posible marcador mal formado en la respuesta a ${senderId} (se mandó como texto normal): "${parte.valor}"`);
      }

      // Red de seguridad: Instagram rechaza de golpe cualquier mensaje de
      // más de 1000 caracteres (se pierde la respuesta completa). Si la IA
      // generó algo más largo de lo esperado, se manda en varias burbujas.
      const fragmentos = dividirTextoLargo(parte.valor);
      if (fragmentos.length > 1) {
        console.warn(`⚠️ La respuesta a ${senderId} tiene ${parte.valor.length} caracteres (arriba del límite de Instagram) — se divide en ${fragmentos.length} mensajes.`);
      }

      for (let idx = 0; idx < fragmentos.length; idx++) {
        const fragmento = fragmentos[idx];
        await agregarAlHistorialDB(senderId, "assistant", fragmento);
        await enviarMensajeInstagram(senderId, fragmento);
        textosEnviados.push(fragmento);
        algoSeMando = true;
        if (idx < fragmentos.length - 1) await sleep(900); // pausa breve y natural entre burbujas divididas
      }
      continue;
    }

    // tipo === "audio" | "foto"
    const almacen = parte.tipo === "audio" ? configActual.audios : configActual.fotos;
    const item = almacen?.[parte.clave];

    if (!item?.url) {
      console.warn(`⚠️ Se pidió el ${parte.tipo} "${parte.clave}" pero no está configurado en /panel. Se ignora ese marcador.`);
      continue;
    }

    if (parte.tipo === "audio") {
      console.log(`🎤 Enviando audio pregrabado "${parte.clave}" a ${senderId}`);
      await agregarAlHistorialDB(senderId, "assistant", `[[audio]]${item.url}`);
      await conReintento(() => enviarAudioInstagram(senderId, item.url));
    } else {
      console.log(`📷 Enviando foto pregrabada "${parte.clave}" a ${senderId}`);
      await agregarAlHistorialDB(senderId, "assistant", `[[imagen]]${item.url}`);
      await conReintento(() => enviarImagenInstagram(senderId, item.url));
    }
    algoSeMando = true;
  }

  // Si solo había marcadores mal escritos, pausas/etapas sueltas o nada
  // rescatable, no se manda nada — ya se avisó por consola. Evita mandarle
  // al cliente marcadores crudos tipo "[[audio:x]]" o dejar todo en silencio
  // sin pista.
  if (!algoSeMando) {
    console.warn(`⚠️ No se pudo mandar nada a ${senderId}: el contenido solo tenía marcadores multimedia/etapa que no existen en /panel, o pausas sin contenido alrededor.`);
  }

  return textosEnviados.join("\n");
}

// ---------------------------------------------------------------
// Disparadores automáticos: envío GARANTIZADO de un audio/foto cuando el
// mensaje del cliente contiene ciertas palabras o frases — sin depender de
// que la IA "decida" incluir el marcador (lo cual es inconsistente, porque
// es una decisión probabilística del modelo, no una regla fija). Se
// configuran en /panel. Si la IA ya mandó ese mismo audio/foto por su cuenta
// (usando el marcador en su respuesta), el disparador NO lo repite.
//
// A partir de las Etapas, estos disparadores "generales" son el FALLBACK:
// primero se revisan los disparadores propios de la etapa activa de esa
// conversación (si tiene una) y solo si NINGUNO de esos coincide, se cae a
// revisar esta lista general. Así, una misma palabra puede significar cosas
// distintas según en qué etapa esté el lead, y solo si la etapa no tiene
// nada configurado para esa palabra se usa el comportamiento general.
// ---------------------------------------------------------------

function normalizarParaComparar(texto) {
  return (texto || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // quita acentos
    .trim();
}

// Compara un mensaje ya normalizado contra una frase ya normalizada, según
// el modo configurado:
//   "contiene" (por defecto) -> la frase aparece en cualquier parte del mensaje.
//   "exacta" -> el mensaje completo (sin espacios sobrantes) es ESA frase y
//   nada más. Sirve para casos como una palabra clave de un CTA de video
//   ("manda la palabra DIETA") donde no quieres que dispare si el cliente
//   simplemente menciona "dieta" dentro de una frase más larga sobre otra cosa.
function coincideFrase(mensajeNormalizado, fraseNormalizada, modo) {
  if (!fraseNormalizada) return false;
  if (modo === "exacta") return mensajeNormalizado === fraseNormalizada;
  return mensajeNormalizado.includes(fraseNormalizada);
}

// Devuelve la lista de disparadores configurados cuyas palabras/frases
// coinciden con el mensaje del cliente (sin mayúsculas ni acentos), según el
// modo de coincidencia de cada disparador:
//   "contiene"      -> con que UNA de las frases aparezca en el mensaje, activa.
//   "exacta"        -> el mensaje completo debe ser UNA de las frases, tal cual.
//   "combinaciones" -> cada LÍNEA es un grupo de palabras separadas por coma
//                       que TIENEN que estar TODAS presentes para que esa
//                       línea cuente; si CUALQUIERA de las líneas se cumple
//                       completa, el disparador se activa. Sirve para armar
//                       varias combinaciones distintas en un mismo disparador,
//                       ej. "cansancio, estetico" en una línea y
//                       "hipertension, estetico" en otra — activa con
//                       cualquiera de las dos combinaciones.
function grupoDePalabrasCoincide(mensajeNormalizado, lineaConComas) {
  const palabras = lineaConComas.split(",").map(p => normalizarParaComparar(p)).filter(Boolean);
  if (palabras.length === 0) return false;
  return palabras.every(p => mensajeNormalizado.includes(p));
}

function buscarDisparadoresActivados(mensajeUsuario, disparadores, etiquetasConv) {
  const mensajeNormalizado = normalizarParaComparar(mensajeUsuario);
  const etiquetasNormalizadas = (etiquetasConv || []).map(normalizarParaComparar);

  return (disparadores || []).filter((d) => {
    if (!Array.isArray(d.frases) || d.frases.length === 0) return false;

    // Modo "etiqueta": en vez de comparar contra el texto del mensaje, se
    // revisa si la conversación YA TIENE alguna de las etiquetas listadas
    // (cada "frase" aquí es en realidad el nombre de una etiqueta a
    // buscar) — 100% determinista, no depende de que el mensaje actual
    // mencione nada en particular. Útil para, por ejemplo, disparar el
    // envío de un recurso en la etapa "no califica" según qué etiqueta se
    // le puso al lead desde el principio de la conversación.
    if (d.coincidencia === "etiqueta") {
      return d.frases.some((etq) => etiquetasNormalizadas.includes(normalizarParaComparar(etq)));
    }

    if (d.coincidencia === "combinaciones") {
      return d.frases.some((linea) => grupoDePalabrasCoincide(mensajeNormalizado, linea));
    }

    return d.frases.some((frase) => coincideFrase(mensajeNormalizado, normalizarParaComparar(frase), d.coincidencia));
  });
}

// Revisa si una lista de "partes" ya parseadas (ver parsearPartes) incluye
// un audio/foto con esa clave — para no volver a mandarlo si la IA ya lo
// incluyó ella misma en su respuesta.
function partesIncluyenMedia(partes, tipo, clave) {
  const claveNormalizada = (clave || "").toLowerCase();
  return partes.some((p) => p.tipo === tipo && p.clave === claveNormalizada);
}

// Manda el contenido de un disparador ya activado (audio, foto, o el tipo
// "mensaje" con contenido libre) respetando su propia espera configurada.
// Se usa tanto en el camino normal (disparador se suma a la respuesta de la
// IA) como en el camino "exclusivo" (el disparador reemplaza por completo la
// respuesta de ese turno).
async function enviarDisparador(senderId, disparador, origenLog) {
  // Si este disparador tiene configurada una etiqueta para agregar, se
  // aplica SIEMPRE que se active — sin importar el tipo (audio/foto/mensaje
  // pueden ADEMÁS etiquetar; el tipo "etiqueta" es solo para esto). Se hace
  // de una vez, antes de la espera/envío, para no perderla si algo más
  // abajo falla.
  if (disparador.etiqueta_a_agregar) {
    try {
      const conv = await obtenerConversacion(senderId);
      const etiquetasActuales = Array.isArray(conv.etiquetas) ? conv.etiquetas : [];
      if (!etiquetasActuales.includes(disparador.etiqueta_a_agregar)) {
        console.log(`🏷️ Disparador automático (${origenLog}): agregando la etiqueta "${disparador.etiqueta_a_agregar}" a ${senderId}.`);
        await guardarConversacion(senderId, { etiquetas: [...etiquetasActuales, disparador.etiqueta_a_agregar] });
        await registrarEtiquetaCreada(disparador.etiqueta_a_agregar);
      }
    } catch (err) {
      console.error(`❌ Error agregando la etiqueta automática a ${senderId}:`, err.message);
    }
  }

  // El tipo "etiqueta" no manda ningún contenido — su único propósito es
  // marcar la conversación (ya se hizo arriba), así que termina aquí.
  if (disparador.tipo === "etiqueta") return;

  const esperaSegundos = Number.isFinite(disparador.pausa_segundos) ? disparador.pausa_segundos : 2;
  if (esperaSegundos > 0) await sleep(esperaSegundos * 1000);

  if (disparador.tipo === "mensaje") {
    if (!disparador.contenido?.trim()) {
      console.warn(`⚠️ El disparador tipo "mensaje" (${origenLog}) no tiene contenido configurado, se ignora.`);
      return;
    }
    try {
      console.log(`🎯 Disparador automático (${origenLog}): enviando mensaje combinado a ${senderId} (activado por palabra clave)`);
      await enviarContenidoConMarcadores(senderId, disparador.contenido);
    } catch (err) {
      console.error(`❌ Error enviando el disparador tipo "mensaje" a ${senderId}:`, err.response?.data || err.message);
    }
    return;
  }

  const almacen = disparador.tipo === "audio" ? configActual.audios : configActual.fotos;
  const item = almacen?.[disparador.clave];
  if (!item?.url) {
    console.warn(`⚠️ El disparador apunta al ${disparador.tipo} "${disparador.clave}", pero no existe (o se borró) en /panel.`);
    return;
  }

  try {
    if (disparador.tipo === "audio") {
      console.log(`🎯 Disparador automático (${origenLog}): enviando audio "${disparador.clave}" a ${senderId} (activado por palabra clave)`);
      await agregarAlHistorialDB(senderId, "assistant", `[[audio]]${item.url}`);
      await conReintento(() => enviarAudioInstagram(senderId, item.url));
    } else {
      console.log(`🎯 Disparador automático (${origenLog}): enviando foto "${disparador.clave}" a ${senderId} (activado por palabra clave)`);
      await agregarAlHistorialDB(senderId, "assistant", `[[imagen]]${item.url}`);
      await conReintento(() => enviarImagenInstagram(senderId, item.url));
    }
  } catch (err) {
    console.error(`❌ Error enviando el disparador automático "${disparador.clave}" a ${senderId}:`, err.response?.data || err.message);
  }
}

// ---------------------------------------------------------------
// Etapas de la conversación: cada lead puede estar en una "etapa" (guardada
// en conversaciones.etapa). Mientras esté en una etapa, se usa el PROMPT
// propio de esa etapa (en vez del prompt general de arriba) para que la IA
// no se confunda con preguntas de sí/no de otras partes de la conversación
// — por ejemplo, si en la etapa "precio" un "sí" significa una cosa y en la
// etapa "agendar" un "sí" significa otra, cada etapa solo conoce su propio
// contexto. El propio prompt de la etapa debe incluir el marcador
// [[etapa:siguiente_clave]] cuando quiera avanzar a la siguiente etapa (o
// [[etapa:clave]] hacia cualquier otra que exista). Si el lead no tiene
// ninguna etapa asignada, se usa el prompt general de siempre.
// ---------------------------------------------------------------

function obtenerEtapaConfig(claveEtapa) {
  if (!claveEtapa) return null;
  return (configActual.etapas || []).find(e => e.clave === claveEtapa) || null;
}

// Transiciones automáticas de etapa por palabra clave: igual que los
// disparadores de audio/foto, esto NO depende de que la IA decida poner el
// marcador [[etapa:clave]] en su respuesta (que es inconsistente, porque es
// una decisión probabilística del modelo). Si el mensaje del cliente
// contiene alguna de las frases configuradas, se cambia de etapa GARANTIZADO
// por código. El marcador [[etapa:clave]] sigue funcionando también, como
// mecanismo adicional/manual para casos que no se puedan reducir a una
// palabra clave fija.
//
// etapa_destino === "" significa "salir de etapas" (volver al prompt general).
// Las transiciones con coincidencia === "condicion" NO se evalúan aquí (son
// más costosas, requieren IA) — se revisan aparte en evaluarTransicionesPorCondicion,
// y solo como fallback si ninguna transición por palabra clave coincidió.
function buscarTransicionActivada(mensajeUsuario, transiciones, etiquetasConv) {
  const mensajeNormalizado = normalizarParaComparar(mensajeUsuario);
  const etiquetasNormalizadas = (etiquetasConv || []).map(normalizarParaComparar);

  for (const t of (transiciones || [])) {
    if (typeof t.etapa_destino !== "string") continue;
    if (t.coincidencia === "condicion") continue;
    if (!Array.isArray(t.frases)) continue;

    // Igual que en disparadores: modo "etiqueta" revisa si la conversación
    // ya tiene alguna de las etiquetas listadas, en vez de comparar contra
    // el texto del mensaje actual.
    const coincide = t.coincidencia === "etiqueta"
      ? t.frases.some((etq) => etiquetasNormalizadas.includes(normalizarParaComparar(etq)))
      : t.coincidencia === "combinaciones"
      ? t.frases.some((linea) => grupoDePalabrasCoincide(mensajeNormalizado, linea))
      : t.frases.some((frase) => coincideFrase(mensajeNormalizado, normalizarParaComparar(frase), t.coincidencia));

    if (coincide) return t;
  }
  return null;
}

// Evalúa transiciones de tipo "condición" (ej. "el cliente mencionó tener 40
// años o más") usando la IA, ya que esto no se puede reducir a una simple
// coincidencia de texto. Para no multiplicar las llamadas a OpenAI, se
// evalúan TODAS las condiciones de la lista en una sola llamada.
//
// Tiene DOS MODOS, según "elegirMejor":
//   false (por defecto) -> cada condición se evalúa de forma INDEPENDIENTE
//     (sí/no cada una), y gana la PRIMERA que resulte verdadera según el
//     orden de la lista. Puede pasar que la IA marque más de una como
//     verdadera a la vez, y en ese caso el orden decide cuál gana —
//     aunque la que realmente corresponde sea otra.
//   true -> en vez de evaluar cada una por separado, se le pide a la IA que
//     las compare ENTRE SÍ (como categorías que se excluyen unas a otras) y
//     elija UNA SOLA, la que mejor describa lo que dijo el cliente. Ya no
//     importa el orden de la lista — la IA decide directamente cuál es,
//     sin pasar por una carrera de "la primera que diga sí".
//
// Solo se llama cuando ninguna transición por palabra clave coincidió
// primero (ver buscarTransicionActivada), así que no agrega costo a las
// etapas que no usan este modo.
async function evaluarTransicionesPorCondicion(mensajeUsuario, historial, transicionesCondicion, elegirMejor) {
  if (!transicionesCondicion || transicionesCondicion.length === 0) return null;

  try {
    // Se manda más contexto (hasta 12 mensajes, no solo 6) porque la
    // respuesta que confirma una condición (ej. la edad) a veces quedó
    // varios turnos atrás, no necesariamente en el último intercambio.
    const contexto = sanitizarHistorialParaIA(historial).slice(-12)
      .map(m => `${m.role === "user" ? "Cliente" : "Asistente"}: ${m.content}`)
      .join("\n");

    const listaCondiciones = transicionesCondicion.map((t, idx) => `${idx}. ${t.condicion.trim()}`).join("\n");
    const mensajeUsuarioContenido = `Contexto reciente de la conversación:\n${contexto}\n\nÚltimo mensaje del cliente: "${mensajeUsuario}"`;

    if (elegirMejor) {
      const resp = await openaiClient.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 80,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Te doy una lista de condiciones que describen distintas posibles situaciones o razones del " +
              "cliente — se tratan como categorías que se EXCLUYEN entre sí (el cliente normalmente encaja " +
              "en una sola, no en varias a la vez). Decide cuál de ellas describe MEJOR lo que el cliente " +
              "quiso decir en su último mensaje, considerando también el contexto reciente. Si ninguna aplica " +
              "razonablemente, responde null. Responde ÚNICAMENTE un JSON con este formato exacto, sin texto " +
              'adicional: {"mejor_indice": <número de la condición que mejor aplica, o null>}.\n\n' +
              "Condiciones:\n" + listaCondiciones
          },
          { role: "user", content: mensajeUsuarioContenido }
        ]
      });

      const texto = resp.choices[0]?.message?.content?.trim();
      const parsed = JSON.parse(texto);
      const indiceElegido = parsed.mejor_indice;

      console.log(`🔍 Evaluación "elegir la mejor" entre ${transicionesCondicion.length} condiciones -> índice elegido: ${Number.isInteger(indiceElegido) ? indiceElegido : "ninguno"}`);

      if (Number.isInteger(indiceElegido) && indiceElegido >= 0 && indiceElegido < transicionesCondicion.length) {
        return transicionesCondicion[indiceElegido];
      }
      return null;
    }

    const resp = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 150,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Eres un evaluador que decide si el ÚLTIMO mensaje del cliente (dado el contexto reciente de la " +
            "conversación) cumple alguna de las siguientes condiciones. Evalúa cada condición de forma " +
            "independiente, basándote en lo que el cliente ha dicho de forma explícita o razonablemente " +
            "implícita, considerando TODO el contexto (la respuesta puede estar en un mensaje anterior, no " +
            "solo en el último). Si no hay información suficiente para confirmar una condición, considérala " +
            "NO cumplida. Responde ÚNICAMENTE un JSON con este formato exacto, sin texto adicional: " +
            '{"cumple": [true o false, ...]} con un valor por cada condición, EN EL MISMO ORDEN en que se listan.\n\n' +
            "Condiciones:\n" + listaCondiciones
        },
        { role: "user", content: mensajeUsuarioContenido }
      ]
    });

    const texto = resp.choices[0]?.message?.content?.trim();
    const parsed = JSON.parse(texto);
    const resultados = Array.isArray(parsed.cumple) ? parsed.cumple : [];

    // Log de diagnóstico SIEMPRE (no solo cuando hay match) — así en los
    // logs de Render se puede ver exactamente qué decidió la IA para cada
    // condición configurada, incluso cuando decide que ninguna se cumple.
    transicionesCondicion.forEach((t, i) => {
      console.log(`🔍 Condición #${i} ("${t.condicion}") -> ¿cumplida?: ${resultados[i] === true ? "SÍ" : "no"}`);
    });

    for (let i = 0; i < transicionesCondicion.length; i++) {
      if (resultados[i] === true) return transicionesCondicion[i];
    }
    console.log(`🔍 Ninguna condición se cumplió — se sigue en la misma etapa, responde el prompt normal.`);
    return null;
  } catch (err) {
    console.error("⚠️ Error evaluando transición por condición:", err.response?.data || err.message);
    return null;
  }
}

// si la conversación ya cumple con los criterios que definiste en
// /panel (edad, objetivo, género, etc.) y marca la conversación como
// "califica" la primera vez que se cumplen. Es una llamada aparte,
// barata y sin afectar el mensaje que recibe el cliente.
// ---------------------------------------------------------------
// Evalúa la calificación de un lead criterio por criterio (cada línea del
// campo "Criterios de calificación" es un criterio independiente), en vez de
// pedirle a la IA un solo true/false global. Esto tiene dos ventajas:
//   1) Se puede aplicar una regla ANTI-INFERENCIA explícita y estricta: un
//      criterio solo cuenta como cumplido si el cliente lo confirmó
//      directamente, nunca por suposición o porque "no dijo lo contrario"
//      (ej. no asumir que puede pagar $100 solo porque no ha preguntado el
//      precio todavía — si nunca se le preguntó, ese criterio sigue sin
//      cumplirse, así de simple).
//   2) Deja un registro en los logs de CUÁL criterio en particular está
//      fallando, en vez de un solo veredicto sin desglose.
async function evaluarCalificacion(historial, criterios) {
  try {
    const transcripcion = sanitizarHistorialParaIA(historial)
      .map(m => `${m.role === "user" ? "Cliente" : "Asistente"}: ${m.content}`)
      .join("\n");

    const listaCriterios = (criterios || "").split("\n").map(c => c.trim()).filter(Boolean);
    if (listaCriterios.length === 0) return { califica: false, razon: "" };

    const criteriosNumerados = listaCriterios.map((c, idx) => `${idx}. ${c}`).join("\n");

    const resp = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 350,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Eres un evaluador de leads para un negocio. Te doy una lista de criterios de calificación " +
            "y el historial COMPLETO de una conversación de Instagram. Debes decidir, criterio por " +
            "criterio, si el cliente lo cumple.\n\n" +
            "REGLA MÁS IMPORTANTE (anti-inferencia): un criterio SOLO se considera cumplido si el " +
            "CLIENTE lo confirmó de forma explícita, con sus propias palabras, típicamente en respuesta " +
            "a una pregunta relacionada con ese tema específico. NUNCA marques un criterio como cumplido " +
            "por suposición, optimismo, o porque \"probablemente aplica\" — la ausencia de objeción NO es " +
            "una confirmación. En particular: si el tema de un criterio (ej. presupuesto, precio, una " +
            "condición específica) todavía NO SE HA PREGUNTADO ni mencionado en la conversación, ese " +
            "criterio es FALSE — nunca asumas que se cumple solo porque el cliente no ha dicho nada en " +
            "contra o no ha objetado el tema. Si tienes cualquier duda razonable sobre si un criterio " +
            "ya quedó confirmado, respóndelo como FALSE.\n\n" +
            "Responde ÚNICAMENTE un JSON con este formato exacto, sin texto adicional: " +
            '{"cumple": [true o false, ...], "razon": "explicación breve en español de cuáles se cumplen y cuáles no"} ' +
            "con un valor en \"cumple\" por cada criterio, EN EL MISMO ORDEN en que se listan.\n\n" +
            "Criterios:\n" + criteriosNumerados
        },
        { role: "user", content: "Historial completo de la conversación:\n\n" + transcripcion }
      ]
    });

    const texto = resp.choices[0]?.message?.content?.trim();
    const parsed = JSON.parse(texto);
    const resultados = Array.isArray(parsed.cumple) ? parsed.cumple : [];

    // Log de diagnóstico por criterio — para poder ver en Render exactamente
    // cuál criterio en particular está bloqueando (o dejando pasar) a un lead.
    listaCriterios.forEach((c, i) => {
      console.log(`🔍 Criterio de calificación #${i} ("${c}") -> ¿cumplido?: ${resultados[i] === true ? "SÍ" : "no"}`);
    });

    const todosCumplidos = resultados.length === listaCriterios.length && resultados.every(r => r === true);

    return { califica: todosCumplidos, razon: parsed.razon || "" };
  } catch (err) {
    console.error("⚠️ Error evaluando calificación de lead:", err.response?.data || err.message);
    return null;
  }
}

// Analiza UNA conversación y extrae, si se mencionan: un problema de salud,
// un motivo estético, y el principal obstáculo del lead para lograrlo por su
// cuenta. Se usa para el reporte de "dolores y obstáculos más frecuentes"
// (ver /exportar/dolores-obstaculos.csv), pensado para entender mejor al
// cliente y usarlo en publicidad/comunicación. Se le pide a la IA una
// etiqueta CORTA y reutilizable (no una frase larga) para poder agrupar y
// contar categorías repetidas entre distintas conversaciones.
// Transcribe un audio que mandó el CLIENTE por Instagram (un mensaje de voz).
// Instagram no manda ninguna transcripción propia por la API — solo la URL
// del archivo de audio — así que se descarga y se manda a transcribir con
// el modelo de audio de OpenAI. El texto resultante se trata exactamente
// igual que si el cliente lo hubiera escrito: pasa por los mismos
// disparadores, transiciones, y por el mismo historial.
// Si por lo que sea no se pudo transcribir un audio (error de red, archivo
// corrupto, formato raro, etc.), se le avisa al cliente con una excusa
// creíble y se le pide que lo vuelva a mandar — en vez de simplemente
// quedarse callado, que se sentiría como que el bot lo ignoró. Rotan varias
// para no sonar repetitivo si le llega a pasar a distintos leads. Esto es
// solo el valor POR DEFECTO — se puede personalizar desde /panel
// (configActual.mensajes_error_audio); si el admin no puso ninguno, se cae
// a esta lista.
const MENSAJES_ERROR_AUDIO_DEFECTO = [
  "Se me cortó tu audio a la mitad, no me llegó completo 😅 ¿me lo puedes volver a mandar?",
  "Uy, no me cargó bien tu audio, se ve que hubo un error de conexión. ¿Me lo mandas de nuevo?",
  "Se me trabó tu audio y no lo pude escuchar completo, disculpa. ¿Lo puedes volver a enviar?",
  "No me llegó tu audio como debía, creo que hubo un problema de conexión. ¿Me lo reenvías?"
];

// Convierte un audio a MP4/AAC — el formato que el Send API de Instagram
// realmente acepta. Los navegadores graban el audio del micrófono en
// WEBM/Opus por defecto, y ese formato NO es uno de los que Instagram
// soporta para mandar audios (da el error "This attachment format is not
// supported"), así que hay que convertirlo antes de subirlo. Usa un binario
// de ffmpeg empaquetado (no depende de que el sistema operativo lo tenga
// instalado), y trabaja con archivos temporales porque fluent-ffmpeg no
// soporta bien streams/buffers directamente para este tipo de conversión.
async function convertirAudioAMp4(bufferEntrada) {
  const carpetaTemp = os.tmpdir();
  const rutaEntrada = path.join(carpetaTemp, `audio_in_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const rutaSalida = `${rutaEntrada}.mp4`;

  try {
    fs.writeFileSync(rutaEntrada, bufferEntrada);

    await new Promise((resolve, reject) => {
      ffmpeg(rutaEntrada)
        .noVideo()
        .audioCodec("aac")
        .audioBitrate("128k")
        .audioFrequency(44100)
        .toFormat("mp4")
        .on("error", reject)
        .on("end", resolve)
        .save(rutaSalida);
    });

    return fs.readFileSync(rutaSalida);
  } finally {
    // Se limpian los archivos temporales pase lo que pase, para no ir
    // acumulando basura en el disco del servidor con cada audio enviado.
    fs.promises.unlink(rutaEntrada).catch(() => {});
    fs.promises.unlink(rutaSalida).catch(() => {});
  }
}

async function transcribirAudioDeInstagram(url) {
  try {
    const respuesta = await axios.get(url, { responseType: "arraybuffer", timeout: 20000 });
    const buffer = Buffer.from(respuesta.data);

    // El nombre con extensión ayuda al modelo a reconocer el formato del
    // archivo (Instagram manda sus audios como .mp4/AAC, no como .mp3).
    const archivo = await toFile(buffer, "audio.mp4");

    const transcripcion = await openaiClient.audio.transcriptions.create({
      file: archivo,
      model: "whisper-1",
      language: "es"
    });

    const texto = transcripcion?.text?.trim();
    return texto || null;
  } catch (err) {
    console.error("❌ Error transcribiendo audio de Instagram:", err.response?.data || err.message);
    return null;
  }
}

async function analizarDoloresYObstaculos(transcripcion) {
  try {
    const resp = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Analiza esta conversación de un lead con un entrenador fitness y extrae, si se mencionan: " +
            "(1) un problema o dolor de SALUD/energía (ej. hipertension, diabetes, cansancio, colesterol, " +
            "articulaciones, azucar, higado graso, poca energia — o cualquier otro que se mencione), " +
            "(2) un motivo o problema ESTÉTICO/de apariencia (ej. estetica, verme bien, fisico, panza, guata, " +
            "barriga, u otro), (3) el principal OBSTÁCULO que dice tener para lograrlo por su cuenta (ej. " +
            "falta de tiempo, no sabe que rutina hacer, falta de disciplina, intentos fallidos, no sabe de " +
            "nutricion, lesion, motivacion, dinero, u otro), (4) cuánto peso quiere perder (la cantidad tal " +
            "cual la haya dicho, ej. \"15 kg\", \"20 libras\", \"no especifica cantidad exacta\"), (5) un " +
            "detalle breve en UNA sola oración (máximo 20 palabras) explicando, en palabras propias, cómo le " +
            "afecta su situación o por qué quiere bajar de peso — combinando lo que haya dicho de salud y/o " +
            "estética en una frase legible y natural (esto es para un reporte que lea un humano, no para " +
            "agrupar categorías), (6) su EDAD (el número tal cual lo haya dicho, ej. \"45\"), (7) su PESO " +
            "ACTUAL (el número con su unidad tal cual lo haya dicho, ej. \"90 kg\", \"200 libras\"), y (8) el " +
            "PESO AL QUE LE GUSTARÍA LLEGAR / su peso objetivo (tal cual lo haya dicho, ej. \"75 kg\") — " +
            "nota: (7) y (8) son el peso actual y el peso meta como números concretos, distinto de (4) que " +
            "es la DIFERENCIA/cantidad a bajar; si el cliente solo dio la diferencia (ej. \"quiero bajar 15 " +
            "kilos\") sin decir su peso actual ni su meta como números, deja (7) y (8) en null.\n\n" +
            "Para los campos (1), (2) y (3): usa una etiqueta CORTA (1 a 3 palabras), en minúsculas, sin " +
            "acentos, y reutiliza la MISMA etiqueta que usarías para un caso similar en otra conversación " +
            "(para poder agruparlas después — ej. usa siempre \"cansancio\", no alternes entre " +
            "\"cansancio\"/\"cansado\"/\"fatiga\"). Para los campos (4) al (8), pueden ser frases " +
            "normales, no hace falta acortarlas a una etiqueta. Si algo no se menciona en la conversación, " +
            "usa null (no inventes ni asumas). Responde ÚNICAMENTE un JSON con este formato exacto, sin " +
            "texto adicional: " +
            '{"dolor_salud": "etiqueta o null", "dolor_estetico": "etiqueta o null", "obstaculo": "etiqueta o null", "peso_a_perder": "texto o null", "detalle": "oracion o null", "edad": "numero o null", "peso_actual": "texto o null", "peso_objetivo": "texto o null"}'
        },
        { role: "user", content: transcripcion }
      ]
    });

    const texto = resp.choices[0]?.message?.content?.trim();
    const parsed = JSON.parse(texto);
    return {
      dolor_salud: limpiarEtiquetaIA(parsed.dolor_salud),
      dolor_estetico: limpiarEtiquetaIA(parsed.dolor_estetico),
      obstaculo: limpiarEtiquetaIA(parsed.obstaculo),
      peso_a_perder: limpiarEtiquetaIA(parsed.peso_a_perder),
      detalle: limpiarEtiquetaIA(parsed.detalle),
      edad: limpiarEtiquetaIA(parsed.edad),
      peso_actual: limpiarEtiquetaIA(parsed.peso_actual),
      peso_objetivo: limpiarEtiquetaIA(parsed.peso_objetivo)
    };
  } catch (err) {
    console.error("⚠️ Error analizando dolores/obstáculos de una conversación:", err.response?.data || err.message);
    return { dolor_salud: null, dolor_estetico: null, obstaculo: null, peso_a_perder: null, detalle: null, edad: null, peso_actual: null, peso_objetivo: null };
  }
}

// A veces la IA responde con el TEXTO literal "null" (o "n/a", "ninguno")
// en vez del valor vacío real de JSON — sin este filtro, esa palabra se
// cuela como si fuera una categoría más en el reporte de dolores/obstáculos.
function limpiarEtiquetaIA(valor) {
  if (typeof valor !== "string") return null;
  const limpio = valor.trim();
  if (!limpio) return null;
  const normalizado = limpio.toLowerCase();
  if (["null", "none", "n/a", "ninguno", "ninguna", "no aplica", "no menciona", "no especifica"].includes(normalizado)) {
    return null;
  }
  return limpio;
}

// El historial que se guarda en Supabase incluye, para los audios y fotos ya
// enviados, el formato interno "[[audio]]url" / "[[imagen]]url" (así los
// puede reproducir /chats). El problema es que si ese historial se le manda
// TAL CUAL a la IA como contexto de la conversación, la IA lo copia — y
// termina escribiendo en su respuesta "[[audio]]https://..." (con la URL
// real) en vez de "[[audio:clave]]" como le pedimos en el prompt. Por eso a
// veces "se le olvida" el formato correcto: justo después de que ya se
// mandó un audio/foto en esa conversación. Esta función limpia esas entradas
// antes de mandarlas a OpenAI, dejando solo una nota humana de lo que pasó,
// sin URLs ni marcadores que la IA pueda imitar.
function sanitizarHistorialParaIA(historial) {
  return (historial || []).map((m) => {
    if (m.role === "assistant" && typeof m.content === "string") {
      if (m.content.startsWith("[[imagen]]")) {
        return { role: "assistant", content: "(Aquí se envió una foto.)" };
      }
      if (m.content.startsWith("[[audio]]")) {
        return { role: "assistant", content: "(Aquí se envió un audio.)" };
      }
    }
    return m;
  });
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
      const delay = segundosAleatorios(configActual.min_delay, configActual.max_delay);
      buffer.timer = setTimeout(() => procesarBuffer(senderId), delay);
    } else {
      buffers.delete(senderId);
    }
    return;
  }

  try {
    const conv = await obtenerConversacion(senderId);
    const historial = conv.historial || [];

    // Bot pausado PARA ESTE LEAD en particular (distinto del apagado
    // general): el admin decidió tomar esta conversación a mano desde
    // /chats. Se guarda igual el mensaje del cliente en el historial (para
    // no perder el registro ni el contexto si se reactiva más adelante),
    // pero no se genera ninguna respuesta automática ni se evalúan
    // transiciones — el admin responde manualmente.
    if (conv.bot_pausado) {
      console.log(`⏸️ Bot pausado para ${senderId}: se guarda el mensaje pero no se genera respuesta.`);
      await agregarAlHistorialDB(senderId, "user", mensajeCompleto);
      buffer.enProceso = false;
      if (buffer.mensajes.length > 0) {
        const delay = segundosAleatorios(configActual.min_delay, configActual.max_delay);
        buffer.timer = setTimeout(() => procesarBuffer(senderId), delay);
      } else {
        buffers.delete(senderId);
      }
      return;
    }

    // Etapa activa de esta conversación (si tiene alguna asignada). Mientras
    // el lead esté en una etapa, se usa el prompt propio de esa etapa en vez
    // del prompt general — así la IA solo "ve" el contexto de sí/no que le
    // corresponde a ese punto de la conversación, y no el de otras etapas.
    let etapaActualClave = conv.etapa || null;
    let etapaConfig = obtenerEtapaConfig(etapaActualClave);

    // Etapa de entrada: si el lead es completamente nuevo (nunca se le ha
    // asignado ninguna etapa y todavía no tiene historial) y hay una etapa
    // marcada como "entrada" en /panel, entra directo ahí — sin necesidad de
    // que ninguna palabra clave o condición coincida primero. Sirve para
    // arrancar el flujo siempre desde un punto fijo (ej. cuando ya sabes por
    // qué campaña/CTA llegó el lead) en vez de pasar por el prompt general.
    let entroPorEtapaDeEntrada = false;
    if (!etapaActualClave && historial.length === 0) {
      const etapaEntrada = (configActual.etapas || []).find(e => e.entrada);
      if (etapaEntrada) {
        console.log(`🚪 ${senderId} es un lead nuevo — entra directo a la etapa de entrada "${etapaEntrada.clave}".`);
        etapaActualClave = etapaEntrada.clave;
        etapaConfig = etapaEntrada;
        await guardarConversacion(senderId, { etapa: etapaActualClave });
        entroPorEtapaDeEntrada = true;
      }
    }

    // Transición GARANTIZADA de etapa por palabra clave (ver buscarTransicionActivada):
    // si el mensaje del cliente coincide con alguna frase configurada para la
    // etapa actual (o, si no hay ninguna etapa activa, con las transiciones
    // generales), se cambia de etapa por código ANTES de generar la respuesta
    // — así la respuesta ya sale con el prompt de la nueva etapa, sin
    // depender de que la IA decida poner el marcador [[etapa:...]].
    const listaTransiciones = etapaConfig ? (etapaConfig.transiciones || []) : (configActual.transiciones_generales || []);
    let transicion = buscarTransicionActivada(mensajeCompleto, listaTransiciones, conv.etiquetas);

    // Si ninguna transición por palabra clave coincidió, se revisan las de
    // tipo "condición" (más costosas, requieren una llamada a la IA) — así
    // las etapas que no usan este modo no pagan ese costo extra en cada mensaje.
    if (!transicion) {
      const transicionesCondicion = listaTransiciones.filter(t => t.coincidencia === "condicion" && t.condicion);
      if (transicionesCondicion.length > 0) {
        const elegirMejor = etapaConfig
          ? Boolean(etapaConfig.elegir_mejor_condicion)
          : Boolean(configActual.transiciones_generales_elegir_mejor);
        transicion = await evaluarTransicionesPorCondicion(mensajeCompleto, historial, transicionesCondicion, elegirMejor);
      }
    }

    let transicionAplicada = entroPorEtapaDeEntrada;

    // Si la transición que coincidió pide verificación con Calendly (el
    // lead dijo algo como "ya agendé"), se consulta EN VIVO si de verdad
    // existe esa reserva antes de creerle — en vez de aplicar la transición
    // a ciegas solo porque lo dijo. Si no se encuentra, se cancela la
    // transición (se sigue en la misma etapa) y se le pide al modelo, más
    // abajo, que pida confirmación del día y la hora en vez de asumir nada.
    let eventoCalendlyConfirmado = null;
    let timezoneInvitadoCalendly = null;
    let pedirConfirmacionCalendly = false;
    if (transicion?.verificar_calendly) {
      const resultado = await verificarReservaEnCalendly(conv.username);
      if (resultado.encontrado) {
        console.log(`✅ Calendly confirma la reserva de ${senderId} (@${conv.username}).`);
        eventoCalendlyConfirmado = resultado.event;
        timezoneInvitadoCalendly = resultado.timezoneInvitado;
      } else {
        console.log(`❌ No se encontró ninguna reserva en Calendly para ${senderId} (@${conv.username || "sin username"}): ${resultado.motivo}`);
        transicion = null; // no se aplica el cambio de etapa todavía
        pedirConfirmacionCalendly = true;
      }
    }

    if (transicion && transicion.etapa_destino !== (etapaActualClave || "")) {
      const nuevaEtapaConfig = transicion.etapa_destino ? obtenerEtapaConfig(transicion.etapa_destino) : null;
      if (transicion.etapa_destino === "" || nuevaEtapaConfig) {
        const origenTransicion = transicion.coincidencia === "condicion" ? "condición" : "palabra clave";
        console.log(`🧭 Transición automática (${origenTransicion}) de ${senderId}: "${etapaActualClave || "general"}" -> "${transicion.etapa_destino || "general"}"`);
        etapaActualClave = transicion.etapa_destino || null;
        etapaConfig = nuevaEtapaConfig;

        const camposTransicion = { etapa: etapaActualClave };

        // Etiqueta "NO CALIFICA": permanente, igual que "califica" pero en la
        // dirección contraria — se pone cuando el lead descarta explícitamente
        // un criterio duro (ej. dice tener menos de 40 años, o que quiere subir
        // de peso en vez de bajar). Sirve para poder excluir a estos leads de
        // los seguimientos automáticos (ver "no_seguir_si_no_califica" más abajo).
        if (transicion.no_califica) {
          console.log(`🚫 ${senderId} NO CALIFICA: ${transicion.motivo_no_califica || "(sin motivo especificado)"}`);
          camposTransicion.no_califica = true;
          camposTransicion.no_califica_en = new Date().toISOString();
          camposTransicion.razon_no_califica = transicion.motivo_no_califica || null;
        }

        // Etiqueta "AGENDÓ": se pone cuando el lead CONFIRMA que ya reservó
        // su espacio en el calendario (distinto de "enlace_enviado", que solo
        // significa que se le mandó el link, no que de verdad agendó). Sirve
        // para detener sus seguimientos — ya no tiene sentido seguir
        // empujándolo a agendar si ya lo hizo (ver "parar_seguimientos_si_agendo").
        if (transicion.agendo) {
          console.log(`📅 ${senderId} AGENDÓ — se detienen sus seguimientos (si esa opción está activada).`);
          camposTransicion.agendo = true;
          camposTransicion.agendo_en = eventoCalendlyConfirmado?.start_time || new Date().toISOString();
        }

        await guardarConversacion(senderId, camposTransicion);
        transicionAplicada = true;
      } else {
        console.warn(`⚠️ Una transición apunta a la etapa "${transicion.etapa_destino}" pero no existe (o se borró) en /panel. Se ignora.`);
      }
    }

    // Mensaje fijo al ENTRAR a una etapa: se manda tal cual, carácter por
    // carácter (con sus marcadores [[audio:..]] / [[foto:..]] / [[pausa:N]]
    // si los tiene), sin pasar por la IA en absoluto — a diferencia del
    // prompt normal, esto es 100% garantizado, útil para mensajes donde
    // necesitas control total del texto exacto (ej. con errores intencionales
    // o un guion muy específico). Si hay varias variantes configuradas (ej.
    // 10 casos de éxito distintos), rotan de forma GLOBAL entre todos los
    // leads que entren a la etapa, para no repetir siempre la misma.
    // Tiene prioridad sobre "silenciosa": si la etapa de destino tiene
    // mensajes fijos configurados, se manda uno de esos, independientemente
    // de cómo esté marcada la transición.
    let mensajeFijoEtapa = null;
    let indiceMensajeFijo = -1;
    if (transicionAplicada && etapaConfig?.mensajes_fijos?.length > 0) {
      const totalVariantes = etapaConfig.mensajes_fijos.length;
      indiceMensajeFijo = await obtenerYAvanzarRotacionEntrada(etapaConfig.clave, totalVariantes);
      mensajeFijoEtapa = etapaConfig.mensajes_fijos[indiceMensajeFijo] || null;
    }

    if (mensajeFijoEtapa) {
      await agregarAlHistorialDB(senderId, "user", mensajeCompleto);
      console.log(`📌 Enviando mensaje fijo (variante ${indiceMensajeFijo + 1}/${etapaConfig.mensajes_fijos.length}) de la etapa "${etapaConfig.clave}" a ${senderId} (sin pasar por la IA).`);
      await enviarContenidoConMarcadores(senderId, mensajeFijoEtapa);
    } else if (transicionAplicada && transicion?.silenciosa) {
      // Transición "silenciosa": solo cambia de etapa y NO genera ni manda
      // ninguna respuesta en este mensaje (ni siquiera un audio/foto por
      // disparador). Útil sobre todo para transiciones evaluadas por IA
      // ("condición"), donde la etapa de destino no tiene contexto de lo que
      // el cliente acaba de decir y generar una respuesta ahí mismo suele salir
      // desconectado de la conversación. El mensaje del cliente sí se guarda en
      // el historial, para que la IA tenga contexto la próxima vez que responda.
      await agregarAlHistorialDB(senderId, "user", mensajeCompleto);
      console.log(`🔇 Transición silenciosa aplicada para ${senderId} — no se genera respuesta en este mensaje.`);
    } else {

    // Disparadores automáticos: si el mensaje del cliente contiene alguna de
    // las palabras/frases configuradas, se manda el audio/foto/mensaje
    // correspondiente de forma GARANTIZADA — sin depender de que la IA haya
    // decidido incluir el marcador en su respuesta. Primero se revisan los
    // disparadores propios de la ETAPA activa (si el lead tiene una); solo si
    // ninguno de esos coincide, se cae a revisar los disparadores GENERALES
    // de /panel. Se calculan ANTES de llamar a la IA para poder detectar si
    // alguno es "exclusivo" (ver más abajo).
    const disparadoresDeEtapa = etapaConfig ? (etapaConfig.disparadores || []) : [];
    let disparadoresActivados = buscarDisparadoresActivados(mensajeCompleto, disparadoresDeEtapa, conv.etiquetas);
    let disparadoresSonDeEtapa = disparadoresActivados.length > 0;

    if (!disparadoresSonDeEtapa) {
      disparadoresActivados = buscarDisparadoresActivados(mensajeCompleto, configActual.disparadores || [], conv.etiquetas);
    }

    // Un disparador marcado "solo al entrar a la etapa" NUNCA se activa en
    // mensajes posteriores dentro de la MISMA etapa — esto es clave para los
    // que usan coincidencia "por etiqueta": como la etiqueta es permanente
    // (nunca se quita sola), sin este filtro se dispararía en CADA mensaje
    // que el lead mande mientras esté en esa etapa (ej. mandando el mismo
    // recurso una y otra vez cada vez que dijera "gracias"). Con esto, solo
    // se activa en el turno exacto en el que se entró a la etapa.
    disparadoresActivados = disparadoresActivados.filter(d => !d.solo_al_entrar_a_etapa || transicionAplicada);

    const origenLog = disparadoresSonDeEtapa ? `etapa "${etapaConfig?.clave}"` : "general";
    const disparadorExclusivo = disparadoresActivados.find(d => d.exclusivo);

    if (disparadorExclusivo) {
      // Disparador "exclusivo": reemplaza por completo la respuesta de este
      // turno — la IA NO responde nada, solo se manda el contenido de este
      // disparador. El mensaje del cliente sí se guarda en el historial,
      // para que la IA tenga contexto la próxima vez que responda con su
      // prompt normal (ej. si el lead sigue preguntando cosas después).
      await agregarAlHistorialDB(senderId, "user", mensajeCompleto);
      console.log(`🎯 Disparador EXCLUSIVO (${origenLog}) activado para ${senderId} — se manda solo este disparador, el prompt no responde este turno.`);
      await enviarDisparador(senderId, disparadorExclusivo, origenLog);
    } else {

    const promptPropio = etapaConfig ? etapaConfig.prompt : configActual.ai_prompt;
    // Las "reglas generales" se anteponen SIEMPRE (prompt general y cada
    // etapa), para que el bot no pierda de vista quién es, su objetivo y qué
    // NO debe hacer solo porque entró a una etapa con un prompt muy acotado
    // (ej. una etapa que solo pregunta la edad no debería, por eso, ponerse a
    // dar rutinas de ejercicio si el lead pregunta algo fuera de tema).
    const reglasGenerales = configActual.contexto_base?.trim();
    let promptSistema = reglasGenerales ? `${reglasGenerales}\n\n${promptPropio}` : promptPropio;

    // Si el lead dijo que ya agendó pero la verificación en vivo con
    // Calendly (arriba) NO encontró ninguna reserva a su nombre, se le
    // agrega esta nota SOLO en este turno — para que el modelo no le crea a
    // ciegas y en vez de eso pida que confirme el día y la hora exactos que
    // eligió, de forma natural (no como un interrogatorio ni acusándolo de
    // mentir, puede ser simplemente un error de sincronización).
    if (pedirConfirmacionCalendly) {
      promptSistema += `\n\nNOTA IMPORTANTE PARA ESTE MENSAJE: el cliente acaba de decir que ya agendó su llamada, pero nuestro sistema NO encuentra ninguna reserva confirmada a su nombre en el calendario en este momento. NO le digas que no encuentras nada ni que "el sistema no lo detecta" (suena robótico y desconfiado) — en vez de eso, de forma cálida y natural, pídele que te confirme qué día y hora eligió, como si quisieras anotarlo tú mismo para tenerlo presente. Si te da el día y la hora, no hace falta que sigas insistiendo en este mensaje.`;
    }

    // Si Calendly SÍ confirmó la reserva, se le pasa a la IA el día y la
    // hora reales del evento — EN LA ZONA HORARIA DEL PROPIO LEAD (la que
    // Calendly detectó cuando reservó), no en la de Roberto, para que la
    // hora que mencione el bot sea la misma que el lead ya vio confirmada
    // en su correo/calendario. Si por lo que sea Calendly no trae esa zona
    // horaria, se usa la de México como respaldo razonable.
    if (eventoCalendlyConfirmado?.start_time) {
      const zonaHoraria = timezoneInvitadoCalendly || "America/Mexico_City";
      let fechaEvento;
      try {
        fechaEvento = new Date(eventoCalendlyConfirmado.start_time).toLocaleString("es-MX", {
          weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true,
          timeZone: zonaHoraria
        });
      } catch (err) {
        // Por si Calendly mandara alguna vez una zona horaria con un
        // nombre no reconocido por Node — se cae a México en vez de tronar.
        console.error(`⚠️ Zona horaria de Calendly no reconocida ("${zonaHoraria}"), se usa México como respaldo:`, err.message);
        fechaEvento = new Date(eventoCalendlyConfirmado.start_time).toLocaleString("es-MX", {
          weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true,
          timeZone: "America/Mexico_City"
        });
      }
      promptSistema += `\n\nNOTA IMPORTANTE PARA ESTE MENSAJE: Calendly confirmó que la llamada del cliente quedó agendada para: ${fechaEvento} (hora del propio cliente). Puedes mencionar este día y hora de forma natural en tu respuesta (ej. para confirmarle o recordárselo), no hace falta que se lo repitas palabra por palabra, solo que quede claro que sabes cuándo es.`;
    }

    // El PRIMER mensaje real de este lead se guarda aparte (no depende del
    // historial reciente, que se recorta con el tiempo) — se le pasa a la
    // IA como referencia siempre disponible, para etapas que necesiten
    // saber cómo empezó la conversación (ej. "no califica", que necesita
    // identificar qué lead magnet pidió al inicio) sin arriesgarse a que
    // ese mensaje ya no esté visible en el historial reciente.
    if (conv.primer_mensaje_texto) {
      promptSistema += `\n\nCONTEXTO: el PRIMER mensaje que este lead mandó, el que inició toda esta conversación, fue textualmente: "${conv.primer_mensaje_texto}". Úsalo como referencia cuando necesites saber cómo empezó todo esto (ej. qué recurso pidió), aunque ya no aparezca en los mensajes recientes de abajo.`;
    }

    if (etapaConfig) {
      console.log(`🧭 ${senderId} está en la etapa "${etapaConfig.clave}" — se usa su prompt propio.`);
    }

    const completion = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: promptSistema },
        ...sanitizarHistorialParaIA(historial),
        { role: "user", content: mensajeCompleto }
      ],
      max_tokens: 300,
      temperature: 0.7
    });

    let respuestaCruda = completion.choices[0]?.message?.content?.trim();

    // Red de seguridad a nivel de código: si la etapa está marcada como
    // "requiere pregunta final" (ver casilla en el panel) y la respuesta NO
    // trae ningún signo de interrogación, se le pide a la IA que la
    // reescriba UNA vez incluyendo la pregunta obligatoria — esto es porque
    // en la práctica, solo con instrucciones de prompt (por más reforzadas
    // que estén) el modelo a veces sigue omitiendo la pregunta final,
    // especialmente cuando la explicación previa ya "se siente completa".
    // No se hace si la respuesta es [[silencio]] (ahí no hace falta ninguna
    // pregunta, esa etapa decidió no responder nada).
    if (
      etapaConfig?.requiere_pregunta_final &&
      respuestaCruda &&
      respuestaCruda.trim() !== "[[silencio]]" &&
      !respuestaCruda.includes("?")
    ) {
      console.warn(`⚠️ ${senderId}: la etapa "${etapaConfig.clave}" requiere pregunta final pero la respuesta no la incluyó. Reintentando una vez con un recordatorio...`);
      try {
        const reintento = await openaiClient.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: promptSistema },
            ...sanitizarHistorialParaIA(historial),
            { role: "user", content: mensajeCompleto },
            { role: "assistant", content: respuestaCruda },
            { role: "user", content: "IMPORTANTE: tu respuesta anterior no incluyó la pregunta final obligatoria que esta etapa requiere. Vuelve a escribir la respuesta completa desde cero (no solo agregues la pregunta al final de lo anterior), asegurándote de terminar SIEMPRE con esa pregunta, en su propia burbuja separada con [[pausa:N]] antes, y usando únicamente el signo de interrogación de cierre (\"?\")." }
          ],
          max_tokens: 300,
          temperature: 0.7
        });
        const respuestaReintentada = reintento.choices[0]?.message?.content?.trim();
        if (respuestaReintentada) {
          console.log(`🔁 ${senderId}: respuesta corregida con la pregunta final incluida: "${respuestaReintentada}"`);
          respuestaCruda = respuestaReintentada;
        }
      } catch (err) {
        console.error(`❌ Error en el reintento de pregunta final para ${senderId}:`, err.response?.data || err.message);
        // Si el reintento falla, se sigue con la respuesta original — es
        // mejor mandar algo (aunque le falte la pregunta) que no responder.
      }
    }

    let partesRespuestaIA = [];
    if (respuestaCruda) {
      console.log(`🤖 Respuesta IA (cruda): "${respuestaCruda}"`);

      await agregarAlHistorialDB(senderId, "user", mensajeCompleto);

      // Si el modelo decide que la conversación ya llegó a un cierre natural
      // (ej. "gracias" -> "de nada" -> "vale gracias" ...) puede responder
      // ÚNICAMENTE con [[silencio]] — esto le indica al sistema que NO hay
      // que mandar ningún mensaje esta vez, igual que haría una persona
      // real, que no sigue respondiendo indefinidamente a un intercambio de
      // cortesías ya cerrado (evita el bucle de "gracias"/"de nada" sin fin).
      // El mensaje del cliente igual queda guardado en el historial arriba,
      // solo se omite la respuesta del bot.
      if (respuestaCruda.trim() === "[[silencio]]") {
        console.log(`🤫 ${senderId}: la IA decidió no responder (conversación ya cerrada con cortesías, evitando un bucle sin fin).`);
      } else {
      partesRespuestaIA = parsearPartes(respuestaCruda);

      // Si el prompt decide mandar la respuesta en varias burbujas (con
      // [[pausa:N]]), incluir un audio/foto pregrabada ([[audio:clave]] /
      // [[foto:clave]]) o cambiar de etapa ([[etapa:clave]]), este helper lo
      // detecta, aplica cada parte por su lado en orden (respetando las
      // pausas) y devuelve el texto real que se mandó, para la detección del
      // enlace de calificación más abajo.
      const textoAEnviar = await enviarContenidoConMarcadores(senderId, respuestaCruda);

      console.log(`✅ Respondido a ${senderId} (una sola respuesta por ${mensajesAResponder.length} línea(s))`);

      // Detección del enlace de calificación (calendario/formulario): el propio
      // prompt es el que decide mandarlo cuando el lead ya cumplió las etapas.
      // Aquí solo lo detectamos dentro del texto que se acaba de enviar.
      // "enlace_enviado" es la etiqueta PERMANENTE (para filtrar/exportar en
      // /chats, nunca se apaga). "enlace_pasos_enviados" se reinicia a 0 para
      // arrancar de nuevo el seguimiento especial completo — que se mantiene
      // activo aunque el lead responda algo en el medio, hasta que se manden
      // TODOS los pasos configurados (ver programarSeguimientosDB).
      if (configActual.enlace_calificacion?.trim() && textoAEnviar.includes(configActual.enlace_calificacion.trim())) {
        console.log(`🔗 Enlace de calificación detectado en la respuesta a ${senderId}. Se marca (permanente) y arranca el seguimiento especial completo.`);
        const camposEnlace = {
          enlace_enviado: true,
          enlace_enviado_en: new Date().toISOString(),
          enlace_pasos_enviados: 0
        };

        // Calificación automática y 100% determinista (sin IA): si tu flujo
        // de etapas ya está diseñado para que solo se llegue a mandar este
        // enlace cuando el lead realmente calificó (y si no califica, se le
        // manda otra cosa — ej. un lead magnet — y no se le manda esto),
        // entonces el propio envío del enlace ES la señal de calificación.
        // Esto evita depender de que la IA vuelva a evaluar los criterios
        // por su cuenta (que puede ser inconsistente entre leads similares).
        if (configActual.calificar_automatico_con_enlace) {
          const convParaCalificar = await obtenerConversacion(senderId);
          if (!convParaCalificar.califica) {
            console.log(`🏷️ ${senderId} CALIFICA automáticamente: se le mandó el enlace de calendario/formulario.`);
            camposEnlace.califica = true;
            camposEnlace.calificado_en = new Date().toISOString();
            camposEnlace.razon_calificacion = "Se le mandó el enlace de calendario/formulario (calificación automática, sin evaluar criterios por IA).";
          }
        }

        await guardarConversacion(senderId, camposEnlace);
      }
      } // fin del "else" de [[silencio]]
    }

    // Se mandan todos los disparadores activados (ya calculados arriba). Si
    // la IA ya incluyó ese mismo audio/foto por su cuenta (solo aplica a
    // audio/foto simples, no al tipo "mensaje"), no se repite.
    for (const disparador of disparadoresActivados) {
      if (disparador.tipo !== "mensaje" && partesIncluyenMedia(partesRespuestaIA, disparador.tipo, disparador.clave)) {
        console.log(`ℹ️ Disparador "${disparador.clave}" activado por palabra clave, pero la IA ya lo mandó por su cuenta — se omite duplicado.`);
        continue;
      }
      await enviarDisparador(senderId, disparador, origenLog);
    }

    } // fin del "else" de disparador exclusivo

    } // fin del "else" de transición silenciosa

    // Calificación automática POR CRITERIOS (evaluados por IA): vive FUERA de
    // la cadena de arriba (mensaje fijo / silenciosa / respuesta normal) a
    // propósito — así se evalúa SIEMPRE que el cliente escribe algo, sin
    // importar qué camino tomó la respuesta ese turno. Antes vivía adentro
    // de la rama de "respuesta normal", lo que causaba que se saltara por
    // completo cuando el mensaje disparaba una transición silenciosa o caía
    // en una etapa con mensaje fijo (ej. un obstáculo que cae en la
    // transición "otro" con mensaje fijo configurado) — el lead podía dar
    // una respuesta que sí calificaba, pero nunca se llegaba a evaluar.
    // Solo si está activada, hay criterios definidos, esta conversación
    // todavía no había calificado antes, y NO se está usando ya la
    // calificación automática por enlace (si esa está activa, tiene
    // prioridad — es más confiable porque no depende de que la IA
    // interprete la conversación).
    if (!configActual.calificar_automatico_con_enlace && configActual.calificacion_activa && configActual.criterios_calificacion?.trim()) {
      const convActualizada = await obtenerConversacion(senderId);
      if (!convActualizada.califica) {
        const evaluacion = await evaluarCalificacion(convActualizada.historial || [], configActual.criterios_calificacion);
        if (evaluacion?.califica) {
          console.log(`🏷️ ${senderId} CALIFICA: ${evaluacion.razon}`);
          await guardarConversacion(senderId, {
            califica: true,
            calificado_en: new Date().toISOString(),
            razon_calificacion: evaluacion.razon || null
          });
        }
      }
    }
  } catch (err) {
    console.error(`❌ Error al responder:`, err.response?.data || err.message);
  }

  buffer.enProceso = false;

  if (buffer.mensajes.length > 0) {
    const delay = segundosAleatorios(configActual.min_delay, configActual.max_delay);
    buffer.timer = setTimeout(() => procesarBuffer(senderId), delay);
  } else {
    buffers.delete(senderId);
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

  const delay = segundosAleatorios(configActual.min_delay, configActual.max_delay);
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
      if (!senderId) {
        console.log(`❓ Evento sin sender.id reconocible (se ignora). Evento completo: ${JSON.stringify(event)}`);
        continue;
      }

      // Evento de "visto" (read receipt): Instagram manda esto cuando el
      // cliente abre el chat y lee los mensajes. A diferencia de Messenger
      // (que manda un "watermark" — un timestamp de hasta dónde se leyó),
      // Instagram manda "read.mid" (el ID del mensaje leído), SIN watermark
      // — confirmado revisando el payload real que Instagram manda. En vez
      // de rastrear IDs exactos de cada mensaje que mandamos (mucho más
      // complejo), se usa el timestamp del propio evento como el momento
      // en que "ya vio todo hasta aquí" — es una buena aproximación: cuando
      // alguien abre el chat y lo lee, normalmente ve todos los mensajes
      // recientes, no solo uno en particular. Se guarda para que los
      // seguimientos con "solo si está visto" (ver
      // procesarSeguimientosPendientesDB) puedan comparar si el cliente ya
      // vio el último mensaje que le mandó el bot antes de mandarle el
      // siguiente seguimiento.
      if (event.read) {
        const vistoHasta = new Date(Number(event.timestamp)).toISOString();
        await guardarConversacion(senderId, { visto_hasta: vistoHasta });
        console.log(`👁️ ${senderId} vio los mensajes hasta ${vistoHasta} (read.mid: ${event.read.mid || "sin mid"})`);
        continue;
      }

      const mensajeTexto = event.message?.text;
      let mensaje = mensajeTexto;

      if (!mensaje) {
        if (event.message?.is_echo) continue;

        // Si lo que mandó el cliente es un audio (mensaje de voz), se
        // transcribe con IA y se trata exactamente igual que si lo hubiera
        // escrito — Instagram no manda ninguna transcripción propia por la
        // API, así que hay que hacerla nosotros mismos.
        const adjuntoAudio = event.message?.attachments?.find(a => a.type === "audio" && a.payload?.url);

        if (adjuntoAudio) {
          const msgId = event.message?.mid;
          if (msgId && yaRespondidos.has(msgId)) continue;
          if (msgId) yaRespondidos.add(msgId);

          console.log(`🎤 Audio recibido de ${senderId}, transcribiendo...`);
          const textoTranscrito = await transcribirAudioDeInstagram(adjuntoAudio.payload.url);

          if (!textoTranscrito) {
            console.warn(`⚠️ No se pudo transcribir el audio de ${senderId} — se le avisa y se le pide que lo mande de nuevo.`);
            const listaMensajesError = (configActual.mensajes_error_audio?.length > 0) ? configActual.mensajes_error_audio : MENSAJES_ERROR_AUDIO_DEFECTO;
            const mensajeError = listaMensajesError[Math.floor(Math.random() * listaMensajesError.length)];
            await agregarAlHistorialDB(senderId, "assistant", mensajeError);
            await enviarMensajeInstagram(senderId, mensajeError);
            continue;
          }

          // El emoji 🎤 al frente es solo para que se distinga en /chats que
          // este mensaje vino de un audio transcrito, no escrito — no afecta
          // en nada la detección de disparadores/transiciones (que buscan la
          // frase en cualquier parte del mensaje).
          mensaje = `🎤 ${textoTranscrito}`;
          console.log(`🎤 Audio de ${senderId} transcrito: "${textoTranscrito}"`);
        } else {
          // No es texto, ni audio, ni un adjunto reconocido — podría ser una
          // foto/video/reel compartido, o podría ser un evento de "visto"
          // que llegó en una forma distinta a la esperada (event.read.watermark)
          // y por eso no se detectó arriba. Se registra el evento COMPLETO
          // siempre (no solo cuando hay adjuntos), para poder diagnosticar
          // qué es exactamente lo que Instagram está mandando en estos casos.
          console.log(`❓ Evento sin texto/audio reconocido de ${senderId}. Evento completo: ${JSON.stringify(event)}`);
          continue;
        }
      } else {
        if (event.message?.is_echo) {
          const midEcho = event.message?.mid;
          if (esMidDelBot(midEcho)) continue; // es el propio bot — ya se guardó al mandarlo

          // IMPORTANTE: en los eventos de "echo" (mensajes SALIENTES),
          // Instagram invierte sender/recipient respecto a un mensaje
          // normal entrante — "sender" es la propia cuenta de negocio (tu
          // cuenta), y "recipient" es el cliente al que se le mandó. Usar
          // "senderId" (que arriba se toma de event.sender.id) aquí sería
          // guardar el mensaje bajo TU PROPIO ID en vez del ID del lead
          // real — hay que usar recipient.id en este caso específico.
          const clienteDestino = event.recipient?.id;
          if (!clienteDestino) continue;

          // No es un mid que el bot haya mandado — es un mensaje que se
          // escribió A MANO directo desde la app de Instagram (o el sitio
          // web), sin pasar por el bot ni por el envío manual de /chats.
          // Se registra igual, para que la conversación en /chats quede
          // completa con todo lo que se le mandó al lead, sin importar
          // desde dónde se haya mandado.
          if (midEcho && yaRespondidos.has(midEcho)) continue;
          if (midEcho) yaRespondidos.add(midEcho);

          console.log(`📱 Mensaje manual detectado (mandado directo desde Instagram, no por el bot) a ${clienteDestino}: "${mensajeTexto}"`);
          await agregarAlHistorialDB(clienteDestino, "assistant", mensajeTexto);
          // Ya hubo respuesta humana (mandada directo desde la app) — se
          // cancelan los seguimientos automáticos pendientes, igual que
          // cuando se responde manualmente desde /chats.
          await cancelarSeguimientosPendientesDB(clienteDestino);
          continue;
        }
        const msgId = event.message?.mid;
        if (msgId && yaRespondidos.has(msgId)) continue;
        if (msgId) yaRespondidos.add(msgId);
      }

      console.log(`📨 Mensaje recibido de ${senderId}: "${mensaje}" (esperando a ver si manda más líneas...)`);

      await registrarMensajeUsuario(senderId, mensaje);
      await cancelarSeguimientosPendientesDB(senderId);
      // Nota: si el lead ya tiene el seguimiento especial del enlace en
      // curso, NO se apaga aquí por responder — programarSeguimientosDB lo
      // vuelve a programar automáticamente cuando el buffer termine, y solo
      // cambia a seguimiento normal una vez que ya se mandaron todos los
      // pasos configurados del enlace.

      encolarMensaje(senderId, mensaje);
    }
  }
});

// Se llama desde el botón "Conectar Calendly" en /panel — usa el token que
// ya guardaste para crear la suscripción del webhook automáticamente, sin
// que tengas que hacerlo a mano con curl.
app.post("/calendly/conectar", requireAdminKey, async (req, res) => {
  try {
    if (!configActual.calendly_token?.trim()) {
      return res.status(400).json({ error: "Primero guarda tu Personal Access Token de Calendly." });
    }

    const urlCallback = `${req.protocol}://${req.get("host")}/webhook/calendly`;
    const { webhookUri, organizationUri } = await crearWebhookCalendly(urlCallback);

    await guardarConfigDB({
      calendly_webhook_uri: webhookUri || "",
      calendly_organization_uri: organizationUri || "",
      calendly_conectado_en: new Date().toISOString()
    });

    res.json({ ok: true, webhookUri });
  } catch (err) {
    console.error("❌ Error conectando con Calendly:", err.response?.data || err.message);
    const detalle = err.response?.data?.message || err.response?.data?.title || err.message;
    res.status(500).json({ error: "No se pudo conectar con Calendly: " + detalle });
  }
});

// Recibe el aviso de Calendly cada vez que alguien reserva. Hace coincidir
// la reserva con la conversación correcta usando la respuesta a la pregunta
// personalizada de Instagram, y marca esa conversación como "AGENDÓ" — de
// forma verificada, no solo porque el lead lo haya dicho en el chat.
app.post("/webhook/calendly", async (req, res) => {
  res.sendStatus(200); // Calendly espera una respuesta rápida, igual que Meta

  try {
    const body = req.body || {};
    if (body.event !== "invitee.created") return;

    const payload = body.payload || {};
    const preguntaConfigurada = configActual.calendly_pregunta_instagram?.trim();
    const preguntasYRespuestas = payload.questions_and_answers || [];

    let respuestaInstagram = null;
    if (preguntaConfigurada) {
      const encontrada = preguntasYRespuestas.find(qa => qa.question?.trim() === preguntaConfigurada);
      respuestaInstagram = encontrada?.answer || null;
    }

    // Si no se encontró por coincidencia exacta de la pregunta (ej. el texto
    // configurado no quedó idéntico al de Calendly), se deja un registro
    // completo del payload para poder revisar y ajustar el texto exacto.
    if (!respuestaInstagram) {
      console.warn(`⚠️ No se encontró la respuesta de Instagram en una reserva de Calendly. Pregunta configurada: "${preguntaConfigurada}". Preguntas recibidas: ${JSON.stringify(preguntasYRespuestas)}`);
      return;
    }

    const senderId = await buscarSenderIdPorUsername(respuestaInstagram);
    if (!senderId) {
      console.warn(`⚠️ Reserva de Calendly de @${respuestaInstagram} — no se encontró ninguna conversación con ese username en el bot.`);
      return;
    }

    console.log(`📅 Calendly confirma que @${respuestaInstagram} (${senderId}) agendó una llamada — se marca como AGENDÓ.`);
    await guardarConversacion(senderId, {
      agendo: true,
      agendo_en: payload.event?.start_time || new Date().toISOString()
    });
  } catch (err) {
    console.error("❌ Error procesando webhook de Calendly:", err.response?.data || err.message);
  }
});

app.get("/", (req, res) => {
  res.redirect("/login");
});

// Ícono de la app (aparece en la pestaña del navegador, ej. en /panel)
app.get("/favicon.svg", (req, res) => {
  res.type("image/svg+xml").send(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#12141A"/>
  <path fill="#C9FF3E" d="M16 18h32a6 6 0 0 1 6 6v14a6 6 0 0 1-6 6H30l-10 8v-8h-4a6 6 0 0 1-6-6V24a6 6 0 0 1 6-6z"/>
  <circle cx="26" cy="31" r="2.6" fill="#12141A"/>
  <circle cx="34" cy="31" r="2.6" fill="#12141A"/>
  <circle cx="42" cy="31" r="2.6" fill="#12141A"/>
</svg>
  `.trim());
});

app.get("/cron/seguimientos", async (req, res) => {
  try {
    const resultado = await procesarSeguimientosPendientesDB();
    res.json({ status: "ok", ...resultado, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error("❌ Error en /cron/seguimientos:", err.message);
    res.status(500).json({ status: "error", error: err.message });
  }
});

app.get("/privacy", (req, res) => {
  res.type("html").send(`
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Política de Privacidad — Instagram AI Responder</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${FUENTES_HTML}
${estilosBase()}
<style>
  .content-area.standalone{ margin-left:0; display:flex; justify-content:center; padding:60px 24px 90px; }
</style>
</head>
<body>
  <div class="content-area standalone">
  <div class="main" style="max-width:760px;">
    <p class="page-eyebrow">Instagram AI Responder</p>
    <h1 class="page-title">Política de Privacidad</h1>
    <p class="page-sub">Última actualización: ${new Date().toLocaleDateString("es-MX")}</p>

    <div class="card">
      <p>Esta aplicación ("Instagram AI Responder") es una herramienta de uso privado que
      automatiza respuestas a mensajes directos (DM) recibidos en la cuenta de Instagram
      conectada, utilizando inteligencia artificial (OpenAI).</p>
    </div>

    <div class="card">
      <h2>Datos que procesamos</h2>
      <p>Procesamos el contenido de los mensajes directos recibidos, el identificador
      de Instagram del remitente, y el historial de la conversación (guardado en una
      base de datos para poder dar seguimiento y continuidad a la conversación),
      únicamente con el fin de generar y enviar respuestas automáticas relevantes.
      No compartimos esta información con terceros, salvo el envío del texto del
      mensaje al proveedor de IA (OpenAI) para generar la respuesta.</p>
    </div>

    <div class="card">
      <h2>Uso de terceros</h2>
      <p>Utilizamos la API de OpenAI para generar las respuestas automáticas, y una
      base de datos (Supabase) para almacenar el historial de conversación de forma
      segura. Consulta las políticas de privacidad de cada proveedor para más
      información sobre cómo procesan los datos que reciben.</p>
    </div>

    <div class="card">
      <h2>Contacto</h2>
      <p>Para dudas sobre esta política, contáctanos en: <a href="mailto:rperezro23@gmail.com">rperezro23@gmail.com</a></p>
    </div>
  </div>
  </div>
</body>
</html>
  `);
});

app.get("/data-deletion", (req, res) => {
  res.type("html").send(`
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eliminación de Datos — Instagram AI Responder</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${FUENTES_HTML}
${estilosBase()}
<style>
  .content-area.standalone{ margin-left:0; display:flex; justify-content:center; padding:60px 24px 90px; }
</style>
</head>
<body>
  <div class="content-area standalone">
  <div class="main" style="max-width:760px;">
    <p class="page-eyebrow">Instagram AI Responder</p>
    <h1 class="page-title">Eliminación de Datos</h1>
    <p class="page-sub">Instrucciones para solicitar la eliminación de tus datos</p>

    <div class="card">
      <p>Si deseas solicitar la eliminación de cualquier dato asociado a tu cuenta de
      Instagram que haya sido procesado por esta app (incluyendo el historial de
      conversación guardado), envía tu solicitud a:
      <a href="mailto:rperezro23@gmail.com">rperezro23@gmail.com</a>, indicando tu
      nombre de usuario de Instagram. Procesaremos tu solicitud en un plazo máximo
      de 30 días.</p>
    </div>
  </div>
  </div>
</body>
</html>
  `);
});

// --- ENDPOINTS DE DIAGNÓSTICO ---

app.get("/check-subscription", requireAdminKey, async (req, res) => {
  try {
    const cuenta = await obtenerCuentaActiva();
    if (!cuenta) return res.status(404).json({ error: "No hay cuenta conectada" });
    const response = await axios.get(
      `https://graph.instagram.com/v25.0/${cuenta.ig_id}/subscribed_apps`,
      { headers: { "Authorization": `Bearer ${cuenta.access_token}` } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json(err.response?.data || { error: err.message });
  }
});

app.get("/force-subscribe", requireAdminKey, async (req, res) => {
  try {
    const cuenta = await obtenerCuentaActiva();
    if (!cuenta) return res.status(404).json({ error: "No hay cuenta conectada" });
    const response = await axios.post(
      `https://graph.instagram.com/v25.0/${cuenta.ig_id}/subscribed_apps`,
      null,
      {
        params: { subscribed_fields: "messages" },
        headers: { "Authorization": `Bearer ${cuenta.access_token}` }
      }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json(err.response?.data || { error: err.message });
  }
});

app.get("/historial/:senderId", requireAdminKey, async (req, res) => {
  const conv = await obtenerConversacion(req.params.senderId);
  res.json(conv);
});

// Historial COMPLETO y paginado de una conversación, para el scroll hacia
// atrás en /chats (a diferencia de /historial/:senderId, que solo devuelve
// el "historial" recortado que usa la IA como contexto). Sin el parámetro
// "antes", devuelve la página más reciente; con "antes" (un timestamp ISO),
// devuelve la página de mensajes inmediatamente anterior a esa fecha —
// así el front puede ir pidiendo "más para atrás" según el usuario haga scroll.
app.get("/historial-paginado/:senderId", requireAdminKey, async (req, res) => {
  try {
    const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 30, 1), 100);
    const antes = req.query.antes;

    let query = supabase
      .from("mensajes_chat")
      .select("*")
      .eq("sender_id", req.params.senderId)
      .order("creado_en", { ascending: false })
      .limit(limite);

    if (antes) query = query.lt("creado_en", antes);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Se pide en orden descendente (más nuevo primero) para poder limitar
    // fácil a los últimos N, pero se devuelve en orden ascendente (más viejo
    // primero) que es como se pintan los mensajes en el chat.
    const mensajes = (data || []).reverse();
    const hayMasAntiguos = (data || []).length === limite;

    res.json({ mensajes, hay_mas_antiguos: hayMasAntiguos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resumen de todas las conversaciones (usado por /chats para la lista de la izquierda).
// Solo trae lo necesario para pintar la lista: último mensaje, quién lo mandó y cuándo.
app.get("/conversaciones", requireAdminKey, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("conversaciones")
      .select("sender_id, historial, ultimo_mensaje_usuario, actualizado_en, califica, calificado_en, razon_calificacion, no_califica, no_califica_en, razon_no_califica, agendo, agendo_en, enlace_enviado, enlace_enviado_en, enlace_pasos_enviados, etapa, etiquetas, monto_pagado, bot_pausado")
      .order("actualizado_en", { ascending: false })
      .limit(200);

    if (error) return res.status(500).json({ error: error.message });

    const totalPasosEnlace = (configActual.seguimientos_enlace || []).length;

    const resumen = await Promise.all((data || []).map(async (c) => {
      const historial = Array.isArray(c.historial) ? c.historial : [];
      const ultimo = historial.length > 0 ? historial[historial.length - 1] : null;
      const perfil = await obtenerPerfilInstagram(c.sender_id);

      const enVentana24h = c.ultimo_mensaje_usuario
        ? (Date.now() - new Date(c.ultimo_mensaje_usuario).getTime()) < VENTANA_24H_MS
        : false;

      const pasosEnviados = c.enlace_pasos_enviados || 0;
      const etapaConfig = obtenerEtapaConfig(c.etapa);

      return {
        sender_id: c.sender_id,
        username: perfil?.username || null,
        profile_pic: perfil?.profile_pic || null,
        ultimo_mensaje_usuario: c.ultimo_mensaje_usuario,
        actualizado_en: c.actualizado_en,
        ultimo_texto: ultimo ? ultimo.content : null,
        ultimo_role: ultimo ? ultimo.role : null,
        en_ventana_24h: enVentana24h,
        califica: Boolean(c.califica),
        calificado_en: c.calificado_en || null,
        razon_calificacion: c.razon_calificacion || null,
        no_califica: Boolean(c.no_califica),
        no_califica_en: c.no_califica_en || null,
        razon_no_califica: c.razon_no_califica || null,
        agendo: Boolean(c.agendo),
        agendo_en: c.agendo_en || null,
        enlace_enviado: Boolean(c.enlace_enviado),
        enlace_enviado_en: c.enlace_enviado_en || null,
        enlace_pasos_enviados: pasosEnviados,
        enlace_seguimiento_activo: Boolean(c.enlace_enviado) && pasosEnviados < totalPasosEnlace,
        etapa: c.etapa || null,
        etapa_nombre: etapaConfig ? (etapaConfig.nombre || etapaConfig.clave) : null,
        etiquetas: Array.isArray(c.etiquetas) ? c.etiquetas : [],
        monto_pagado: Number(c.monto_pagado) || 0,
        bot_pausado: Boolean(c.bot_pausado)
      };
    }));


    res.json({ conversaciones: resumen });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Datos agregados del embudo completo para /dashboard: cuenta cada paso
// (conversaciones -> califica -> enlace -> agendó -> asistió -> compró) y
// calcula el % de conversión de un paso al siguiente, además del total de
// "cash collected" (suma de lo que cada lead pagó, registrado a mano desde
// /chats). "Asistió" y "Compró" se identifican por las etiquetas manuales
// que elijas en la configuración del dashboard (no son automáticas, porque
// el bot no tiene forma de saber por su cuenta si alguien fue a la llamada
// o pagó).
app.get("/dashboard/datos", requireAdminKey, async (req, res) => {
  try {
    // "desde"/"hasta" ahora llegan como instantes ISO COMPLETOS (con hora y
    // zona horaria ya resueltos por el navegador de quien los pidió — ver
    // inicioDelDiaISO/finDelDiaISO en el cliente), no como fechas "en
    // blanco" — así el servidor no tiene que adivinar en qué zona horaria
    // interpretarlas, evitando que "hoy" se corra un día por la diferencia
    // horaria entre México y UTC. Filtran por PRIMER MENSAJE del lead
    // (cuándo empezó la conversación), no por su última actividad, para que
    // el periodo refleje "leads que llegaron en este rango", aunque hayan
    // seguido conversando después.
    const { desde, hasta } = req.query;
    const desdeMs = desde ? new Date(desde).getTime() : null;
    const hastaMs = hasta ? new Date(hasta).getTime() : null;

    const dentroDelPeriodo = (fechaIso) => {
      if (!desdeMs && !hastaMs) return true; // sin filtro, todo cuenta
      if (!fechaIso) return false; // sin "primer_mensaje_en" no se puede ubicar en ningún periodo
      const t = new Date(fechaIso).getTime();
      if (desdeMs && t < desdeMs) return false;
      if (hastaMs && t > hastaMs) return false;
      return true;
    };

    // Cada conteo se hace por separado y con su propio manejo de error — así,
    // si alguna columna todavía no existe (ej. no corriste alguna de las
    // migraciones de etiquetas/monto_pagado/primer_mensaje_en), esa parte en
    // particular se queda en 0 en vez de tumbar TODO el dashboard.
    const contar = async (filtroFn, etiquetaError) => {
      try {
        let consulta = supabase.from("conversaciones").select("primer_mensaje_en", { count: "exact" });
        consulta = filtroFn(consulta);
        const { data, error } = await consulta;
        if (error) throw error;
        return (data || []).filter(c => dentroDelPeriodo(c.primer_mensaje_en)).length;
      } catch (err) {
        console.error(`❌ Error contando "${etiquetaError}" en el dashboard (¿corriste todas las migraciones?):`, err.message);
        return 0;
      }
    };

    const total = await contar(q => q, "total");
    const totalCalifica = await contar(q => q.eq("califica", true), "califica");
    const totalNoCalifica = await contar(q => q.eq("no_califica", true), "no_califica");
    const totalEnlace = await contar(q => q.eq("enlace_enviado", true), "enlace_enviado");
    const totalAgendo = await contar(q => q.eq("agendo", true), "agendo");

    const etiquetaAsistio = configActual.dashboard_etiqueta_asistio?.trim();
    const etiquetaCompro = configActual.dashboard_etiqueta_compro?.trim();

    // Se cuenta comparando en JS (no con el operador de Postgres) porque la
    // comparación exacta de la base de datos es sensible a mayúsculas y a
    // cómo el navegador guardó los acentos — esto normaliza igual que el
    // resto del sistema (sin mayúsculas, sin acentos), para que "Asistió",
    // "asistio" y "ASISTIÓ" cuenten como la misma etiqueta.
    async function contarPorEtiqueta(nombreEtiqueta, etiquetaError) {
      if (!nombreEtiqueta) return 0;
      try {
        const objetivo = normalizarParaComparar(nombreEtiqueta);
        const { data, error } = await supabase.from("conversaciones").select("etiquetas, primer_mensaje_en");
        if (error) throw error;
        return (data || []).filter(c =>
          dentroDelPeriodo(c.primer_mensaje_en) &&
          Array.isArray(c.etiquetas) && c.etiquetas.some(e => normalizarParaComparar(e) === objetivo)
        ).length;
      } catch (err) {
        console.error(`❌ Error contando la etiqueta "${etiquetaError}" en el dashboard:`, err.message);
        return 0;
      }
    }

    const totalAsistio = await contarPorEtiqueta(etiquetaAsistio, "asistio");
    const totalCompro = await contarPorEtiqueta(etiquetaCompro, "compro");

    // Cash collected: suma de todos los montos pagados registrados a mano,
    // dentro del periodo. Igual que arriba, si la columna todavía no
    // existe, se queda en 0 en vez de romper el resto del dashboard.
    let cashCollected = 0;
    try {
      const { data: pagos, error: errorPagos } = await supabase
        .from("conversaciones")
        .select("monto_pagado, primer_mensaje_en")
        .gt("monto_pagado", 0);
      if (errorPagos) throw errorPagos;
      cashCollected = (pagos || [])
        .filter(p => dentroDelPeriodo(p.primer_mensaje_en))
        .reduce((suma, p) => suma + (Number(p.monto_pagado) || 0), 0);
    } catch (err) {
      console.error("❌ Error sumando monto_pagado en el dashboard (¿corriste migracion_dashboard.sql?):", err.message);
    }

    const porcentaje = (parte, base) => (base > 0 ? (parte / base) * 100 : 0);

    res.json({
      total,
      totalCalifica,
      totalNoCalifica,
      totalEnlace,
      totalAgendo,
      totalAsistio,
      totalCompro,
      cashCollected,
      etiquetaAsistioConfigurada: Boolean(etiquetaAsistio),
      etiquetaCompraConfigurada: Boolean(etiquetaCompro),
      etiquetaAsistio: etiquetaAsistio || null,
      etiquetaCompro: etiquetaCompro || null,
      periodo: { desde: desde || null, hasta: hasta || null },
      porcentajes: {
        califica_de_total: porcentaje(totalCalifica, total),
        enlace_de_califica: porcentaje(totalEnlace, totalCalifica),
        agendo_de_enlace: porcentaje(totalAgendo, totalEnlace),
        asistio_de_agendo: porcentaje(totalAsistio, totalAgendo),
        compro_de_asistio: porcentaje(totalCompro, totalAsistio)
      }
    });
  } catch (err) {
    console.error("❌ Error calculando datos del dashboard:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Etiquetas manuales: el admin puede crear cualquier etiqueta libre (ej.
// "compró") y asignarla a mano desde /chats — distinto de las etiquetas
// automáticas (califica, no_califica, agendo) que pone el propio bot. Se
// guarda una lista de "todas las etiquetas que alguna vez se crearon" en
// app_config (para poder mostrarlas como opciones ya existentes al agregar
// una nueva, en vez de que el admin tenga que escribir el nombre exacto de
// memoria cada vez), y cada conversación guarda su propio array de
// etiquetas asignadas.
async function obtenerEtiquetasCreadas() {
  const { data, error } = await supabase
    .from("app_config")
    .select("*")
    .eq("key", "etiquetas_creadas")
    .maybeSingle();

  if (error) {
    console.error("❌ Error leyendo la lista de etiquetas creadas:", error.message);
    return [];
  }
  return Array.isArray(data?.valor) ? data.valor : [];
}

async function registrarEtiquetaCreada(etiqueta) {
  const actuales = await obtenerEtiquetasCreadas();
  if (actuales.includes(etiqueta)) return;

  const { error } = await supabase
    .from("app_config")
    .upsert({ key: "etiquetas_creadas", valor: [...actuales, etiqueta], actualizado_en: new Date().toISOString() });
  if (error) console.error("❌ Error guardando la etiqueta nueva en la lista global:", error.message);
}

// Devuelve todas las etiquetas que alguna vez se crearon, para poblar el
// selector de "agregar etiqueta" en /chats (además de poder escribir una
// nueva que no esté en la lista).
app.get("/etiquetas", requireAdminKey, async (req, res) => {
  try {
    const etiquetas = await obtenerEtiquetasCreadas();
    res.json({ etiquetas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Agrega una etiqueta a una conversación específica (y la registra en la
// lista global si es la primera vez que se usa).
app.post("/chats/etiqueta/agregar", requireAdminKey, async (req, res) => {
  try {
    const { senderId, etiqueta } = req.body || {};
    const etiquetaLimpia = typeof etiqueta === "string" ? etiqueta.trim() : "";
    if (!senderId || !etiquetaLimpia) return res.status(400).json({ error: "Falta senderId o etiqueta." });
    if (etiquetaLimpia.length > 40) return res.status(400).json({ error: "La etiqueta es demasiado larga (máx. 40 caracteres)." });

    const conv = await obtenerConversacion(senderId);
    const etiquetasActuales = Array.isArray(conv.etiquetas) ? conv.etiquetas : [];
    if (etiquetasActuales.includes(etiquetaLimpia)) {
      return res.json({ ok: true, etiquetas: etiquetasActuales }); // ya la tenía, no hay nada que hacer
    }

    const etiquetasNuevas = [...etiquetasActuales, etiquetaLimpia];
    await guardarConversacion(senderId, { etiquetas: etiquetasNuevas });
    await registrarEtiquetaCreada(etiquetaLimpia);

    res.json({ ok: true, etiquetas: etiquetasNuevas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Quita una etiqueta de una conversación específica (no la borra de la
// lista global — otras conversaciones pueden seguir teniéndola).
app.post("/chats/etiqueta/quitar", requireAdminKey, async (req, res) => {
  try {
    const { senderId, etiqueta } = req.body || {};
    if (!senderId || !etiqueta) return res.status(400).json({ error: "Falta senderId o etiqueta." });

    const conv = await obtenerConversacion(senderId);
    const etiquetasActuales = Array.isArray(conv.etiquetas) ? conv.etiquetas : [];
    const etiquetasNuevas = etiquetasActuales.filter(e => e !== etiqueta);
    await guardarConversacion(senderId, { etiquetas: etiquetasNuevas });

    res.json({ ok: true, etiquetas: etiquetasNuevas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Guarda cuánto pagó un lead (para el "cash collected" del dashboard). Es
// manual — se escribe a mano desde /chats cuando el pago se confirma por
// fuera del bot (transferencia, tarjeta, lo que sea).
app.post("/chats/monto-pagado", requireAdminKey, async (req, res) => {
  try {
    const { senderId, monto } = req.body || {};
    if (!senderId) return res.status(400).json({ error: "Falta senderId." });

    const montoNumero = Number(monto);
    if (!Number.isFinite(montoNumero) || montoNumero < 0) {
      return res.status(400).json({ error: "El monto debe ser un número válido, mayor o igual a 0." });
    }

    await guardarConversacion(senderId, { monto_pagado: montoNumero });
    res.json({ ok: true, monto_pagado: montoNumero });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Genera un resumen (edad, cuánto peso quiere perder, obstáculo, y dolores
// de salud/estética) de UNA conversación en particular — se pide bajo
// demanda desde el desplegable en /chats, no automáticamente, para no
// gastar en IA en conversaciones que nadie está revisando en ese momento.
// Genera un resumen (edad, cuánto peso quiere perder, obstáculo, y dolores
// de salud/estética) de UNA conversación en particular — se pide bajo
// demanda desde el desplegable en /chats. Se GUARDA en Supabase (no solo en
// la sesión del navegador) para que no se pierda al cambiar de pestaña o
// recargar la página — solo se vuelve a gastar en IA si el admin le da al
// botón de refrescar explícitamente (?forzar=true), o si nunca se había
// generado antes.
app.get("/chats/resumen/:senderId", requireAdminKey, async (req, res) => {
  try {
    const senderId = req.params.senderId;
    const forzar = req.query.forzar === "true";

    if (!forzar) {
      const conv = await obtenerConversacion(senderId);
      if (conv.resumen_lead) {
        return res.json({ vacio: false, ...conv.resumen_lead, generado_en: conv.resumen_lead_generado_en, desde_cache: true });
      }
    }

    const { data: mensajes, error } = await supabase
      .from("mensajes_chat")
      .select("role, content")
      .eq("sender_id", senderId)
      .order("creado_en", { ascending: true })
      .limit(200);

    if (error) return res.status(500).json({ error: error.message });
    if (!mensajes || mensajes.length === 0 || !mensajes.some(m => m.role === "user")) {
      return res.json({ vacio: true });
    }

    const transcripcion = mensajes
      .filter(m => typeof m.content === "string" && !m.content.startsWith("[[imagen]]") && !m.content.startsWith("[[audio]]"))
      .map(m => `${m.role === "user" ? "Cliente" : "Asistente"}: ${m.content}`)
      .join("\n");

    if (!transcripcion.trim()) return res.json({ vacio: true });

    const resumen = await analizarDoloresYObstaculos(transcripcion);
    const generadoEn = new Date().toISOString();
    await guardarConversacion(senderId, { resumen_lead: resumen, resumen_lead_generado_en: generadoEn });

    res.json({ vacio: false, ...resumen, generado_en: generadoEn, desde_cache: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pausa o reanuda el bot para UN LEAD EN PARTICULAR — distinto del
// interruptor general (botActivo), que apaga TODO el bot para todos. Se usa
// cuando el admin quiere tomar una conversación específica a mano (ej. un
// caso delicado, o alguien ya a punto de comprar) sin desactivar el bot
// para el resto de los leads. Mientras está pausado, el bot sigue
// guardando lo que el cliente escriba (no se pierde el registro), pero no
// genera ninguna respuesta automática ni evalúa transiciones.
app.post("/chats/pausar", requireAdminKey, async (req, res) => {
  try {
    const { senderId, pausado } = req.body || {};
    if (!senderId) return res.status(400).json({ error: "Falta senderId." });

    await guardarConversacion(senderId, { bot_pausado: Boolean(pausado) });
    res.json({ ok: true, bot_pausado: Boolean(pausado) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Envía un mensaje manual desde /chats (respuesta humana, fuera del flujo de la IA).
// Se guarda en el mismo historial que usa la IA, para que si el bot retoma la
// conversación más adelante tenga contexto de lo que ya se le contestó a mano.
app.post("/chats/enviar", requireAdminKey, async (req, res) => {
  try {
    const { senderId, mensaje } = req.body || {};
    if (!senderId || typeof mensaje !== "string" || !mensaje.trim()) {
      return res.status(400).json({ error: "Falta el destinatario o el mensaje." });
    }

    const texto = mensaje.trim();
    // Mismo límite de 1000 caracteres de Instagram que aplica a las respuestas
    // automáticas — si el admin escribe algo más largo, se manda en varias burbujas.
    const fragmentos = dividirTextoLargo(texto);
    for (const fragmento of fragmentos) {
      await enviarMensajeInstagram(senderId, fragmento);
      await agregarAlHistorialDB(senderId, "assistant", fragmento);
    }

    // Cancela seguimientos automáticos pendientes: ya hubo respuesta humana,
    // no queremos que el bot le mande un seguimiento encima.
    await cancelarSeguimientosPendientesDB(senderId);

    res.json({ ok: true });
  } catch (err) {
    console.error(`❌ Error enviando mensaje manual a ${req.body?.senderId}:`, err.response?.data || err.message);
    const mensajeError = err.response?.data?.error?.message || err.message;
    res.status(500).json({ error: mensajeError });
  }
});

// Cambia manualmente la etapa de una conversación desde /chats — útil para
// corregir a mano si la IA no puso el marcador [[etapa:..]], o para arrancar
// a un lead directamente en una etapa concreta. clave="" (vacío) quita la
// etapa (vuelve al prompt general).
app.post("/chats/etapa", requireAdminKey, async (req, res) => {
  try {
    const { senderId, etapa } = req.body || {};
    if (!senderId) return res.status(400).json({ error: "Falta el senderId." });

    const clave = (etapa || "").trim().toLowerCase();
    if (clave && !(configActual.etapas || []).some(e => e.clave === clave)) {
      return res.status(400).json({ error: `La etapa "${clave}" no existe en /panel.` });
    }

    await guardarConversacion(senderId, { etapa: clave || null });
    res.json({ ok: true, etapa: clave || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Envía una foto suelta desde /chats (ej. una foto de un caso de éxito que
// quieres compartir en el momento con ese lead específico). Se sube al
// bucket "fotos" bajo una subcarpeta "manual/" para no mezclarse con las
// fotos pregrabadas con nombre que se usan desde /panel.
app.post("/chats/enviar-foto", requireAdminKey, async (req, res) => {
  try {
    const { senderId, base64, tipo } = req.body || {};
    if (!senderId || !base64) {
      return res.status(400).json({ error: "Falta el destinatario o la imagen." });
    }

    const extension = (tipo && tipo.includes("/")) ? tipo.split("/")[1].split(";")[0] : "jpg";
    const rutaArchivo = `manual/${senderId}_${Date.now()}.${extension}`;
    const buffer = Buffer.from(base64, "base64");

    if (buffer.length > 15 * 1024 * 1024) {
      return res.status(400).json({ error: "La imagen pesa más de 15MB, prueba con un archivo más liviano." });
    }

    const { error: errorSubida } = await supabase.storage
      .from("fotos")
      .upload(rutaArchivo, buffer, { contentType: tipo || "image/jpeg", upsert: true });

    if (errorSubida) {
      return res.status(500).json({ error: "No se pudo subir la imagen: " + errorSubida.message });
    }

    const { data: urlData } = supabase.storage.from("fotos").getPublicUrl(rutaArchivo);
    const url = urlData.publicUrl;

    await conReintento(() => enviarImagenInstagram(senderId, url));
    await agregarAlHistorialDB(senderId, "assistant", `[[imagen]]${url}`);
    await cancelarSeguimientosPendientesDB(senderId);

    res.json({ ok: true, url });
  } catch (err) {
    console.error(`❌ Error enviando foto manual a ${req.body?.senderId}:`, err.response?.data || err.message);
    const mensajeError = err.response?.data?.error?.message || err.message;
    res.status(500).json({ error: mensajeError });
  }
});

// Envía un audio grabado desde el micrófono en /chats (respuesta humana con
// nota de voz, en vez de escribir texto). Se sube al bucket "audios" bajo
// una subcarpeta "manual/" para no mezclarse con los audios pregrabados con
// nombre/clave que se usan desde /panel. Se guarda en el historial con el
// marcador [[audio]]url (igual que los audios pregrabados) para que se vea
// como una nota de voz reproducible dentro de /chats.
app.post("/chats/enviar-audio", requireAdminKey, async (req, res) => {
  try {
    const { senderId, base64 } = req.body || {};
    if (!senderId || !base64) {
      return res.status(400).json({ error: "Falta el destinatario o el audio." });
    }

    const bufferOriginal = Buffer.from(base64, "base64");

    if (bufferOriginal.length > 15 * 1024 * 1024) {
      return res.status(400).json({ error: "El audio pesa más de 15MB, prueba con una grabación más corta." });
    }

    // El navegador graba el audio del micrófono en WEBM/Opus, que Instagram
    // NO acepta para mandar audios ("This attachment format is not
    // supported") — se convierte a MP4/AAC antes de subirlo, que sí acepta.
    let bufferMp4;
    try {
      bufferMp4 = await convertirAudioAMp4(bufferOriginal);
    } catch (errorConversion) {
      console.error(`❌ Error convirtiendo audio manual a mp4 para ${senderId}:`, errorConversion.message);
      return res.status(500).json({ error: "No se pudo procesar el audio grabado. Intenta grabarlo de nuevo." });
    }

    const rutaArchivo = `manual/${senderId}_${Date.now()}.mp4`;

    const { error: errorSubida } = await supabase.storage
      .from("audios")
      .upload(rutaArchivo, bufferMp4, { contentType: "audio/mp4", upsert: true });

    if (errorSubida) {
      return res.status(500).json({ error: "No se pudo subir el audio: " + errorSubida.message + ". ¿Existe el bucket 'audios' y es público? Revisa migracion_supabase.sql." });
    }

    const { data: urlData } = supabase.storage.from("audios").getPublicUrl(rutaArchivo);
    const url = urlData.publicUrl;

    await conReintento(() => enviarAudioInstagram(senderId, url));
    await agregarAlHistorialDB(senderId, "assistant", `[[audio]]${url}`);
    await cancelarSeguimientosPendientesDB(senderId);

    res.json({ ok: true, url });
  } catch (err) {
    console.error(`❌ Error enviando audio manual a ${req.body?.senderId}:`, err.response?.data || err.message);
    const mensajeError = err.response?.data?.error?.message || err.message;
    res.status(500).json({ error: mensajeError });
  }
});

// Borra por completo el historial y estado de una conversación (usado desde
// el clic derecho en /chats). Útil para hacer pruebas y que la próxima vez
// que esa persona escriba, el bot arranque desde cero como si fuera nueva.
// También cancela cualquier seguimiento pendiente que le quedara programado.
app.post("/chats/borrar", requireAdminKey, async (req, res) => {
  try {
    const { senderId } = req.body || {};
    if (!senderId) return res.status(400).json({ error: "Falta el senderId de la conversación a borrar." });

    await supabase.from("seguimientos_programados").delete().eq("sender_id", senderId);
    const { error } = await supabase.from("conversaciones").delete().eq("sender_id", senderId);
    if (error) return res.status(500).json({ error: error.message });

    perfilesCache.delete(senderId);

    res.json({ ok: true, mensaje: "Conversación borrada. Si esta persona vuelve a escribir, el bot empezará desde cero." });
  } catch (err) {
    console.error(`❌ Error borrando conversación de ${req.body?.senderId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

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

app.get("/refresh-token", requireAdminKey, async (req, res) => {
  try {
    const cuenta = await obtenerCuentaActiva();
    const tokenActual = cuenta ? cuenta.access_token : IG_ACCESS_TOKEN;

    const response = await axios.get("https://graph.instagram.com/refresh_access_token", {
      params: {
        grant_type: "ig_refresh_token",
        access_token: tokenActual
      }
    });

    if (cuenta) {
      await guardarCuentaConectada({
        ...cuenta,
        access_token: response.data.access_token,
        token_expira_en_segundos: response.data.expires_in || 5184000,
        ultimo_oauth_en: new Date().toISOString()
      });
    }
    await guardarFechaTokenDB(response.data.expires_in);

    res.json({
      mensaje: "Token refrescado y guardado. Si sigues usando IG_ACCESS_TOKEN en Render, actualízalo también manualmente.",
      ...response.data,
      expira_en_dias: response.data.expires_in ? Math.round(response.data.expires_in / 86400) : null
    });
  } catch (err) {
    res.status(500).json(err.response?.data || { error: err.message });
  }
});

// ---------------------------------------------------------------
// Conectar cuenta de Instagram — "Instagram directo" (Instagram API
// with Instagram Login / Business Login for Instagram). Flujo:
// 1) /oauth/instagram/start  -> redirige a Meta a autorizar
// 2) el usuario aprueba en instagram.com
// 3) Meta redirige a /oauth/instagram/callback con ?code=...
// 4) intercambiamos code -> token corto -> token largo (60 días)
// 5) guardamos todo en Supabase como la cuenta activa
// ---------------------------------------------------------------

app.get("/oauth/instagram/start", requireAdminKey, (req, res) => {
  if (!IG_APP_ID) {
    return res.status(500).send("Falta configurar IG_APP_ID en las variables de entorno de Render.");
  }

  const redirectUri = `${req.protocol}://${req.get("host")}/oauth/instagram/callback`;
  const state = generarOauthState();
  const scopes = "instagram_business_basic,instagram_business_manage_messages";

  const url = "https://www.instagram.com/oauth/authorize"
    + `?client_id=${encodeURIComponent(IG_APP_ID)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&response_type=code`
    + `&scope=${encodeURIComponent(scopes)}`
    + `&state=${encodeURIComponent(state)}`;

  res.redirect(url);
});

app.get("/oauth/instagram/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;

  const paginaError = (titulo, detalle) => res.status(400).type("html").send(`
    <html><body style="font-family:sans-serif; max-width:600px; margin:60px auto; line-height:1.6;">
      <h2>❌ ${titulo}</h2>
      <p>${detalle || ""}</p>
      <p><a href="/cuentas">Volver a cuentas</a></p>
    </body></html>
  `);

  if (error) return paginaError("No se pudo conectar la cuenta", error_description || error);
  if (!validarOauthState(state)) return paginaError("El enlace de conexión expiró o ya se usó", "Vuelve a intentar desde el panel.");
  if (!code) return paginaError("Falta el código de autorización de Meta");

  try {
    const redirectUri = `${req.protocol}://${req.get("host")}/oauth/instagram/callback`;

    // 1) Código -> token corto
    const formData = new URLSearchParams();
    formData.append("client_id", IG_APP_ID);
    formData.append("client_secret", APP_SECRET);
    formData.append("grant_type", "authorization_code");
    formData.append("redirect_uri", redirectUri);
    formData.append("code", code);

    const shortResp = await axios.post("https://api.instagram.com/oauth/access_token", formData);
    const shortToken = shortResp.data.access_token;

    // 2) Token corto -> token largo (60 días)
    const longResp = await axios.get("https://graph.instagram.com/access_token", {
      params: {
        grant_type: "ig_exchange_token",
        client_secret: APP_SECRET,
        access_token: shortToken
      }
    });
    const longToken = longResp.data.access_token;
    const expiresIn = longResp.data.expires_in || 5184000;

    // 3) Datos del perfil conectado
    const perfilResp = await axios.get("https://graph.instagram.com/v25.0/me", {
      params: { fields: "id,username,account_type", access_token: longToken }
    });
    const perfil = perfilResp.data;

    const cuenta = {
      ig_id: perfil.id,
      username: perfil.username,
      account_type: perfil.account_type,
      access_token: longToken,
      token_expira_en_segundos: expiresIn,
      conectada_en: new Date().toISOString(),
      metodo: "instagram_directo",
      ultimo_oauth_en: new Date().toISOString()
    };

    await guardarCuentaConectada(cuenta);
    await guardarFechaTokenDB(expiresIn); // mantiene compatibilidad con /token-info

    res.redirect("/cuentas");
  } catch (err) {
    console.error("❌ Error en callback de OAuth de Instagram:", err.response?.data || err.message);
    paginaError("Error conectando la cuenta", `<pre>${JSON.stringify(err.response?.data || err.message, null, 2)}</pre>`);
  }
});

// Placeholder: flujo de Facebook/Meta (vía Página vinculada) — pendiente de implementar.
app.get("/oauth/facebook/start", requireAdminKey, (req, res) => {
  res.status(501).type("html").send(`
    <html><body style="font-family:sans-serif; max-width:600px; margin:60px auto; line-height:1.6;">
      <h2>🚧 Próximamente</h2>
      <p>La conexión vía Facebook / Página de Meta todavía no está implementada.</p>
      <p><a href="/cuentas">Volver a cuentas</a></p>
    </body></html>
  `);
});

app.get("/cuenta/actual", requireAdminKey, async (req, res) => {
  const cuenta = await obtenerCuentaActiva();
  if (!cuenta) return res.json({ conectada: false });

  // La cuenta legada (variables de entorno) no trae username ni fecha de
  // conexión guardados: los completamos aquí sin necesidad de tocar Render.
  if (cuenta.metodo === "env_legacy") {
    if (!cuenta.username) {
      try {
        const perfilResp = await axios.get("https://graph.instagram.com/v25.0/me", {
          params: { fields: "username", access_token: cuenta.access_token }
        });
        cuenta.username = perfilResp.data.username;
      } catch (err) {
        console.error("❌ Error obteniendo username de la cuenta legada:", err.response?.data || err.message);
      }
    }
    if (!cuenta.conectada_en) {
      const infoToken = await obtenerInfoTokenDB();
      if (infoToken?.obtenido_en) cuenta.conectada_en = infoToken.obtenido_en;
    }
  }

  const { access_token, ...datosPublicos } = cuenta;
  res.json({ conectada: true, ...datosPublicos });
});

app.post("/cuenta/eliminar", requireAdminKey, async (req, res) => {
  await eliminarCuentaConectada();
  res.json({ mensaje: "Cuenta desconectada. El bot dejará de responder hasta que conectes otra." });
});

// ---------------------------------------------------------------
// Configuración dinámica editable desde /panel
// ---------------------------------------------------------------

let configActual = {
  ai_prompt: AI_PROMPT,
  contexto_base: "",
  min_delay: MIN_DELAY_SECONDS,
  max_delay: MAX_DELAY_SECONDS,
  max_historial: MAX_HISTORIAL,
  openai_api_key: OPENAI_API_KEY || "",
  calificacion_activa: false,
  calificar_automatico_con_enlace: false,
  no_seguir_si_no_califica: false,
  parar_seguimientos_si_agendo: false,
  mensajes_error_audio: [
    "Se me cortó tu audio a la mitad, no me llegó completo 😅 ¿me lo puedes volver a mandar?",
    "Uy, no me cargó bien tu audio, se ve que hubo un error de conexión. ¿Me lo mandas de nuevo?",
    "Se me trabó tu audio y no lo pude escuchar completo, disculpa. ¿Lo puedes volver a enviar?",
    "No me llegó tu audio como debía, creo que hubo un problema de conexión. ¿Me lo reenvías?"
  ],
  criterios_calificacion: "",
  enlace_calificacion: "",
  seguimientos: SEGUIMIENTOS_CONFIG,
  seguimientos_enlace: SEGUIMIENTOS_ENLACE_DEFAULT,
  audios: {}, // { claveAudio: { url, nombre_original, ruta_archivo, subido_en } }
  fotos: {},  // { claveFoto: { url, nombre_original, ruta_archivo, subido_en } }
  disparadores: [], // [{ frases: [], tipo: "audio"|"foto", clave, pausa_segundos }]  <- generales (fallback)
  etapas: [],  // [{ clave, nombre, prompt, disparadores: [...], transiciones: [...] }]
  transiciones_generales: [], // [{ frases: [], etapa_destino }]  <- entrar a una etapa por palabra clave sin depender de la IA
  transiciones_generales_elegir_mejor: false, // si hay varias condiciones generales, elegir la mejor en vez de la primera que diga sí
  calendly_token: "",
  calendly_pregunta_instagram: "", // texto EXACTO de la pregunta personalizada en Calendly que pide el usuario de Instagram
  calendly_organization_uri: "",
  calendly_webhook_uri: "",
  calendly_conectado_en: null,
  dashboard_etiqueta_asistio: "", // nombre exacto de la etiqueta manual que representa "asistió a la llamada"
  dashboard_etiqueta_compro: "",  // nombre exacto de la etiqueta manual que representa "compró / se cerró"
  franja_horaria_activa: false,
  franja_horaria_desde: "08:00",
  franja_horaria_hasta: "23:00"
};

// Cliente de OpenAI: se reconstruye cada vez que cambia configActual.openai_api_key
// (al cargar desde Supabase al arrancar, o al guardar una nueva desde /panel).
let openaiClient = new OpenAI({ apiKey: configActual.openai_api_key || undefined });

function actualizarClienteOpenAI() {
  openaiClient = new OpenAI({ apiKey: configActual.openai_api_key || undefined });
}

// Nunca mandamos la clave completa al navegador: solo si está configurada
// y sus últimos 4 caracteres, para que el admin identifique cuál está activa.
function enmascararClave(clave) {
  if (!clave) return "";
  const limpio = String(clave);
  return limpio.length <= 4 ? "••••" : "••••" + limpio.slice(-4);
}

function configParaFrontend(cfg) {
  const { openai_api_key, calendly_token, ...resto } = cfg;
  return {
    ...resto,
    openai_api_key_configurada: Boolean(openai_api_key),
    openai_api_key_mascara: enmascararClave(openai_api_key),
    calendly_token_configurado: Boolean(calendly_token),
    calendly_token_mascara: enmascararClave(calendly_token)
  };
}

async function cargarConfigDesdeDB() {
  try {
    const { data, error } = await supabase
      .from("app_config")
      .select("*")
      .eq("key", "bot_config")
      .maybeSingle();

    if (error) {
      console.error("❌ Error cargando configuración de Supabase, se usan los valores por defecto:", error.message);
      return;
    }
    if (data && data.valor) {
      configActual = { ...configActual, ...data.valor };
      configActual.seguimientos = [...(configActual.seguimientos || [])].sort((a, b) => a.horas - b.horas);
      configActual.seguimientos_enlace = [...(configActual.seguimientos_enlace || [])].sort((a, b) => a.horas - b.horas);
      if (!Array.isArray(configActual.etapas)) configActual.etapas = [];
      // Se re-normalizan las etapas también al CARGAR (no solo al guardar
      // desde /panel), para migrar automáticamente formatos antiguos —por
      // ejemplo, etapas guardadas antes de que "mensaje_fijo" (un solo texto)
      // se convirtiera en "mensajes_fijos" (varias variantes que rotan). Sin
      // esto, una etapa guardada con el formato viejo dejaría de mandar su
      // mensaje fijo hasta que alguien la volviera a guardar a mano.
      configActual.etapas = normalizarEtapas(configActual.etapas);
      // Los disparadores GENERALES (no los de dentro de cada etapa, que ya
      // se migran arriba via normalizarEtapas) también se re-normalizan al
      // cargar, por la misma razón: para migrar automáticamente el modo
      // "todas" (legado) a "combinaciones" sin depender de que alguien
      // vuelva a guardar desde /panel.
      configActual.disparadores = normalizarDisparadores(configActual.disparadores);
      if (!Array.isArray(configActual.transiciones_generales)) configActual.transiciones_generales = [];
      actualizarClienteOpenAI();
      console.log("✅ Configuración cargada desde Supabase.");
    } else {
      console.log("ℹ️ No hay configuración guardada todavía, se usan los valores por defecto (.env).");
    }
  } catch (err) {
    console.error("❌ Error inesperado cargando configuración:", err.message);
  }
}

async function guardarConfigDB(nuevaConfig) {
  configActual = { ...configActual, ...nuevaConfig };
  configActual.seguimientos = [...(configActual.seguimientos || [])].sort((a, b) => a.horas - b.horas);
  configActual.seguimientos_enlace = [...(configActual.seguimientos_enlace || [])].sort((a, b) => a.horas - b.horas);
  if (!Array.isArray(configActual.etapas)) configActual.etapas = [];
  if (!Array.isArray(configActual.transiciones_generales)) configActual.transiciones_generales = [];
  actualizarClienteOpenAI();

  const { error } = await supabase
    .from("app_config")
    .upsert({ key: "bot_config", valor: configActual, actualizado_en: new Date().toISOString() });

  if (error) console.error("❌ Error guardando configuración en Supabase:", error.message);
  return configActual;
}

cargarConfigDesdeDB();

// ---------------------------------------------------------------
// Respaldo inicial (una sola vez por conversación): al agregar la tabla
// "mensajes_chat" para el scroll hacia atrás en /chats, las conversaciones
// que ya existían no tienen nada guardado ahí todavía — solo tienen lo que
// quedó en "historial" (ya recortado por max_historial). Esta rutina copia,
// para cada conversación que aún no tenga NADA en mensajes_chat, lo que
// tenga disponible en su "historial" actual — así al menos se rescatan los
// mensajes más recientes que todavía no se habían perdido, en vez de
// arrancar la tabla completamente vacía para conversaciones viejas.
// ---------------------------------------------------------------
async function respaldarHistorialExistenteUnaVez() {
  try {
    const { data: conversaciones, error } = await supabase
      .from("conversaciones")
      .select("sender_id, historial");

    if (error) {
      console.error("❌ Error leyendo conversaciones para el respaldo inicial de mensajes_chat:", error.message);
      return;
    }

    for (const conv of conversaciones || []) {
      const historial = Array.isArray(conv.historial) ? conv.historial : [];
      if (historial.length === 0) continue;

      const { count, error: errorConteo } = await supabase
        .from("mensajes_chat")
        .select("*", { count: "exact", head: true })
        .eq("sender_id", conv.sender_id);

      if (errorConteo) {
        console.error(`❌ Error revisando mensajes_chat de ${conv.sender_id}:`, errorConteo.message);
        continue;
      }
      if (count > 0) continue; // ya tiene registro completo, no se toca

      const ahora = Date.now();
      const filas = historial.map((m, idx) => ({
        sender_id: conv.sender_id,
        role: m.role,
        content: m.content,
        // Se espacían por 1 segundo entre sí (en el mismo orden en que ya
        // estaban) para que el orden cronológico se respete al ordenar por
        // "creado_en" — no se conoce la hora real de cada uno, así que esto
        // es solo una aproximación razonable para el respaldo inicial.
        creado_en: new Date(ahora - (historial.length - idx) * 1000).toISOString()
      }));

      const { error: errorInsercion } = await supabase.from("mensajes_chat").insert(filas);
      if (errorInsercion) {
        console.error(`❌ Error respaldando historial de ${conv.sender_id} en mensajes_chat:`, errorInsercion.message);
      } else {
        console.log(`✅ Respaldo inicial: ${filas.length} mensaje(s) de ${conv.sender_id} copiados a mensajes_chat.`);
      }
    }
  } catch (err) {
    console.error("❌ Error inesperado en el respaldo inicial de mensajes_chat:", err.message);
  }
}

respaldarHistorialExistenteUnaVez();

// ---------------------------------------------------------------
// Respaldo inicial (una sola vez por conversación): "primer_mensaje_en" solo
// se guarda HACIA ADELANTE desde que se agregó esa función — los leads que
// ya le habían escrito al bot antes de ese cambio no tienen ese dato, lo
// cual hacía que CUALQUIER filtro de periodo en el Dashboard (incluso
// "hoy") los excluyera a todos, mostrando ceros, mientras que "Todo el
// tiempo" sí funcionaba (porque no depende de esa fecha). Esta rutina
// rescata la fecha real usando el mensaje MÁS VIEJO que exista en
// mensajes_chat para cada conversación (el registro completo que ya
// tenemos desde antes) — así el dato queda correcto sin tener que esperar
// a que cada lead vuelva a escribir.
// ---------------------------------------------------------------
async function respaldarPrimerMensajeExistenteUnaVez() {
  try {
    const { data: conversaciones, error } = await supabase
      .from("conversaciones")
      .select("sender_id, ultimo_mensaje_usuario")
      .is("primer_mensaje_en", null);

    if (error) {
      console.error("❌ Error leyendo conversaciones para el respaldo inicial de primer_mensaje_en:", error.message);
      return;
    }
    if (!conversaciones || conversaciones.length === 0) return;

    for (const conv of conversaciones) {
      const { data: primerMensaje, error: errorMensaje } = await supabase
        .from("mensajes_chat")
        .select("creado_en")
        .eq("sender_id", conv.sender_id)
        .order("creado_en", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (errorMensaje) {
        console.error(`❌ Error buscando el primer mensaje de ${conv.sender_id}:`, errorMensaje.message);
        continue;
      }

      // Si por lo que sea no hay nada en mensajes_chat para ese lead
      // (no debería pasar, ya que se respaldó antes), se usa el último
      // mensaje conocido como aproximación — mejor eso que dejarlo vacío
      // para siempre.
      const fecha = primerMensaje?.creado_en || conv.ultimo_mensaje_usuario;
      if (!fecha) continue;

      const { error: errorGuardado } = await supabase
        .from("conversaciones")
        .update({ primer_mensaje_en: fecha })
        .eq("sender_id", conv.sender_id);

      if (errorGuardado) {
        console.error(`❌ Error guardando primer_mensaje_en de ${conv.sender_id}:`, errorGuardado.message);
      }
    }

    console.log(`✅ Respaldo inicial de primer_mensaje_en: ${conversaciones.length} conversación(es) revisadas.`);
  } catch (err) {
    console.error("❌ Error inesperado en el respaldo inicial de primer_mensaje_en:", err.message);
  }
}

respaldarPrimerMensajeExistenteUnaVez();


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

// ---------------------------------------------------------------
// Rotación de los "mensajes fijos al entrar a una etapa" (ver más abajo, en
// normalizarEtapas). A diferencia de la rotación de seguimientos (que es
// POR CONVERSACIÓN, porque un mismo lead puede recibir varios seguimientos
// seguidos), esta rotación es GLOBAL y compartida entre TODOS los leads:
// cada vez que alguien entra a la etapa, se manda la siguiente variante de
// la lista, sin importar quién sea — así, si tienes 10 casos de éxito
// cargados, el lead 1 recibe el caso 1, el lead 2 el caso 2, y así
// sucesivamente, dando la vuelta cuando se acaban. Se guarda en Supabase
// (no en configActual) para que no se pise ni se resetee cuando se guarda
// la configuración desde /panel, y para que sobreviva un redeploy.
// ---------------------------------------------------------------

async function obtenerYAvanzarRotacionEntrada(etapaClave, totalMensajes) {
  if (!totalMensajes || totalMensajes <= 0) return 0;

  const { data, error } = await supabase
    .from("app_config")
    .select("*")
    .eq("key", "etapa_entrada_rotacion")
    .maybeSingle();

  if (error) {
    console.error("❌ Error leyendo rotación de mensajes de entrada, se usa el índice 0:", error.message);
    return 0;
  }

  const estado = (data && data.valor) ? { ...data.valor } : {};
  const indiceActual = Number.isInteger(estado[etapaClave]) ? estado[etapaClave] : 0;
  const indiceUsado = indiceActual % totalMensajes;

  estado[etapaClave] = (indiceActual + 1) % totalMensajes;

  const { error: errorGuardado } = await supabase
    .from("app_config")
    .upsert({ key: "etapa_entrada_rotacion", valor: estado, actualizado_en: new Date().toISOString() });
  if (errorGuardado) console.error("❌ Error guardando rotación de mensajes de entrada:", errorGuardado.message);

  return indiceUsado;
}

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

app.get("/config", requireAdminKey, (req, res) => {
  res.json(configParaFrontend(configActual));
});

// Valida y normaliza un array de disparadores (usado tanto para los
// generales como para los propios de cada etapa). tipo puede ser "audio" o
// "foto" (mandan un audio/foto ya subido en /panel, referenciado por
// "clave") o "mensaje" (manda un contenido libre con marcadores
// [[audio:..]]/[[foto:..]]/[[pausa:N]] combinados, tal cual, sin pasar por
// la IA — para poder combinar texto + fotos + audios + tiempos en un mismo
// disparador).
function normalizarDisparadores(disparadores) {
  if (!Array.isArray(disparadores)) return [];
  return disparadores
    .filter(d => d && (d.tipo === "audio" || d.tipo === "foto" || d.tipo === "mensaje" || d.tipo === "etiqueta"))
    .map(d => {
      let frases = Array.isArray(d.frases) ? d.frases.map(f => String(f).trim()).filter(Boolean) : [];
      let coincidencia = (d.coincidencia === "exacta" || d.coincidencia === "combinaciones" || d.coincidencia === "etiqueta") ? d.coincidencia : "contiene";

      // Compatibilidad con guardados anteriores al modo "combinaciones": el
      // modo "todas" (una sola combinación, una palabra por línea) se migra
      // a "combinaciones" uniendo todas las palabras en una sola línea con
      // comas, para que se siga comportando exactamente igual.
      if (d.coincidencia === "todas") {
        coincidencia = "combinaciones";
        frases = frases.length > 0 ? [frases.join(", ")] : [];
      }

      return {
        tipo: d.tipo,
        clave: typeof d.clave === "string" ? d.clave.trim().toLowerCase() : "",
        contenido: typeof d.contenido === "string" ? d.contenido.trim() : "",
        frases,
        pausa_segundos: Number.isFinite(d.pausa_segundos) && d.pausa_segundos >= 0 ? d.pausa_segundos : 2,
        coincidencia,
        exclusivo: Boolean(d.exclusivo),
        // Etiqueta que se agrega a la conversación cuando este disparador se
        // activa — funciona con CUALQUIER tipo (audio/foto/mensaje pueden
        // ADEMÁS etiquetar; el tipo "etiqueta" es exclusivamente para esto,
        // sin mandar ningún contenido).
        etiqueta_a_agregar: typeof d.etiqueta_a_agregar === "string" ? d.etiqueta_a_agregar.trim() : "",
        // Si está activado, este disparador SOLO se evalúa en el turno
        // exacto en que se entra a la etapa (por transición) — nunca en
        // mensajes posteriores dentro de la misma etapa. Imprescindible
        // para los que usan coincidencia "por etiqueta" (que de otra forma
        // se dispararían en cada mensaje, ya que la etiqueta es permanente).
        solo_al_entrar_a_etapa: Boolean(d.solo_al_entrar_a_etapa)
      };
    })
    .filter(d => d.frases.length > 0)
    .filter(d => {
      if (d.tipo === "mensaje") return Boolean(d.contenido);
      if (d.tipo === "etiqueta") return Boolean(d.etiqueta_a_agregar);
      return Boolean(d.clave);
    });
}

// Valida y normaliza un array de transiciones de etapa por palabra clave
// (usado tanto para las generales como para las propias de cada etapa).
// etapa_destino === "" es válido: significa "salir de etapas" (general).
// coincidencia puede ser "contiene", "exacta" (comparación de texto),
// "combinaciones" (grupos de palabras separadas por coma, una línea por
// grupo — ver grupoDePalabrasCoincide) o "condicion" (la evalúa la IA contra
// una descripción en lenguaje natural, ej. "el cliente mencionó tener 40
// años o más" — ver evaluarTransicionesPorCondicion).
function normalizarTransiciones(transiciones) {
  if (!Array.isArray(transiciones)) return [];
  return transiciones
    .filter(t => t && typeof t.etapa_destino === "string")
    .map(t => {
      const coincidencia = (t.coincidencia === "exacta" || t.coincidencia === "condicion" || t.coincidencia === "combinaciones") ? t.coincidencia : "contiene";
      return {
        etapa_destino: t.etapa_destino.trim().toLowerCase(),
        frases: Array.isArray(t.frases) ? t.frases.map(f => String(f).trim()).filter(Boolean) : [],
        condicion: typeof t.condicion === "string" ? t.condicion.trim() : "",
        coincidencia,
        silenciosa: Boolean(t.silenciosa),
        no_califica: Boolean(t.no_califica),
        motivo_no_califica: typeof t.motivo_no_califica === "string" ? t.motivo_no_califica.trim() : "",
        agendo: Boolean(t.agendo),
        verificar_calendly: Boolean(t.verificar_calendly)
      };
    })
    .filter(t => t.coincidencia === "condicion" ? Boolean(t.condicion) : t.frases.length > 0);
}

// Valida y normaliza el array de etapas que llega desde /panel.
function normalizarEtapas(etapas) {
  if (!Array.isArray(etapas)) return [];
  const normalizadas = etapas
    .filter(e => e && typeof e.clave === "string" && e.clave.trim())
    .map(e => {
      // mensajes_fijos: varias variantes que rotan (ver obtenerYAvanzarRotacionEntrada).
      // Se mantiene compatibilidad con guardados antiguos que tenían un solo
      // "mensaje_fijo" (string) en vez del array nuevo.
      let mensajesFijos = [];
      if (Array.isArray(e.mensajes_fijos)) {
        mensajesFijos = e.mensajes_fijos.map(m => String(m).trim()).filter(Boolean);
      } else if (typeof e.mensaje_fijo === "string" && e.mensaje_fijo.trim()) {
        mensajesFijos = [e.mensaje_fijo.trim()];
      }

      return {
        clave: e.clave.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_-]/g, "_"),
        nombre: typeof e.nombre === "string" ? e.nombre.trim() : "",
        prompt: typeof e.prompt === "string" ? e.prompt.trim() : "",
        mensajes_fijos: mensajesFijos,
        entrada: Boolean(e.entrada),
        elegir_mejor_condicion: Boolean(e.elegir_mejor_condicion),
        requiere_pregunta_final: Boolean(e.requiere_pregunta_final),
        disparadores: normalizarDisparadores(e.disparadores),
        transiciones: normalizarTransiciones(e.transiciones)
      };
    })
    .filter(e => e.clave);

  // Solo puede haber UNA etapa de entrada a la vez (un lead nuevo solo puede
  // arrancar en un lugar). Si por lo que sea llegan varias marcadas, se deja
  // únicamente la primera y se desmarcan las demás.
  let yaHayEntrada = false;
  for (const e of normalizadas) {
    if (e.entrada) {
      if (yaHayEntrada) e.entrada = false;
      else yaHayEntrada = true;
    }
  }

  return normalizadas;
}

// Quita transiciones (generales o de una etapa) que apunten a una clave de
// etapa que ya no existe — puede pasar si se borró una etapa después de
// haber configurado una transición hacia ella. "" (salir/general) siempre
// es un destino válido.
function filtrarDestinosDeTransicionValidos(transiciones, clavesValidas) {
  return (transiciones || []).filter(t => t.etapa_destino === "" || clavesValidas.has(t.etapa_destino));
}

app.post("/config", requireAdminKey, async (req, res) => {
  try {
    const { ai_prompt, contexto_base, min_delay, max_delay, max_historial, seguimientos, seguimientos_enlace, openai_api_key,
            calificacion_activa, calificar_automatico_con_enlace, no_seguir_si_no_califica, parar_seguimientos_si_agendo, criterios_calificacion, enlace_calificacion, disparadores, etapas, transiciones_generales,
            transiciones_generales_elegir_mejor, mensajes_error_audio, calendly_token, calendly_pregunta_instagram,
            dashboard_etiqueta_asistio, dashboard_etiqueta_compro, franja_horaria_activa, franja_horaria_desde, franja_horaria_hasta } = req.body || {};

    const nuevaConfig = {};
    if (typeof ai_prompt === "string" && ai_prompt.trim()) nuevaConfig.ai_prompt = ai_prompt.trim();
    if (typeof contexto_base === "string") nuevaConfig.contexto_base = contexto_base.trim();
    if (Number.isFinite(min_delay) && min_delay >= 0) nuevaConfig.min_delay = min_delay;
    if (Number.isFinite(max_delay) && max_delay >= 0) nuevaConfig.max_delay = max_delay;
    if (Number.isFinite(max_historial) && max_historial > 0) nuevaConfig.max_historial = max_historial;
    if (Array.isArray(seguimientos)) nuevaConfig.seguimientos = seguimientos;
    if (Array.isArray(seguimientos_enlace)) nuevaConfig.seguimientos_enlace = seguimientos_enlace;
    // Solo se actualiza si mandaron una clave nueva; si viene vacío, se deja la que ya había.
    if (typeof openai_api_key === "string" && openai_api_key.trim()) nuevaConfig.openai_api_key = openai_api_key.trim();
    // Mismo criterio para el token de Calendly — no se pisa con vacío.
    if (typeof calendly_token === "string" && calendly_token.trim()) nuevaConfig.calendly_token = calendly_token.trim();
    if (typeof calendly_pregunta_instagram === "string") nuevaConfig.calendly_pregunta_instagram = calendly_pregunta_instagram.trim();
    if (typeof dashboard_etiqueta_asistio === "string") nuevaConfig.dashboard_etiqueta_asistio = dashboard_etiqueta_asistio.trim();
    if (typeof dashboard_etiqueta_compro === "string") nuevaConfig.dashboard_etiqueta_compro = dashboard_etiqueta_compro.trim();
    if (typeof franja_horaria_activa === "boolean") nuevaConfig.franja_horaria_activa = franja_horaria_activa;
    if (typeof franja_horaria_desde === "string" && /^\d{2}:\d{2}$/.test(franja_horaria_desde)) nuevaConfig.franja_horaria_desde = franja_horaria_desde;
    if (typeof franja_horaria_hasta === "string" && /^\d{2}:\d{2}$/.test(franja_horaria_hasta)) nuevaConfig.franja_horaria_hasta = franja_horaria_hasta;
    if (typeof calificacion_activa === "boolean") nuevaConfig.calificacion_activa = calificacion_activa;
    if (typeof calificar_automatico_con_enlace === "boolean") nuevaConfig.calificar_automatico_con_enlace = calificar_automatico_con_enlace;
    if (typeof no_seguir_si_no_califica === "boolean") nuevaConfig.no_seguir_si_no_califica = no_seguir_si_no_califica;
    if (typeof parar_seguimientos_si_agendo === "boolean") nuevaConfig.parar_seguimientos_si_agendo = parar_seguimientos_si_agendo;
    if (Array.isArray(mensajes_error_audio)) nuevaConfig.mensajes_error_audio = mensajes_error_audio.map(m => String(m).trim()).filter(Boolean);
    if (typeof criterios_calificacion === "string") nuevaConfig.criterios_calificacion = criterios_calificacion.trim();
    if (typeof enlace_calificacion === "string") nuevaConfig.enlace_calificacion = enlace_calificacion.trim();
    if (Array.isArray(disparadores)) nuevaConfig.disparadores = normalizarDisparadores(disparadores);
    if (Array.isArray(etapas)) nuevaConfig.etapas = normalizarEtapas(etapas);
    if (Array.isArray(transiciones_generales)) nuevaConfig.transiciones_generales = normalizarTransiciones(transiciones_generales);
    if (typeof transiciones_generales_elegir_mejor === "boolean") nuevaConfig.transiciones_generales_elegir_mejor = transiciones_generales_elegir_mejor;

    // Descarta transiciones (generales o por etapa) que apunten a una etapa
    // que ya no existe en el guardado actual.
    const etapasFinales = nuevaConfig.etapas || configActual.etapas || [];
    const clavesValidas = new Set(etapasFinales.map(e => e.clave));
    if (nuevaConfig.transiciones_generales) {
      nuevaConfig.transiciones_generales = filtrarDestinosDeTransicionValidos(nuevaConfig.transiciones_generales, clavesValidas);
    }
    if (nuevaConfig.etapas) {
      nuevaConfig.etapas = nuevaConfig.etapas.map(e => ({
        ...e,
        transiciones: filtrarDestinosDeTransicionValidos(e.transiciones, clavesValidas)
      }));
    }

    const guardado = await guardarConfigDB(nuevaConfig);
    res.json({ mensaje: "✅ Configuración guardada", config: configParaFrontend(guardado) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// Audios pregrabados: se suben en base64 desde /panel, se guardan en
// Supabase Storage (bucket "audios", debe existir y ser público — ver
// migracion_supabase.sql) y quedan disponibles para que el prompt los
// mande con el marcador [[audio:clave]] en vez de texto.
// ---------------------------------------------------------------

app.post("/audios/subir", requireAdminKey, async (req, res) => {
  try {
    const { nombre, base64 } = req.body || {};
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: "Falta el nombre del audio." });
    if (!base64) return res.status(400).json({ error: "Falta el archivo de audio." });

    // La clave es el nombre normalizado (sin espacios/acentos/mayúsculas):
    // es lo que se usa en el prompt como [[audio:clave]].
    const clave = nombre.trim().toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // quita acentos
      .replace(/[^a-z0-9_-]/g, "_");

    if (!clave) return res.status(400).json({ error: "El nombre no dejó ningún caracter válido, prueba con otro." });

    const bufferOriginal = Buffer.from(base64, "base64");

    if (bufferOriginal.length > 15 * 1024 * 1024) {
      return res.status(400).json({ error: "El audio pesa más de 15MB, prueba con un archivo más liviano." });
    }

    // Se convierte SIEMPRE a MP4/AAC, sin importar el formato original que
    // hayas subido (mp3, wav, m4a, etc.) — así se garantiza que Instagram
    // pueda mandarlo sin el error "This attachment format is not supported",
    // que puede pasar con formatos que no sean exactamente MP4/AAC.
    let bufferMp4;
    try {
      bufferMp4 = await convertirAudioAMp4(bufferOriginal);
    } catch (errorConversion) {
      console.error("❌ Error convirtiendo audio pregrabado a mp4:", errorConversion.message);
      return res.status(500).json({ error: "No se pudo procesar ese archivo de audio. Prueba con otro formato (mp3, wav, m4a)." });
    }

    const rutaArchivo = `${clave}_${Date.now()}.mp4`;

    const { error: errorSubida } = await supabase.storage
      .from("audios")
      .upload(rutaArchivo, bufferMp4, { contentType: "audio/mp4", upsert: true });

    if (errorSubida) {
      console.error("❌ Error subiendo audio a Supabase Storage:", errorSubida.message);
      return res.status(500).json({ error: "No se pudo subir el audio: " + errorSubida.message + ". ¿Existe el bucket 'audios' y es público? Revisa migracion_supabase.sql." });
    }

    const { data: urlData } = supabase.storage.from("audios").getPublicUrl(rutaArchivo);

    // Si ya existía un audio con esa misma clave, se borra el archivo viejo
    // del storage para no dejar basura acumulada.
    const audioAnterior = configActual.audios?.[clave];
    if (audioAnterior?.ruta_archivo) {
      await supabase.storage.from("audios").remove([audioAnterior.ruta_archivo]);
    }

    const nuevosAudios = { ...(configActual.audios || {}) };
    nuevosAudios[clave] = {
      url: urlData.publicUrl,
      nombre_original: nombre.trim(),
      ruta_archivo: rutaArchivo,
      subido_en: new Date().toISOString()
    };

    await guardarConfigDB({ audios: nuevosAudios });

    res.json({ mensaje: "✅ Audio subido", clave, audio: nuevosAudios[clave] });
  } catch (err) {
    console.error("❌ Error inesperado subiendo audio:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/audios/eliminar", requireAdminKey, async (req, res) => {
  try {
    const { clave } = req.body || {};
    if (!clave) return res.status(400).json({ error: "Falta la clave del audio a eliminar." });

    const audios = { ...(configActual.audios || {}) };
    const audio = audios[clave];

    if (audio?.ruta_archivo) {
      const { error: errorBorrado } = await supabase.storage.from("audios").remove([audio.ruta_archivo]);
      if (errorBorrado) console.error("❌ Error borrando archivo de audio en Storage:", errorBorrado.message);
    }

    delete audios[clave];
    await guardarConfigDB({ audios });

    res.json({ mensaje: "🗑️ Audio eliminado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// Fotos pregrabadas: mismo mecanismo que los audios, pero en el bucket
// "fotos" de Supabase Storage. Se usan con el marcador [[foto:clave]]
// tanto en el prompt como en los mensajes de seguimiento.
// ---------------------------------------------------------------

app.post("/fotos/subir", requireAdminKey, async (req, res) => {
  try {
    const { nombre, base64, tipo } = req.body || {};
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: "Falta el nombre de la foto." });
    if (!base64) return res.status(400).json({ error: "Falta el archivo de imagen." });

    const clave = nombre.trim().toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9_-]/g, "_");

    if (!clave) return res.status(400).json({ error: "El nombre no dejó ningún caracter válido, prueba con otro." });

    const extension = (tipo && tipo.includes("/")) ? tipo.split("/")[1].split(";")[0] : "jpg";
    const rutaArchivo = `${clave}_${Date.now()}.${extension}`;
    const buffer = Buffer.from(base64, "base64");

    if (buffer.length > 15 * 1024 * 1024) {
      return res.status(400).json({ error: "La imagen pesa más de 15MB, prueba con un archivo más liviano." });
    }

    const { error: errorSubida } = await supabase.storage
      .from("fotos")
      .upload(rutaArchivo, buffer, { contentType: tipo || "image/jpeg", upsert: true });

    if (errorSubida) {
      console.error("❌ Error subiendo foto a Supabase Storage:", errorSubida.message);
      return res.status(500).json({ error: "No se pudo subir la foto: " + errorSubida.message + ". ¿Existe el bucket 'fotos' y es público? Revisa migracion_supabase.sql." });
    }

    const { data: urlData } = supabase.storage.from("fotos").getPublicUrl(rutaArchivo);

    const fotoAnterior = configActual.fotos?.[clave];
    if (fotoAnterior?.ruta_archivo) {
      await supabase.storage.from("fotos").remove([fotoAnterior.ruta_archivo]);
    }

    const nuevasFotos = { ...(configActual.fotos || {}) };
    nuevasFotos[clave] = {
      url: urlData.publicUrl,
      nombre_original: nombre.trim(),
      ruta_archivo: rutaArchivo,
      subido_en: new Date().toISOString()
    };

    await guardarConfigDB({ fotos: nuevasFotos });

    res.json({ mensaje: "✅ Foto subida", clave, foto: nuevasFotos[clave] });
  } catch (err) {
    console.error("❌ Error inesperado subiendo foto:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/fotos/eliminar", requireAdminKey, async (req, res) => {
  try {
    const { clave } = req.body || {};
    if (!clave) return res.status(400).json({ error: "Falta la clave de la foto a eliminar." });

    const fotos = { ...(configActual.fotos || {}) };
    const foto = fotos[clave];

    if (foto?.ruta_archivo) {
      const { error: errorBorrado } = await supabase.storage.from("fotos").remove([foto.ruta_archivo]);
      if (errorBorrado) console.error("❌ Error borrando archivo de foto en Storage:", errorBorrado.message);
    }

    delete fotos[clave];
    await guardarConfigDB({ fotos });

    res.json({ mensaje: "🗑️ Foto eliminada" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// /cuentas — conectar cuentas de Instagram y ver estado del token
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// /login — página real de acceso (reemplaza el prompt() del navegador).
// Se manda ANTES que cualquier ruta protegida por requireAdminSesion,
// así que un "Cancelar" aquí simplemente te deja en esta misma página,
// nunca llega a mostrarse el diseño del panel sin autenticar.
// ---------------------------------------------------------------

app.get("/login", (req, res) => {
  const yaAutenticado = parseCookies(req)[COOKIE_NOMBRE] === ADMIN_API_KEY && ADMIN_API_KEY;
  if (yaAutenticado) {
    return res.redirect(req.query.redirect || "/panel");
  }

  res.type("html").send(`
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Iniciar sesión — Instagram AI Responder</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${FUENTES_HTML}
${estilosBase()}
<style>
  body{ display:flex; align-items:center; justify-content:center; min-height:100vh; padding:24px; }
  .login-card{
    width:100%; max-width:380px; background:var(--surface); border:1px solid var(--border);
    border-radius:var(--radius-lg); padding:34px 30px;
  }
  .login-brand{ display:flex; align-items:center; gap:10px; margin-bottom:26px; }
  .login-dot{ width:10px; height:10px; border-radius:50%; background:var(--green); flex-shrink:0; }
  .login-brand-name{ font-family:var(--display); font-weight:600; font-size:16.5px; }
  .login-card h1{ font-family:var(--display); font-weight:700; font-size:24px; margin:0 0 8px; }
  .login-card p{ color:var(--muted); font-size:14px; margin:0 0 22px; line-height:1.55; }
  .login-card input{
    width:100%; background:var(--surface-3); border:1px solid var(--border); color:var(--text);
    border-radius:10px; padding:13px 14px; font-family:var(--body); font-size:15px; outline:none; margin-bottom:14px;
  }
  .login-card input:focus{ border-color:var(--green); }
  .login-btn{
    width:100%; background:var(--green); color:#0A0D13; font-family:var(--display);
    font-weight:600; font-size:15.5px; border:none; border-radius:10px; padding:13px; cursor:pointer;
  }
  .login-btn:hover{ filter:brightness(1.08); }
  .login-btn:disabled{ opacity:.6; cursor:default; }
  .login-error{ color:var(--red); font-size:13.5px; margin-top:12px; display:none; }
</style>
</head>
<body>
  <div class="login-card">
    <div class="login-brand">
      <div class="login-dot"></div>
      <div class="login-brand-name">IG AI Responder</div>
    </div>
    <h1>Iniciar sesión</h1>
    <p>Ingresa tu clave de administrador para entrar al panel.</p>
    <form id="loginForm">
      <input type="password" id="clave" placeholder="ADMIN_API_KEY" autofocus>
      <button type="submit" class="login-btn" id="btnLogin">Entrar</button>
      <p class="login-error" id="loginError">Clave incorrecta. Intenta de nuevo.</p>
    </form>
  </div>
<script>
  const params = new URLSearchParams(window.location.search);
  const redirectTo = params.get("redirect") || "/panel";

  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const clave = document.getElementById("clave").value;
    const btn = document.getElementById("btnLogin");
    const err = document.getElementById("loginError");
    err.style.display = "none";
    btn.disabled = true; btn.textContent = "Entrando…";

    try {
      const res = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clave })
      });
      if (res.ok) {
        window.location.href = redirectTo;
      } else {
        err.style.display = "block";
        btn.disabled = false; btn.textContent = "Entrar";
      }
    } catch {
      err.textContent = "Error de conexión. Intenta de nuevo.";
      err.style.display = "block";
      btn.disabled = false; btn.textContent = "Entrar";
    }
  });
</script>
</body>
</html>
  `);
});

app.post("/login", (req, res) => {
  const { clave } = req.body || {};
  if (!ADMIN_API_KEY || clave !== ADMIN_API_KEY) {
    return res.status(401).json({ error: "Clave incorrecta" });
  }
  ponerCookieSesion(res, req);
  res.json({ ok: true });
});

app.get("/logout", (req, res) => {
  borrarCookieSesion(res);
  res.redirect("/login");
});

app.get("/cuentas", requireAdminSesion, (req, res) => {
  res.type("html").send(`
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cuentas — Instagram AI Responder</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${FUENTES_HTML}
${estilosBase()}
<style>
  /* --- Conectar cuentas de Instagram --- */
  .cuentas-titulo{ font-family:var(--mono); font-size:12.5px; letter-spacing:.14em;
    text-transform:uppercase; color:#3FC7E8; margin:0 0 6px; }
  .cuentas-subtitulo{ font-family:var(--display); font-weight:600; font-size:19px; margin:0 0 16px; }
  .cuenta-item{
    display:flex; align-items:center; gap:16px; background:var(--surface-3); border:1px solid var(--border);
    border-radius:13px; padding:18px 20px;
  }
  .cuenta-info{ flex:1; min-width:0; }
  .cuenta-info .nombre{ font-family:var(--display); font-weight:600; font-size:22px; margin-bottom:6px; }
  .cuenta-info .detalle{ color:var(--muted); font-size:13.5px; line-height:1.65; font-family:var(--mono); }
  .cuenta-info .detalle b{ color:#C9D1DE; font-weight:500; }
  .cuenta-lado{ display:flex; flex-direction:column; align-items:flex-end; gap:10px; flex-shrink:0; }
  .badge{ font-size:12.5px; font-family:var(--mono); padding:6px 13px; border-radius:20px;
    background:var(--green-soft); color:var(--green); border:1px solid rgba(49,217,124,.3); white-space:nowrap; }
  .btn-eliminar{
    background:var(--red-soft); color:var(--red); border:1px solid rgba(255,93,93,.35);
    border-radius:9px; padding:9px 15px; font-size:13.5px; font-weight:600; cursor:pointer;
  }
  .btn-eliminar:hover{ background:rgba(255,93,93,.18); }
  .sin-cuenta{ color:var(--muted); font-size:15px; padding:8px 2px; }
</style>
</head>
<body>
  <div class="app-shell">
  ${sidebarHTML("cuentas")}
  <div class="content-area">
  <div class="main">
    <div class="page-header">
      <div class="page-header-left">
        <h1 class="page-title">CONECTAR CUENTAS DE INSTAGRAM</h1>
      </div>
      <button class="btn-hero" id="btnConectarInstagram">Instagram directo (token 60 días)</button>
    </div>
    <p class="page-sub">Conecta una cuenta directo desde Instagram y el sistema intenta guardar token long-lived (60 días) sin depender de Facebook Page. Por ahora solo se puede tener una cuenta activa a la vez: conectar una nueva reemplaza a la anterior.</p>

    <div class="card">
      <p class="cuentas-titulo">Tus cuentas</p>
      <p class="cuentas-subtitulo">Estado actual</p>
      <div id="cuentaActual"><p class="sin-cuenta">Cargando…</p></div>
    </div>
  </div>
  </div>
  </div>

<script>
  async function llamarGET(endpoint){
    const res = await fetch(endpoint);
    if(res.status === 401){ window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname); return null; }
    return res.json();
  }
  async function llamarPOST(endpoint, body){
    const res = await fetch(endpoint, {
      method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body || {})
    });
    if(res.status === 401){ window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname); return null; }
    return res.json();
  }

  document.getElementById("btnConectarInstagram").addEventListener("click", () => {
    window.location.href = "/oauth/instagram/start";
  });

  function formatearFecha(iso){
    if(!iso) return "fecha desconocida";
    const d = new Date(iso);
    return d.toLocaleDateString("es-MX", { day:"2-digit", month:"short" }) + ", " +
      d.toLocaleTimeString("es-MX", { hour:"2-digit", minute:"2-digit" });
  }

  async function cargarCuentaActual(){
    const cont = document.getElementById("cuentaActual");
    const data = await llamarGET("/cuenta/actual");
    if(!data || !data.conectada){
      cont.innerHTML = '<p class="sin-cuenta">No hay ninguna cuenta conectada todavía. Usa el botón de arriba para conectar una.</p>';
      return;
    }

    let tokenInfo = await llamarGET("/token-info");
    let diasRestantesTxt = "";
    if(tokenInfo && !tokenInfo.error){
      const fecha = new Date(tokenInfo.expira_aproximadamente_en);
      diasRestantesTxt = \`Token vence en \${tokenInfo.dias_restantes} día(s) (\${fecha.toLocaleDateString("es-MX",{day:"2-digit",month:"short"})})\`;
    }

    cont.innerHTML = \`
      <div class="cuenta-item">
        <div class="cuenta-info">
          <div class="nombre">@\${data.username || "sin_usuario"}</div>
          <div class="detalle">
            Conectada: <b>\${formatearFecha(data.conectada_en)}</b>\${diasRestantesTxt ? " · " + diasRestantesTxt : ""}
          </div>
        </div>
        <div class="cuenta-lado">
          <span class="badge">Conectada</span>
          <button class="btn-eliminar" id="btnEliminarCuenta">Eliminar cuenta</button>
        </div>
      </div>
    \`;

    document.getElementById("btnEliminarCuenta").addEventListener("click", async () => {
      if(!confirm("¿Seguro que quieres desconectar esta cuenta? El bot dejará de responder hasta que conectes otra.")) return;
      await llamarPOST("/cuenta/eliminar");
      cargarCuentaActual();
    });
  }

  cargarCuentaActual();
</script>
</body>
</html>
  `);
});

app.get("/dashboard", requireAdminSesion, (req, res) => {
  res.type("html").send(`
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard — Instagram AI Responder</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${FUENTES_HTML}
${estilosBase()}
<style>
  .dash-cash-card{
    background:linear-gradient(135deg, rgba(49,217,124,.12), rgba(49,217,124,.03));
    border:1px solid rgba(49,217,124,.3); border-radius:var(--radius-lg);
    padding:24px 28px; margin-bottom:22px; display:flex; align-items:center; justify-content:space-between;
    flex-wrap:wrap; gap:16px;
  }
  .dash-cash-label{ font-family:var(--display); font-size:15px; font-weight:600; color:var(--muted); }
  .dash-cash-value{ font-family:var(--display); font-size:38px; font-weight:700; color:var(--green); }
  .dash-side-stats{ display:flex; gap:14px; margin-bottom:22px; flex-wrap:wrap; }
  .dash-side-stat{
    background:var(--surface); border:1px solid var(--border); border-radius:12px;
    padding:14px 18px; flex:1; min-width:160px;
  }
  .dash-side-stat-label{ font-size:12.5px; color:var(--muted); margin-bottom:5px; }
  .dash-side-stat-value{ font-family:var(--display); font-size:22px; font-weight:700; }
  .dash-funnel{
    display:grid; grid-template-columns:1fr 1fr; grid-template-rows:repeat(3, auto);
    grid-auto-flow:column; gap:10px; margin-bottom:22px;
  }
  .dash-step{
    background:var(--surface); border:1px solid var(--border); border-radius:12px;
    padding:16px 20px; display:flex; align-items:center; justify-content:space-between;
    transition:border-color .15s;
  }
  .dash-step-left{ display:flex; align-items:center; gap:13px; }
  .dash-step-icon{ font-size:22px; flex-shrink:0; }
  .dash-step-label{ font-family:var(--display); font-size:15px; font-weight:600; }
  .dash-step-sub{ font-size:12px; color:var(--muted); margin-top:2px; }
  .dash-step-right{ display:flex; flex-direction:row; align-items:center; gap:8px; flex-shrink:0; }
  .dash-step-value{
    font-family:var(--display); font-size:17px; font-weight:700; line-height:1;
    background:var(--surface-3); border:1px solid var(--border); border-radius:9px;
    padding:7px 11px;
  }
  .dash-step-pct{
    font-size:20px; font-weight:700; color:var(--text); font-family:var(--display); line-height:1;
    background:var(--surface-3); border:1px solid var(--border); border-radius:9px;
    padding:7px 12px;
  }
  .dash-step.step-total{ border-color:rgba(255,255,255,.15); }
  .dash-step.step-califica{ border-color:rgba(49,217,124,.35); }
  .dash-step.step-califica .dash-step-pct{ color:var(--green); background:var(--green-soft); border-color:rgba(49,217,124,.35); }
  .dash-step.step-enlace{ border-color:rgba(63,199,232,.35); }
  .dash-step.step-enlace .dash-step-pct{ color:#3FC7E8; background:rgba(63,199,232,.12); border-color:rgba(63,199,232,.35); }
  .dash-step.step-agendo{ border-color:rgba(49,217,124,.35); }
  .dash-step.step-agendo .dash-step-pct{ color:var(--green); background:var(--green-soft); border-color:rgba(49,217,124,.35); }
  .dash-step.step-asistio{ border-color:rgba(201,155,255,.35); }
  .dash-step.step-asistio .dash-step-pct{ color:#C99BFF; background:rgba(201,155,255,.12); border-color:rgba(201,155,255,.35); }
  .dash-step.step-compro{ border-color:rgba(255,197,66,.4); }
  .dash-step.step-compro .dash-step-pct{ color:#FFC542; background:rgba(255,197,66,.12); border-color:rgba(255,197,66,.4); }
  @media (max-width: 720px){
    .dash-funnel{ grid-template-columns:1fr; grid-auto-flow:row; }
  }
  .dash-config-card{
    background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg);
    padding:22px 26px; margin-top:8px;
  }
  .dash-config-row{ display:flex; gap:16px; flex-wrap:wrap; margin-top:14px; }
  .dash-config-field{ flex:1; min-width:220px; }
  .dash-config-field label{ display:block; font-size:13px; color:var(--muted); margin-bottom:6px; }
  .dash-config-field select{
    width:100%; background:var(--surface-3); border:1px solid var(--border); color:var(--text);
    border-radius:8px; padding:9px 10px; font-size:13.5px; font-family:var(--body);
  }
  .dash-config-msg{ font-size:13px; margin-top:12px; min-height:18px; }
  .dash-warning{
    background:rgba(255,197,66,.08); border:1px solid rgba(255,197,66,.3); border-radius:10px;
    padding:12px 16px; font-size:13px; color:#FFC542; margin-bottom:18px;
  }
  .dash-periodo-bar{
    display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:18px;
    background:var(--surface); border:1px solid var(--border); border-radius:11px; padding:10px 16px;
  }
  .dash-periodo-label{ font-size:13px; font-weight:600; color:var(--muted); flex-shrink:0; }
  .dash-periodo-select{
    background:var(--surface-3); border:1px solid var(--border); color:var(--text);
    border-radius:8px; padding:7px 10px; font-size:13px; font-family:var(--body);
  }
  .dash-periodo-btn{
    background:rgba(63,199,232,.12); border:1px solid rgba(63,199,232,.35); color:#3FC7E8;
    border-radius:8px; padding:7px 14px; font-size:13px; font-weight:600; cursor:pointer;
  }
  .dash-periodo-btn:hover{ background:rgba(63,199,232,.2); }
  .dash-periodo-info{ font-size:12.5px; color:var(--muted-dim); margin-left:auto; }
</style>
</head>
<body>
  <div class="app-shell">
  ${sidebarHTML("dashboard")}
  <div class="content-area">
  <div class="main">
    <div class="page-header">
      <div class="page-header-left">
        <p class="page-eyebrow">Instagram</p>
        <h1 class="page-title">Dashboard</h1>
      </div>
    </div>
    <p class="page-sub">Cómo va funcionando tu embudo completo, paso a paso — para saber dónde mejorar.</p>

    <div class="dash-periodo-bar">
      <span class="dash-periodo-label">📅 Periodo:</span>
      <select id="selectPeriodo" class="dash-periodo-select">
        <option value="todo">Todo el tiempo</option>
        <option value="hoy">Hoy</option>
        <option value="ayer">Ayer</option>
        <option value="este_mes">Este mes</option>
        <option value="mes_pasado">Mes pasado</option>
        <option value="este_anio">Este año</option>
        <option value="personalizado">Personalizado…</option>
      </select>
      <div id="dashFechasPersonalizadas" style="display:none; align-items:center; gap:8px;">
        <input type="date" id="dashFechaDesde" class="dash-periodo-select">
        <span style="color:var(--muted); font-size:12.5px;">hasta</span>
        <input type="date" id="dashFechaHasta" class="dash-periodo-select">
        <button class="dash-periodo-btn" id="btnAplicarPeriodo" type="button">Aplicar</button>
      </div>
      <span class="dash-periodo-info" id="dashPeriodoInfo"></span>
    </div>

    <div id="dashSinEtiquetas" class="dash-warning" style="display:none;"></div>

    <div class="dash-funnel">
      <div class="dash-step step-total">
        <div class="dash-step-left">
          <span class="dash-step-icon">💬</span>
          <div><div class="dash-step-label">Conversaciones totales</div><div class="dash-step-sub">Todos los leads que le han escrito al bot</div></div>
        </div>
        <div class="dash-step-right">
          <div class="dash-step-value" id="dashTotal">–</div>
        </div>
      </div>

      <div class="dash-step step-califica">
        <div class="dash-step-left">
          <span class="dash-step-icon">✅</span>
          <div><div class="dash-step-label">Califican</div><div class="dash-step-sub">del total de conversaciones</div></div>
        </div>
        <div class="dash-step-right">
          <div class="dash-step-value" id="dashCalifica">–</div>
          <div class="dash-step-pct" id="pctCalifica">–</div>
        </div>
      </div>

      <div class="dash-step step-enlace">
        <div class="dash-step-left">
          <span class="dash-step-icon">🔗</span>
          <div><div class="dash-step-label">Enlaces enviados</div><div class="dash-step-sub">de los que califican</div></div>
        </div>
        <div class="dash-step-right">
          <div class="dash-step-value" id="dashEnlace">–</div>
          <div class="dash-step-pct" id="pctEnlace">–</div>
        </div>
      </div>

      <div class="dash-step step-agendo">
        <div class="dash-step-left">
          <span class="dash-step-icon">📅</span>
          <div><div class="dash-step-label">Agendaron</div><div class="dash-step-sub">de los que recibieron el enlace</div></div>
        </div>
        <div class="dash-step-right">
          <div class="dash-step-value" id="dashAgendo">–</div>
          <div class="dash-step-pct" id="pctAgendo">–</div>
        </div>
      </div>

      <div class="dash-step step-asistio">
        <div class="dash-step-left">
          <span class="dash-step-icon">🙋</span>
          <div><div class="dash-step-label">Asistieron</div><div class="dash-step-sub" id="subAsistio">de los que agendaron</div></div>
        </div>
        <div class="dash-step-right">
          <div class="dash-step-value" id="dashAsistio">–</div>
          <div class="dash-step-pct" id="pctAsistio">–</div>
        </div>
      </div>

      <div class="dash-step step-compro">
        <div class="dash-step-left">
          <span class="dash-step-icon">🎉</span>
          <div><div class="dash-step-label">Compraron</div><div class="dash-step-sub" id="subCompro">de los que asistieron</div></div>
        </div>
        <div class="dash-step-right">
          <div class="dash-step-value" id="dashCompro">–</div>
          <div class="dash-step-pct" id="pctCompro">–</div>
        </div>
      </div>
    </div>

    <div class="dash-cash-card">
      <div>
        <div class="dash-cash-label">💰 Cash Collected</div>
        <div class="dash-side-stat-label" style="margin-top:4px;">Suma de todo lo que has registrado como pagado, desde /chats</div>
      </div>
      <div class="dash-cash-value" id="dashCash">$0</div>
    </div>

    <div class="dash-config-card">
      <h2 style="font-family:var(--display); font-size:16px; font-weight:600; margin:0 0 5px;">⚙️ Configurar el embudo</h2>
      <p class="hint" style="margin:0;">"Asistió" y "Compró" no los detecta el bot solo — se basan en las etiquetas manuales que le pongas a cada lead desde /chats. Elige aquí cuál etiqueta representa cada cosa.</p>
      <div class="dash-config-row">
        <div class="dash-config-field">
          <label for="selectEtiquetaAsistio">Etiqueta que representa "Asistió"</label>
          <select id="selectEtiquetaAsistio"><option value="">— Elegir etiqueta —</option></select>
        </div>
        <div class="dash-config-field">
          <label for="selectEtiquetaCompro">Etiqueta que representa "Compró / se cerró"</label>
          <select id="selectEtiquetaCompro"><option value="">— Elegir etiqueta —</option></select>
        </div>
      </div>
      <button class="add-paso" id="btnGuardarConfigDash" type="button" style="margin-top:16px;">Guardar configuración</button>
      <p class="dash-config-msg" id="dashConfigMsg"></p>
    </div>

  </div>
  </div>
  </div>

<script>
  function formatearMoneda(n){
    return "$" + Number(n || 0).toLocaleString("es-MX", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  function formatearPct(n){
    return Number(n || 0).toFixed(1) + "%";
  }

  // { desde: "YYYY-MM-DD" o null, hasta: "YYYY-MM-DD" o null } — null en
  // ambos significa "todo el tiempo", sin filtrar nada.
  let periodoActual = { desde: null, hasta: null };

  function formatoFecha(d){
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // Convierte una fecha "YYYY-MM-DD" (un día del calendario, tal como lo
  // ve el usuario) al instante exacto de inicio/fin de ESE día en la zona
  // horaria del NAVEGADOR — no en UTC. Esto es clave: si se mandara solo
  // "2026-07-11" al servidor y este asumiera UTC, alguien que escribe de
  // noche en México (varias horas detrás de UTC) podría quedar registrado
  // con la fecha del día siguiente en UTC, y "hoy" no lo encontraría.
  // Al construir el Date con año/mes/día por separado (sin pasar por un
  // string ISO), JavaScript lo interpreta en la hora LOCAL del navegador,
  // y toISOString() ya lo convierte correctamente a UTC para mandarlo.
  function inicioDelDiaISO(fechaStr){
    const [y, m, d] = fechaStr.split("-").map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
  }
  function finDelDiaISO(fechaStr){
    const [y, m, d] = fechaStr.split("-").map(Number);
    return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
  }

  function calcularPeriodoPreset(preset){
    const hoy = new Date();
    if(preset === "hoy"){
      const f = formatoFecha(hoy);
      return { desde: f, hasta: f };
    }
    if(preset === "ayer"){
      const ayer = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 1);
      const f = formatoFecha(ayer);
      return { desde: f, hasta: f };
    }
    if(preset === "este_mes"){
      const desde = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
      const hasta = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
      return { desde: formatoFecha(desde), hasta: formatoFecha(hasta) };
    }
    if(preset === "mes_pasado"){
      const desde = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
      const hasta = new Date(hoy.getFullYear(), hoy.getMonth(), 0);
      return { desde: formatoFecha(desde), hasta: formatoFecha(hasta) };
    }
    if(preset === "este_anio"){
      const desde = new Date(hoy.getFullYear(), 0, 1);
      const hasta = new Date(hoy.getFullYear(), 11, 31);
      return { desde: formatoFecha(desde), hasta: formatoFecha(hasta) };
    }
    return { desde: null, hasta: null }; // "todo"
  }

  function actualizarInfoPeriodo(){
    const info = document.getElementById("dashPeriodoInfo");
    if(!periodoActual.desde && !periodoActual.hasta){
      info.textContent = "";
    } else {
      info.textContent = "Mostrando del " + periodoActual.desde + " al " + periodoActual.hasta;
    }
  }

  async function cargarDashboard(){
    let data;
    try {
      const params = new URLSearchParams();
      // Se mandan como instantes completos (con hora y zona horaria ya
      // resueltos en el navegador), no como fechas "en blanco" — así el
      // servidor no tiene que adivinar en qué zona horaria interpretarlas.
      if(periodoActual.desde) params.set("desde", inicioDelDiaISO(periodoActual.desde));
      if(periodoActual.hasta) params.set("hasta", finDelDiaISO(periodoActual.hasta));
      const url = "/dashboard/datos" + (params.toString() ? "?" + params.toString() : "");

      const res = await fetch(url);
      if(res.status === 401){ window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname); return; }
      data = await res.json();
    } catch (err) {
      console.error("Error cargando /dashboard/datos:", err);
      return;
    }

    if(!data || data.error){
      console.error("El servidor no pudo calcular los datos del dashboard:", data?.error || "(respuesta vacía)");
      return;
    }

    // Defensivo: si por lo que sea faltara algún campo esperado en la
    // respuesta, se usan valores en 0 en vez de romper la página — y se dej
    // a un registro en consola para poder diagnosticar qué vino distinto.
    const porcentajes = data.porcentajes || {};
    if(!data.porcentajes) console.warn("La respuesta de /dashboard/datos no trajo \\"porcentajes\\":", data);

    document.getElementById("dashCash").textContent = formatearMoneda(data.cashCollected);
    document.getElementById("dashTotal").textContent = data.total ?? 0;
    document.getElementById("dashCalifica").textContent = data.totalCalifica ?? 0;
    document.getElementById("dashEnlace").textContent = data.totalEnlace ?? 0;
    document.getElementById("dashAgendo").textContent = data.totalAgendo ?? 0;
    document.getElementById("dashAsistio").textContent = data.totalAsistio ?? 0;
    document.getElementById("dashCompro").textContent = data.totalCompro ?? 0;

    document.getElementById("pctCalifica").textContent = formatearPct(porcentajes.califica_de_total);
    document.getElementById("pctEnlace").textContent = formatearPct(porcentajes.enlace_de_califica);
    document.getElementById("pctAgendo").textContent = formatearPct(porcentajes.agendo_de_enlace);
    document.getElementById("pctAsistio").textContent = formatearPct(porcentajes.asistio_de_agendo);
    document.getElementById("pctCompro").textContent = formatearPct(porcentajes.compro_de_asistio);

    const avisos = [];
    if(!data.etiquetaAsistioConfigurada) avisos.push('"Asistió"');
    if(!data.etiquetaCompraConfigurada) avisos.push('"Compró"');
    const avisoBox = document.getElementById("dashSinEtiquetas");
    if(avisos.length > 0){
      avisoBox.style.display = "block";
      avisoBox.textContent = "⚠️ Todavía no configuraste qué etiqueta representa " + avisos.join(" ni ") + " — configúralo abajo para que esos pasos del embudo funcionen.";
    } else {
      avisoBox.style.display = "none";
    }

    document.getElementById("subAsistio").textContent = data.etiquetaAsistio ? 'Etiqueta: "' + data.etiquetaAsistio + '"' : "de los que agendaron (sin configurar)";
    document.getElementById("subCompro").textContent = data.etiquetaCompro ? 'Etiqueta: "' + data.etiquetaCompro + '"' : "de los que asistieron (sin configurar)";

    if(document.getElementById("selectEtiquetaAsistio").value === "" && data.etiquetaAsistio){
      document.getElementById("selectEtiquetaAsistio").value = data.etiquetaAsistio;
    }
    if(document.getElementById("selectEtiquetaCompro").value === "" && data.etiquetaCompro){
      document.getElementById("selectEtiquetaCompro").value = data.etiquetaCompro;
    }
  }

  async function cargarEtiquetasDisponibles(){
    const res = await fetch("/etiquetas");
    if(res.status === 401) return;
    const data = await res.json();
    const etiquetas = data?.etiquetas || [];
    const selects = [document.getElementById("selectEtiquetaAsistio"), document.getElementById("selectEtiquetaCompro")];
    selects.forEach(select => {
      const valorActual = select.value;
      etiquetas.forEach(et => {
        if(select.querySelector(\`option[value="\${et}"]\`)) return;
        const opt = document.createElement("option");
        opt.value = et;
        opt.textContent = et;
        select.appendChild(opt);
      });
      if(valorActual) select.value = valorActual;
    });
  }

  document.getElementById("btnGuardarConfigDash").addEventListener("click", async () => {
    const msg = document.getElementById("dashConfigMsg");
    msg.textContent = "Guardando…";
    msg.style.color = "";
    try {
      const res = await fetch("/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dashboard_etiqueta_asistio: document.getElementById("selectEtiquetaAsistio").value,
          dashboard_etiqueta_compro: document.getElementById("selectEtiquetaCompro").value
        })
      });
      if(res.status === 401){ window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname); return; }
      if(!res.ok) throw new Error("No se pudo guardar.");
      msg.textContent = "✓ Guardado";
      msg.style.color = "var(--green)";
      await cargarDashboard();
    } catch (err) {
      msg.textContent = "❌ " + err.message;
      msg.style.color = "var(--red)";
    }
    setTimeout(() => { msg.textContent = ""; }, 2500);
  });

  document.getElementById("selectPeriodo").addEventListener("change", (e) => {
    const valor = e.target.value;
    const bloquePersonalizado = document.getElementById("dashFechasPersonalizadas");

    if(valor === "personalizado"){
      bloquePersonalizado.style.display = "flex";
      // No se recarga todavía — se espera a que el usuario elija las
      // fechas y le dé a "Aplicar", para no disparar cargas de más.
      return;
    }

    bloquePersonalizado.style.display = "none";
    periodoActual = calcularPeriodoPreset(valor);
    actualizarInfoPeriodo();
    cargarDashboard();
  });

  document.getElementById("btnAplicarPeriodo").addEventListener("click", () => {
    const desde = document.getElementById("dashFechaDesde").value;
    const hasta = document.getElementById("dashFechaHasta").value;
    if(!desde || !hasta){
      alert("Elige ambas fechas (desde y hasta) antes de aplicar.");
      return;
    }
    if(desde > hasta){
      alert("La fecha \\"desde\\" no puede ser después de la fecha \\"hasta\\".");
      return;
    }
    periodoActual = { desde, hasta };
    actualizarInfoPeriodo();
    cargarDashboard();
  });

  cargarEtiquetasDisponibles().then(cargarDashboard);
  setInterval(cargarDashboard, 15000);
</script>
</body>
</html>
  `);
});

app.get("/panel", requireAdminSesion, (req, res) => {
  res.type("html").send(`
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Configuración — Instagram AI Responder</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${FUENTES_HTML}
${estilosBase()}
<style>
  body{ padding-bottom:0; }
  .switch-row{ display:flex; gap:10px; }
  .btn{
    font-family:var(--body); font-weight:600; font-size:14.5px; border:none;
    border-radius:10px; padding:11px 16px; cursor:pointer; transition:filter .15s, transform .1s;
  }
  .btn:active{ transform:scale(.97); }
  .btn-on{ background:var(--green); color:#0A0D13; }
  .btn-off{ background:transparent; color:var(--red); border:1px solid rgba(255,93,93,.4); }
  .btn:hover{ filter:brightness(1.08); }

  .paso{
    border:1px solid var(--border); border-radius:11px; padding:16px; margin-bottom:12px;
    background:rgba(255,255,255,.015); transition:opacity .12s, border-color .12s, background .12s;
  }
  .paso.arrastrando{ opacity:.4; }
  .paso.arrastrando-sobre{ border-color:var(--green); background:rgba(49,217,124,.06); }
  .paso-head{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px; }
  .paso-head-izq{ display:flex; align-items:center; gap:9px; min-width:0; }
  .fila-drag-handle{
    cursor:grab; color:var(--muted); font-size:17px; line-height:1; flex-shrink:0;
    padding:2px 5px; border-radius:6px; user-select:none;
  }
  .fila-drag-handle:hover{ color:var(--green); background:rgba(49,217,124,.1); }
  .fila-drag-handle:active{ cursor:grabbing; }
  .paso-head .eyebrow-num{ font-family:var(--mono); font-size:12px; color:var(--green); }
  .quitar{ background:none; border:none; color:var(--muted); font-size:13px; cursor:pointer; text-decoration:underline; }
  .quitar:hover{ color:var(--red); }
  .add-paso{
    width:100%; background:transparent; border:1px dashed var(--border); color:var(--muted);
    border-radius:10px; padding:13px; font-size:14.5px; cursor:pointer; font-weight:500;
  }
  .add-paso:hover{ border-color:var(--green); color:var(--green); }

  .savebar{
    position:fixed; left:236px; right:0; bottom:0; background:linear-gradient(0deg, var(--bg) 65%, transparent);
    padding:22px 46px 24px;
  }
  .savebar-inner{ width:100%; max-width:1360px; margin:0 auto; display:flex; align-items:center; gap:14px; }
  .save-btn{
    background:var(--green); color:#0A0D13; font-family:var(--display);
    font-weight:600; font-size:16px; border:none; border-radius:12px; padding:15px 28px; cursor:pointer;
    letter-spacing:.01em;
  }
  .save-btn:active{ transform:scale(.985); }
  .save-msg{ font-size:13.5px; color:var(--muted); white-space:nowrap; }
  .save-msg.ok{ color:var(--green); }
  .content-area{ padding-bottom:120px; }
  .key-input-row{ display:flex; gap:8px; }
  .key-input-row input{ flex:1; }
  .btn-ojo{
    background:var(--surface-3); border:1px solid var(--border); border-radius:10px;
    padding:0 15px; cursor:pointer; color:var(--muted); font-size:16px; flex-shrink:0;
  }
  .btn-ojo:hover{ color:var(--text); border-color:var(--green); }
  .key-actual{ font-family:var(--mono); font-size:12.5px; color:var(--muted); margin:10px 0 0; }
  .audio-item{
    display:flex; align-items:center; gap:12px; background:var(--surface-3); border:1px solid var(--border);
    border-radius:11px; padding:12px 14px; margin-bottom:10px; flex-wrap:wrap;
  }
  .audio-item .audio-info{ flex:1; min-width:160px; }
  .audio-item .audio-clave{ font-family:var(--mono); font-size:13px; color:var(--green); font-weight:600; }
  .audio-item .audio-nombre{ font-size:12.5px; color:var(--muted); margin-top:2px; }
  .audio-item audio{ height:34px; max-width:220px; }
  .audio-item .quitar{ flex-shrink:0; }
  .card.card-destacada{ border-color:rgba(49,217,124,.35); }
  .enlace-tag{
    display:inline-block; font-family:var(--mono); font-size:11.5px; color:#3FC7E8;
    background:rgba(63,199,232,.1); border:1px solid rgba(63,199,232,.28); border-radius:6px;
    padding:3px 8px; margin-top:8px;
  }
  .pausa-tag{
    display:inline-block; font-family:var(--mono); font-size:11.5px; color:var(--green);
    background:var(--green-soft); border:1px solid rgba(49,217,124,.28); border-radius:6px;
    padding:3px 8px; margin-top:8px;
  }
  .etapa-tag{
    display:inline-block; font-family:var(--mono); font-size:11.5px; color:#C99BFF;
    background:rgba(201,155,255,.1); border:1px solid rgba(201,155,255,.28); border-radius:6px;
    padding:3px 8px; margin-top:8px;
  }
  .card.card-etapas{ border-color:rgba(201,155,255,.35); }
  .etapa-card{
    border:1px solid rgba(201,155,255,.28); border-radius:13px; padding:18px; margin-bottom:14px;
    background:rgba(201,155,255,.03); transition:opacity .12s, border-color .12s, background .12s;
  }
  .etapa-card.arrastrando{ opacity:.4; }
  .etapa-card.arrastrando-sobre{ border-color:#C99BFF; background:rgba(201,155,255,.09); }
  .etapa-card-head{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:14px; }
  .etapa-card-head-izq{ display:flex; align-items:center; gap:10px; min-width:0; }
  .etapa-drag-handle{
    cursor:grab; color:var(--muted); font-size:18px; line-height:1; flex-shrink:0;
    padding:4px 6px; border-radius:6px; user-select:none;
  }
  .etapa-drag-handle:hover{ color:#C99BFF; background:rgba(201,155,255,.1); }
  .etapa-drag-handle:active{ cursor:grabbing; }
  .etapa-entrada-badge{
    font-family:var(--mono); font-size:10.5px; font-weight:600; color:#0A0D13;
    background:#C99BFF; border-radius:6px; padding:2px 8px; letter-spacing:.03em; flex-shrink:0;
  }
  .etapa-entrada-check{
    display:flex; align-items:flex-start; gap:9px; cursor:pointer; margin:0 0 14px;
    padding:10px 12px; border-radius:9px; background:rgba(201,155,255,.06); border:1px solid rgba(201,155,255,.2);
  }
  .etapa-entrada-check input{ width:16px; height:16px; accent-color:#C99BFF; cursor:pointer; margin-top:1px; flex-shrink:0; }
  .etapa-entrada-check span{ color:var(--text); font-size:13.5px; font-weight:500; line-height:1.5; }
  .etapa-card-head .eyebrow-num{ font-family:var(--mono); font-size:12px; color:#C99BFF; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .etapa-subseccion{ border-top:1px dashed var(--border); margin-top:16px; padding-top:16px; }
  .etapa-subseccion-titulo{ font-family:var(--display); font-weight:600; font-size:13.5px; margin:0 0 10px; color:var(--muted); }
  @media (max-width:860px){ .savebar{ left:0; padding:18px 18px 20px; } .save-btn{ flex:1; } }
</style>
</head>
<body>
  <div class="app-shell">
  ${sidebarHTML("panel")}
  <div class="content-area">
  <div class="main">
    <div class="page-header">
      <div class="page-header-left">
        <p class="page-eyebrow">Configuración</p>
        <h1 class="page-title">Configuración del bot</h1>
      </div>
      <div class="header-status">
        <div class="header-status-text">
          <div class="header-status-label">Estado del bot</div>
          <div class="header-status-value" id="statValor">
            <span class="status-dot" id="dot"></span>
            <span id="statTexto">Cargando…</span>
          </div>
        </div>
        <button class="btn btn-on" id="btnOn">Encender bot</button>
        <button class="btn btn-off" id="btnOff">Apagar bot</button>
      </div>
    </div>

    <div class="grid-2col">
      <div class="col">
        <div class="card card-destacada">
          <h2>1. Clave de API (OpenAI)</h2>
          <details class="ayuda">
            <summary>¿Cómo funciona esto?</summary>
            <div class="hint-contenido">
              <p class="hint">Lo primero que hay que configurar: sin una clave válida el bot no puede generar respuestas. Se guarda en la base de datos y nunca se muestra completa aquí, solo sus últimos 4 caracteres. Escribe una nueva únicamente si quieres reemplazarla.</p>
            </div>
          </details>
          <label for="openaiKey">Nueva clave</label>
          <div class="key-input-row">
            <input type="password" id="openaiKey" placeholder="sk-..." autocomplete="off">
            <button type="button" class="btn-ojo" id="btnVerClave" title="Mostrar/ocultar">👁</button>
          </div>
          <p class="key-actual" id="keyActual">Cargando estado…</p>
        </div>

        <div class="card card-destacada">
          <h2>📅 Calendly (verificar reservas de verdad)</h2>
          <details class="ayuda">
            <summary>¿Cómo funciona esto?</summary>
            <div class="hint-contenido">
              <p class="hint">Con esto, cuando un lead diga "ya agendé", el bot puede consultar EN VIVO tu Calendly para confirmar si es cierto — en vez de creerle a ciegas. Solo funciona en el momento exacto en que alguien lo dice (no revisa a nadie más), así que no necesitas el plan de pago de Calendly (los webhooks sí lo requieren, pero esto usa solo consultas de lectura, disponibles gratis).</p>
              <p class="hint">Necesitas dos cosas: (1) tu <b>Personal Access Token</b> de Calendly (en Calendly: Integrations → API and Webhooks), y (2) que tu evento tenga una <b>pregunta personalizada obligatoria</b> pidiendo el usuario de Instagram — pega aquí el texto EXACTO de esa pregunta, tal cual aparece en Calendly.</p>
              <p class="hint">Después de guardar esto (con el botón "Guardar cambios" de siempre), ve a la transición que detecta "ya agendé" (en la etapa correspondiente) y marca la casilla <b>"📆 Verificar EN VIVO en Calendly"</b> — así es como se activa la verificación en esa transición en particular.</p>
            </div>
          </details>
          <label for="calendlyToken">Personal Access Token</label>
          <div class="key-input-row">
            <input type="password" id="calendlyToken" placeholder="eyJhbGc..." autocomplete="off">
            <button type="button" class="btn-ojo" id="btnVerClaveCalendly" title="Mostrar/ocultar">👁</button>
          </div>
          <p class="key-actual" id="calendlyKeyActual">Cargando estado…</p>
          <label for="calendlyPregunta" style="margin-top:14px;">Texto EXACTO de la pregunta de Instagram en tu evento de Calendly</label>
          <input type="text" id="calendlyPregunta" placeholder="Ej: ¿Cuál es tu usuario de Instagram?">
        </div>

        <div class="card card-destacada">
          <h2>🧱 Reglas generales (siempre activas)</h2>
          <details class="ayuda">
            <summary>¿Cómo funciona esto?</summary>
            <div class="hint-contenido">
              <p class="hint">
                Este texto se agrega <b>automáticamente antes</b> de cualquier prompt que use la IA — el general de abajo
                y el de <b>cada una</b> de tus etapas — sin que tengas que repetirlo en cada una. Sirve para que el bot
                nunca pierda de vista quién es, cuál es su objetivo, y qué NO debe hacer, incluso cuando está dentro de
                una etapa con instrucciones muy acotadas (ej. una etapa que solo pregunta la edad no debería, aun así,
                ponerse a dar rutinas de ejercicio o consejos técnicos si el lead pregunta algo fuera de tema).
              </p>
              <p class="hint">
                Ejemplo: <i>"Eres el asistente de Roberto, entrenador fitness para hombres de 40-55 años. Tu único
                objetivo en esta conversación es calificar al lead y agendar una llamada — nunca des rutinas de
                ejercicio, planes de dieta detallados, ni consejos técnicos; si preguntan por eso, di que se ve en la
                sesión con Roberto."</i>
              </p>
            </div>
          </details>
          <label for="contextoBase">Reglas generales</label>
          <textarea id="contextoBase" rows="5" placeholder="Ej: Eres el asistente de... Tu único objetivo es... Nunca hagas..."></textarea>
        </div>

        <div class="card">
          <h2>Mensaje del bot (general)</h2>
          <details class="ayuda">
            <summary>¿Cómo funciona esto?</summary>
            <div class="hint-contenido">
              <p class="hint">Instrucciones que sigue la IA para responder a los clientes cuando <b>NO</b> están en ninguna etapa (ver "Etapas de la conversación" a la derecha). Sé específico: tono, qué información dar, qué evitar. También puedes usar <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">[[pausa:N]]</code> dentro de la respuesta para partirla en varios mensajes separados (burbujas distintas), esperando N segundos entre cada uno. También sirve para mandar un audio o foto pregrabada después de un texto, o para pasar al lead a una etapa con <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">[[etapa:clave]]</code> — por ejemplo <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">Perfecto, cuéntame primero tu objetivo[[etapa:objetivo]]</code> manda ese mensaje y a partir de ahí el lead entra a la etapa "objetivo" (usará el prompt de esa etapa, no este).</p>
            </div>
          </details>
          <label for="prompt">Prompt del sistema (general)</label>
          <textarea id="prompt" rows="8" placeholder="Eres el asistente de..."></textarea>
        </div>

        <div class="card">
          <h2>Tiempos de respuesta</h2>
          <details class="ayuda">
            <summary>¿Cómo funciona esto?</summary>
            <div class="hint-contenido">
              <p class="hint">Antes de contestar, el bot espera un rato aleatorio entre estos dos valores — así da tiempo a que el cliente termine de escribir varias líneas seguidas.</p>
            </div>
          </details>
          <div class="row2">
            <div>
              <label for="minDelay">Espera mínima (segundos)</label>
              <input type="number" id="minDelay" min="0">
            </div>
            <div>
              <label for="maxDelay">Espera máxima (segundos)</label>
              <input type="number" id="maxDelay" min="0">
            </div>
          </div>
        </div>

        <div class="card">
          <h2>Memoria de conversación</h2>
          <details class="ayuda">
            <summary>¿Cómo funciona esto?</summary>
            <div class="hint-contenido">
              <p class="hint">Cuántos mensajes recientes (tuyos y del cliente) recuerda el bot al responder. Más alto = más contexto, pero más costo por respuesta.</p>
            </div>
          </details>
          <label for="maxHistorial">Mensajes a recordar</label>
          <input type="number" id="maxHistorial" min="1">
        </div>

        <div class="card">
          <h2>Calificación automática de leads (por criterios, evaluados por IA)</h2>
          <details class="ayuda">
            <summary>¿Cómo funciona esto?</summary>
            <div class="hint-contenido">
              <p class="hint">Define los criterios que debe cumplir un lead para calificar. Después de cada respuesta, la IA revisa la conversación y, en cuanto se cumplen TODOS, marca la conversación con la etiqueta ✅ Califica (puedes filtrarlos y exportarlos en Chats). El envío del enlace/formulario lo hace directamente tu prompt de arriba, no este bloque.</p>
              <p class="hint">⚠️ Si activaste la casilla "Marcar como calificado automáticamente" en la tarjeta de arriba (junto al enlace), <b>esta sección se ignora por completo</b> — esa forma es más confiable porque no depende de que la IA interprete la conversación.</p>
            </div>
          </details>

          <label style="display:flex; align-items:center; gap:10px; cursor:pointer; margin-bottom:16px;">
            <input type="checkbox" id="calificacionActiva" style="width:18px; height:18px; accent-color:var(--green); cursor:pointer;">
            <span style="color:var(--text); font-size:14.5px; font-weight:500;">Activar calificación automática por criterios</span>
          </label>

          <label for="criteriosCalificacion">Criterios de calificación</label>
          <textarea id="criteriosCalificacion" rows="5" placeholder="Ej: Tiene más de 40 años.&#10;Quiere perder más de 10 kg.&#10;Es hombre."></textarea>
        </div>

        <div class="card">
          <h2>Audios y fotos pregrabados</h2>
          <details class="ayuda">
            <summary>¿Cómo funciona esto?</summary>
            <div class="hint-contenido">
              <p class="hint">Sube audios y fotos, y ponles un nombre corto (sin espacios). Úsalos en cualquier <b>prompt</b> (general o de una etapa) o en los mensajes de <b>seguimientos</b> con los marcadores <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">[[audio:nombre]]</code> o <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">[[foto:nombre]]</code>. Le llegan al cliente como un mensaje de audio o imagen normal de Instagram. Si el mensaje tiene texto además del marcador, primero se envía el texto y luego el archivo — usa <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">[[pausa:N]]</code> entre ambos si quieres que pase N segundos de espera antes de mandar el archivo.</p>
            </div>
          </details>

          <p style="font-family:var(--display); font-weight:600; font-size:14.5px; margin:18px 0 10px;">🎤 Audios</p>
          <div id="listaAudios" style="margin-bottom:14px;"></div>
          <div class="row2" style="align-items:flex-end;">
            <div>
              <label for="audioNombre">Nombre (clave)</label>
              <input type="text" id="audioNombre" placeholder="ej: peso, bienvenida">
            </div>
            <div>
              <label for="audioArchivo">Archivo de audio</label>
              <input type="file" id="audioArchivo" accept="audio/*">
            </div>
          </div>
          <button class="add-paso" id="btnSubirAudio" type="button" style="margin-top:12px;">⬆ Subir audio</button>
          <p class="hint" id="audioSubidaMsg" style="margin:10px 0 0;"></p>

          <div style="height:1px; background:var(--border); margin:24px 0;"></div>

          <p style="font-family:var(--display); font-weight:600; font-size:14.5px; margin:0 0 10px;">🖼️ Fotos</p>
          <div id="listaFotos" style="margin-bottom:14px;"></div>
          <div class="row2" style="align-items:flex-end;">
            <div>
              <label for="fotoNombre">Nombre (clave)</label>
              <input type="text" id="fotoNombre" placeholder="ej: antes_despues1, gimnasio">
            </div>
            <div>
              <label for="fotoArchivo">Archivo de imagen</label>
              <input type="file" id="fotoArchivo" accept="image/*">
            </div>
          </div>
          <button class="add-paso" id="btnSubirFoto" type="button" style="margin-top:12px;">⬆ Subir foto</button>
          <p class="hint" id="fotoSubidaMsg" style="margin:10px 0 0;"></p>

          <div style="height:1px; background:var(--border); margin:24px 0;"></div>

          <p style="font-family:var(--display); font-weight:600; font-size:14.5px; margin:0 0 5px;">🎙️ Si un audio del CLIENTE no se puede transcribir</p>
          <p class="hint" style="margin:0 0 10px;">Cuando un lead te manda un audio, el bot lo transcribe con IA para poder entenderlo y responder. Si por lo que sea la transcripción falla (error de red, archivo raro, etc.), en vez de quedarse callado le manda uno de estos mensajes pidiéndole que lo vuelva a mandar — rotan entre ellos para no sonar repetitivo. Uno por línea.</p>
          <textarea id="mensajesErrorAudio" rows="5" placeholder="Ej: Se me cortó tu audio, no me llegó completo. ¿me lo puedes volver a mandar?"></textarea>
        </div>

        <div class="card card-destacada">
          <h2>🎯 Disparadores automáticos generales (envío garantizado)</h2>
          <details class="ayuda">
            <summary>¿Cómo funciona esto?</summary>
            <div class="hint-contenido">
              <p class="hint">La IA no siempre es consistente decidiendo cuándo incluir un <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">[[audio:...]]</code> o <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">[[foto:...]]</code> en su respuesta — a veces sí, a veces no. Acá puedes configurar palabras o frases que, en cuanto aparezcan en el mensaje del cliente, manden algo <b>SIEMPRE, por código, sin depender de la IA</b>. Puedes elegir mandar un solo audio, una sola foto, o el tipo <b>📝 Mensaje</b> para combinar texto + fotos + audios + pausas en una sola secuencia (con los mismos marcadores de siempre). Si la IA ya lo mandó ella misma en esa misma respuesta (solo aplica a audio/foto simples), no se duplica.<br><br><b>Estos disparadores son el respaldo general:</b> si el lead está en una etapa que tiene sus propios disparadores (ver "Etapas de la conversación"), primero se revisan los de esa etapa; solo si NINGUNO de esos coincide con lo que escribió el cliente, se cae a revisar esta lista de aquí.<br><br>Toma el ícono ⠿ de cada disparador para arrastrarlo y cambiar su orden — importa sobre todo si tienes varios marcados como "Exclusivo": si dos coinciden a la vez, gana el que esté primero en la lista.</p>
            </div>
          </details>
          <div id="listaDisparadores"></div>
          <button class="add-paso" id="addDisparador" type="button">+ Agregar disparador general</button>
        </div>

        <div class="card">
          <h2>Enlace de calificación (calendario / formulario)</h2>
          <details class="ayuda">
            <summary>¿Cómo funciona esto?</summary>
            <div class="hint-contenido">
              <p class="hint">Pega aquí el enlace exacto que tu prompt manda cuando un lead ya calificó (por ejemplo tu link de Calendly o de un formulario). El sistema NO lo envía — solo lo usa para detectar cuándo tu bot ya se lo mandó al cliente. En cuanto lo detecta en una respuesta, le pone la etiqueta 🔗 <b>para siempre</b> (no se quita nunca) y activa el seguimiento especial de abajo. Ese seguimiento especial <b>se mantiene activo aunque el lead responda algo en el medio</b> (ej. "gracias") — solo se pasa al seguimiento normal una vez que ya se mandaron TODOS los pasos configurados abajo.</p>
            </div>
          </details>
          <label for="enlaceCalificacion">Enlace a detectar</label>
          <input type="text" id="enlaceCalificacion" placeholder="https://calendly.com/tu-usuario/...">
          <span class="enlace-tag">Debe coincidir tal cual aparece en el mensaje que manda el bot</span>
          <br>
          <span class="pausa-tag">Tip: en tu prompt escribe algo como "Perfecto, te dejo el enlace por aquí 👇[[pausa:6]]https://tu-enlace..." para que el enlace llegue solo, en su propio mensaje.</span>

          <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer; margin:18px 0 0; padding:12px 14px; border-radius:10px; background:var(--green-soft); border:1px solid rgba(49,217,124,.3);">
            <input type="checkbox" id="calificarAutomaticoConEnlace" style="width:18px; height:18px; accent-color:var(--green); cursor:pointer; margin-top:1px; flex-shrink:0;">
            <span style="color:var(--text); font-size:14px; font-weight:500; line-height:1.55;">
              🏷️ Marcar como calificado AUTOMÁTICAMENTE en cuanto se manda este enlace (sin evaluar los criterios con IA). Recomendado si tu flujo de etapas ya está diseñado para solo llegar a este enlace cuando el lead realmente calificó — es 100% determinista, así que no vas a ver inconsistencias entre leads con el mismo perfil. Si lo activas, la calificación por criterios de abajo se ignora.
            </span>
          </label>

          <div style="height:1px; background:var(--border); margin:24px 0;"></div>

          <h2 style="margin-bottom:5px;">Seguimiento especial a ese enlace</h2>
          <details class="ayuda">
            <summary>¿Cómo funciona esto?</summary>
            <div class="hint-contenido">
              <p class="hint">Se dispara solo con los leads a los que ya se les mandó el enlace de arriba. Las horas se cuentan desde el momento en que se envió el enlace, no desde el último mensaje del cliente. También puedes usar marcadores <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">[[audio:...]]</code> / <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">[[foto:...]]</code> / <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">[[pausa:N]]</code> en estos mensajes. Con la casilla <b>"Solo enviar si el mensaje anterior ya está visto"</b> puedes hacer que un paso específico espere a que el cliente haya leído lo último que le mandaste (usando el estado de "visto" de Instagram) antes de mandarle ese seguimiento — si todavía no lo ha visto, simplemente espera y lo vuelve a revisar más tarde, sin cancelar el envío.</p>
            </div>
          </details>

          <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer; margin:0 0 18px; padding:12px 14px; border-radius:10px; background:var(--green-soft); border:1px solid rgba(49,217,124,.3);">
            <input type="checkbox" id="pararSeguimientosSiAgendoEnlace" style="width:18px; height:18px; accent-color:var(--green); cursor:pointer; margin-top:1px; flex-shrink:0;">
            <span style="color:var(--text); font-size:14px; font-weight:500; line-height:1.55;">
              📅 NO mandar más de estos seguimientos a leads marcados como "AGENDÓ" (ver la casilla en cada Transición). Aquí es donde más sentido tiene: es en este seguimiento donde el lead normalmente confirma si ya agendó o no — en cuanto lo confirme, esta casilla detiene tanto estos seguimientos del enlace como los normales (es la misma opción que en la tarjeta de "Seguimientos automáticos").
            </span>
          </label>

          <div style="padding:12px 14px; border-radius:10px; background:rgba(63,199,232,.08); border:1px solid rgba(63,199,232,.3); margin:0 0 18px;">
            <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer;">
              <input type="checkbox" id="franjaHorariaActivaEnlace" style="width:18px; height:18px; accent-color:#3FC7E8; cursor:pointer; margin-top:1px; flex-shrink:0;">
              <span style="color:var(--text); font-size:14px; font-weight:500; line-height:1.55;">
                🌙 Solo mandar dentro de esta franja horaria (hora de México) — es la misma opción que en "Seguimientos automáticos", aplica a ambos tipos por igual.
              </span>
            </label>
          </div>

          <div id="pasosEnlace"></div>
          <button class="add-paso" id="addPasoEnlace" type="button">+ Agregar paso de seguimiento al enlace</button>
        </div>

        <div class="card">
          <h2>Seguimientos automáticos</h2>
          <details class="ayuda">
            <summary>¿Cómo funciona esto?</summary>
            <div class="hint-contenido">
              <p class="hint">Si el cliente deja de responder, el bot le manda estos mensajes después de X horas de silencio (siempre dentro de la ventana de 24h que permite Instagram). Cada paso rota entre varias opciones de mensaje para no sonar repetitivo. Estos NO se usan si ya se le mandó el enlace de calificación. También puedes usar marcadores <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">[[audio:...]]</code> / <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">[[foto:...]]</code> / <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">[[pausa:N]]</code> en cualquiera de estos mensajes. Con la casilla <b>"Solo enviar si el mensaje anterior ya está visto"</b> algunos pasos pueden esperar a que el cliente haya leído tu último mensaje antes de mandarle ese paso — útil para, por ejemplo, mandar 3 seguimientos siempre y que los siguientes 4 solo se manden una vez que sepas que de verdad está viendo la conversación.</p>
            </div>
          </details>

          <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer; margin:0 0 14px; padding:12px 14px; border-radius:10px; background:var(--red-soft); border:1px solid rgba(255,93,93,.3);">
            <input type="checkbox" id="noSeguirSiNoCalifica" style="width:18px; height:18px; accent-color:var(--red); cursor:pointer; margin-top:1px; flex-shrink:0;">
            <span style="color:var(--text); font-size:14px; font-weight:500; line-height:1.55;">
              🚫 NO mandar ninguno de estos seguimientos a leads marcados como "NO CALIFICA" (ver la casilla en cada Transición). Útil si quieres dejar de insistirle a alguien que ya se auto-descartó con un criterio duro (ej. dijo tener menos de 40 años, o que quiere subir de peso en vez de bajar).
            </span>
          </label>

          <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer; margin:0 0 18px; padding:12px 14px; border-radius:10px; background:var(--green-soft); border:1px solid rgba(49,217,124,.3);">
            <input type="checkbox" id="pararSeguimientosSiAgendo" style="width:18px; height:18px; accent-color:var(--green); cursor:pointer; margin-top:1px; flex-shrink:0;">
            <span style="color:var(--text); font-size:14px; font-weight:500; line-height:1.55;">
              📅 NO mandar NINGÚN seguimiento (ni estos normales, ni los especiales del enlace) a leads marcados como "AGENDÓ" (ver la casilla en cada Transición). Esta etiqueta es distinta de solo "enlace enviado" — se pone cuando el lead CONFIRMA con sus propias palabras que ya reservó su espacio, no solo cuando se le mandó el link.
            </span>
          </label>

          <div style="padding:12px 14px; border-radius:10px; background:rgba(63,199,232,.08); border:1px solid rgba(63,199,232,.3); margin:0 0 18px;">
            <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer;">
              <input type="checkbox" id="franjaHorariaActiva" style="width:18px; height:18px; accent-color:#3FC7E8; cursor:pointer; margin-top:1px; flex-shrink:0;">
              <span style="color:var(--text); font-size:14px; font-weight:500; line-height:1.55;">
                🌙 Solo mandar seguimientos dentro de esta franja horaria (hora de México) — aplica tanto a estos seguimientos normales como a los especiales del enlace. Si a un seguimiento le toca fuera de este rango (ej. de madrugada), se espera y se manda en cuanto se entre a la franja, sin perderse.
              </span>
            </label>
            <div style="display:flex; align-items:center; gap:12px; margin-top:12px; margin-left:28px;">
              <label style="display:flex; align-items:center; gap:6px; font-size:13px; color:var(--muted);">
                Desde
                <input type="time" id="franjaHorariaDesde" style="background:var(--surface-3); border:1px solid var(--border); color:var(--text); border-radius:7px; padding:6px 8px; font-size:13px; font-family:var(--body);">
              </label>
              <label style="display:flex; align-items:center; gap:6px; font-size:13px; color:var(--muted);">
                Hasta
                <input type="time" id="franjaHorariaHasta" style="background:var(--surface-3); border:1px solid var(--border); color:var(--text); border-radius:7px; padding:6px 8px; font-size:13px; font-family:var(--body);">
              </label>
            </div>
          </div>

          <div id="pasos"></div>
          <button class="add-paso" id="addPaso" type="button">+ Agregar paso de seguimiento</button>
        </div>
      </div>

      <div class="col">
        <div class="card card-etapas">
          <h2>🧭 Etapas de la conversación</h2>
          <details class="ayuda">
            <summary>¿Cómo funcionan las etapas?</summary>
            <div class="hint-contenido">
              <p class="hint">
                Cada lead puede estar en una <b>etapa</b> (o en ninguna, y entonces usa el prompt general de la izquierda).
                Sirve para que preguntas de "sí/no" no se crucen entre distintos momentos de la conversación: si en la
                etapa "precio" un "sí" debe hacer una cosa y en la etapa "agendar" otro "sí" debe hacer algo distinto,
                cada etapa solo conoce SU propio prompt — la IA no ve las demás preguntas sí/no al mismo tiempo.
              </p>
              <p class="hint">
                Hay <b>tres formas</b> de mover a un lead de etapa (las configuras dentro de cada transición):<br><br>
                <b>1) Palabra exacta:</b> el mensaje del cliente debe ser ESA palabra/frase y nada más — ideal para un CTA
                de video tipo "mándame la palabra DIETA", donde no quieres que dispare si solo menciona "dieta" hablando
                de otra cosa.<br><br>
                <b>2) Contiene la frase:</b> dispara aunque la palabra esté en medio de una oración más larga.<br><br>
                <b>3) Según una condición (la evalúa la IA):</b> para cosas que no son una palabra fija, como "el cliente
                dijo que tiene 40 años o más" o "ya mencionó cuál es su objetivo". La IA revisa el mensaje y el contexto
                reciente y decide si se cumple — solo se usa cuando ninguna transición por palabra coincidió primero, así
                que no le agrega costo a las etapas que no la necesitan. Como es una evaluación de IA, no acierta el 100%
                de las veces — si notas que a veces no pasa de etapa cuando debería, revisa los logs de Render: cada
                evaluación deja un registro tipo <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">🔍 Condición #0 (...) -&gt; ¿cumplida?: no</code>
                que te dice exactamente qué decidió. Para que acierte más seguido, sé lo más específico posible en el
                texto de la condición (ej. "el cliente confirmó explícitamente que sí quiere agendar una llamada" en vez
                de solo "quiere agendar"), y evita condiciones ambiguas o que dependan de inferencias muy sutiles.<br><br>
                También existe el marcador <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">[[etapa:clave]]</code>
                dentro del prompt, como método manual/adicional — pero como depende de que la IA decida ponerlo, puede
                fallar; las tres formas de arriba son las confiables. También puedes cambiar la etapa de un lead a mano
                desde <a href="/chats">Chats</a>.
              </p>
              <p class="hint">
                <b>Orden y prioridad:</b> las transiciones de cada etapa se revisan en el orden en que están en la
                lista, y gana la PRIMERA que coincida. Usa el ícono ⠿ de cada transición para arrastrarla y cambiar
                su orden — útil cuando tienes varias que podrían coincidir con el mismo mensaje y quieres asegurar
                cuál se evalúa primero.
              </p>
              <p class="hint">
                Toma el ícono ⠿ de cada tarjeta y arrástrala arriba o abajo para reordenar tus etapas (por ejemplo,
                para meter una etapa nueva antes de la primera) sin tener que borrar y volver a crear nada.
              </p>
              <p class="hint">
                <b>🚪 Etapa de entrada:</b> marca esta casilla dentro de una etapa para que TODOS los leads nuevos
                entren directo ahí (con su mensaje fijo, si le pusiste uno) sin necesidad de ninguna palabra clave —
                ideal cuando ya sabes por qué CTA o campaña llegan. Desmárcala cuando quieras que los leads nuevos
                vuelvan a empezar por el prompt general de la izquierda. Solo puede haber una etapa de entrada a la vez.
              </p>
            </div>
          </details>

          <div class="etapa-subseccion" style="border-top:none; margin-top:0; padding-top:0;">
            <p class="etapa-subseccion-titulo">🔀 Transiciones generales (para ENTRAR a una etapa, cuando el lead todavía no tiene ninguna)</p>
            <p class="hint" style="margin:0 0 10px;">Si el cliente escribe alguna de estas frases mientras todavía no está en ninguna etapa, entra GARANTIZADO a la etapa que elijas — sin depender del prompt general.</p>
            <label class="etapa-entrada-check" style="margin-bottom:14px;">
              <input type="checkbox" id="transGeneralesElegirMejor">
              <span>🎯 Si hay varias transiciones tipo "condición" aquí, que la IA elija cuál es la MEJOR (en vez de la primera que diga que sí) — útil cuando tienes varias condiciones que podrían solaparse entre sí</span>
            </label>
            <div id="listaTransicionesGenerales"></div>
            <button class="add-paso" id="addTransicionGeneral" type="button">+ Agregar transición general</button>
          </div>

          <div style="height:1px; background:var(--border); margin:22px 0;"></div>

          <div id="listaEtapas"></div>
          <button class="add-paso" id="addEtapa" type="button">+ Agregar etapa</button>
        </div>
      </div>
    </div>
  </div>
  </div>
  </div>

  <div class="savebar">
    <div class="savebar-inner">
      <button class="save-btn" id="btnGuardar" disabled>Guardar cambios</button>
      <span class="save-msg" id="saveMsg"></span>
    </div>
  </div>

<script>
  async function llamarGET(endpoint){
    const res = await fetch(endpoint);
    if(res.status === 401){ window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname); return null; }
    return res.json();
  }
  async function llamarPOST(endpoint, body){
    const res = await fetch(endpoint, {
      method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body || {})
    });
    if(res.status === 401){ window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname); return null; }
    return res.json();
  }

  function pintarEstado(activo){
    document.getElementById("dot").className = "status-dot" + (activo ? "" : " off");
    document.getElementById("statTexto").textContent = activo ? "Activo" : "Apagado";
    document.getElementById("statValor").className = "header-status-value" + (activo ? " green" : " red");
  }

  async function actualizarEstado(){
    const data = await llamarGET("/bot/estado");
    if(data) pintarEstado(data.activo);
  }
  document.getElementById("btnOn").addEventListener("click", async () => { await llamarGET("/bot/encender"); actualizarEstado(); });
  document.getElementById("btnOff").addEventListener("click", async () => { await llamarGET("/bot/apagar"); actualizarEstado(); });

  document.getElementById("btnVerClave").addEventListener("click", () => {
    const input = document.getElementById("openaiKey");
    input.type = input.type === "password" ? "text" : "password";
  });

  document.getElementById("btnVerClaveCalendly").addEventListener("click", () => {
    const input = document.getElementById("calendlyToken");
    input.type = input.type === "password" ? "text" : "password";
  });

  // --- Seguimientos normales: editor dinámico ---
  let pasos = [];

  function renderPasos(){
    const cont = document.getElementById("pasos");
    cont.innerHTML = "";
    pasos.forEach((paso, i) => {
      const div = document.createElement("div");
      div.className = "paso";
      div.innerHTML = \`
        <div class="paso-head">
          <span class="eyebrow-num">PASO \${i + 1}</span>
          <button type="button" class="quitar" data-i="\${i}">quitar</button>
        </div>
        <label>Horas de silencio antes de disparar</label>
        <input type="number" step="0.1" min="0" class="paso-horas" data-i="\${i}" value="\${paso.horas}" style="margin-bottom:10px;">
        <label>Mensajes (uno por línea, rotan entre ellos)</label>
        <textarea class="paso-mensajes" data-i="\${i}" rows="3" style="margin-bottom:10px;">\${(paso.mensajes || []).join("\\n")}</textarea>
        <label style="display:flex; align-items:flex-start; gap:9px; cursor:pointer; margin:0;">
          <input type="checkbox" class="paso-solo-visto" data-i="\${i}"\${paso.solo_si_visto ? " checked" : ""} style="width:16px; height:16px; accent-color:var(--green); cursor:pointer; margin-top:1px; flex-shrink:0;">
          <span style="color:var(--text); font-size:13.5px; font-weight:500; line-height:1.45;">👁️ Solo enviar si el mensaje anterior ya está visto (si no, espera y lo reintenta después)</span>
        </label>
      \`;
      cont.appendChild(div);
    });
    cont.querySelectorAll(".quitar").forEach(b => b.addEventListener("click", e => {
      pasos.splice(+e.target.dataset.i, 1); renderPasos();
    }));
  }

  document.getElementById("addPaso").addEventListener("click", () => {
    pasos.push({ horas: 1, mensajes: ["Escribe aquí un mensaje de seguimiento..."], solo_si_visto: false });
    renderPasos();
  });

  function leerPasosDelDOM(){
    document.querySelectorAll(".paso-horas").forEach((input, i) => { pasos[i].horas = parseFloat(input.value) || 0; });
    document.querySelectorAll(".paso-mensajes").forEach((ta, i) => {
      pasos[i].mensajes = ta.value.split("\\n").map(m => m.trim()).filter(Boolean);
    });
    document.querySelectorAll(".paso-solo-visto").forEach((chk, i) => { pasos[i].solo_si_visto = chk.checked; });
  }

  // --- Seguimiento especial al enlace: mismo patrón, otro contenedor ---
  let pasosEnlace = [];

  function renderPasosEnlace(){
    const cont = document.getElementById("pasosEnlace");
    cont.innerHTML = "";
    pasosEnlace.forEach((paso, i) => {
      const div = document.createElement("div");
      div.className = "paso";
      div.innerHTML = \`
        <div class="paso-head">
          <span class="eyebrow-num">PASO \${i + 1}</span>
          <button type="button" class="quitar-enlace" data-i="\${i}">quitar</button>
        </div>
        <label>Horas desde que se envió el enlace, antes de disparar</label>
        <input type="number" step="0.1" min="0" class="paso-enlace-horas" data-i="\${i}" value="\${paso.horas}" style="margin-bottom:10px;">
        <label>Mensajes (uno por línea, rotan entre ellos)</label>
        <textarea class="paso-enlace-mensajes" data-i="\${i}" rows="3" style="margin-bottom:10px;">\${(paso.mensajes || []).join("\\n")}</textarea>
        <label style="display:flex; align-items:flex-start; gap:9px; cursor:pointer; margin:0;">
          <input type="checkbox" class="paso-enlace-solo-visto" data-i="\${i}"\${paso.solo_si_visto ? " checked" : ""} style="width:16px; height:16px; accent-color:var(--green); cursor:pointer; margin-top:1px; flex-shrink:0;">
          <span style="color:var(--text); font-size:13.5px; font-weight:500; line-height:1.45;">👁️ Solo enviar si el mensaje anterior ya está visto (si no, espera y lo reintenta después)</span>
        </label>
      \`;
      cont.appendChild(div);
    });
    cont.querySelectorAll(".quitar-enlace").forEach(b => b.addEventListener("click", e => {
      pasosEnlace.splice(+e.target.dataset.i, 1); renderPasosEnlace();
    }));
  }

  document.getElementById("addPasoEnlace").addEventListener("click", () => {
    pasosEnlace.push({ horas: 4, mensajes: ["Ey, ¿cómo vas? ¿Pudiste encontrar un espacio que te quede bien?"], solo_si_visto: false });
    renderPasosEnlace();
  });

  // Las dos casillas de "parar seguimientos si agendó" (una en Seguimientos
  // automáticos, otra en Seguimiento especial al enlace) representan la
  // MISMA opción global — se mantienen sincronizadas entre sí para que no
  // parezca que son cosas distintas, sin importar desde cuál de las dos la
  // actives.
  document.getElementById("pararSeguimientosSiAgendo").addEventListener("change", (e) => {
    document.getElementById("pararSeguimientosSiAgendoEnlace").checked = e.target.checked;
  });
  document.getElementById("pararSeguimientosSiAgendoEnlace").addEventListener("change", (e) => {
    document.getElementById("pararSeguimientosSiAgendo").checked = e.target.checked;
  });

  // Mismo patrón para la franja horaria: es una sola opción global que
  // aplica a ambos tipos de seguimiento por igual, con dos casillas
  // (una en cada tarjeta) sincronizadas entre sí.
  document.getElementById("franjaHorariaActiva").addEventListener("change", (e) => {
    document.getElementById("franjaHorariaActivaEnlace").checked = e.target.checked;
  });
  document.getElementById("franjaHorariaActivaEnlace").addEventListener("change", (e) => {
    document.getElementById("franjaHorariaActiva").checked = e.target.checked;
  });

  function leerPasosEnlaceDelDOM(){
    document.querySelectorAll(".paso-enlace-horas").forEach((input, i) => { pasosEnlace[i].horas = parseFloat(input.value) || 0; });
    document.querySelectorAll(".paso-enlace-mensajes").forEach((ta, i) => {
      pasosEnlace[i].mensajes = ta.value.split("\\n").map(m => m.trim()).filter(Boolean);
    });
    document.querySelectorAll(".paso-enlace-solo-visto").forEach((chk, i) => { pasosEnlace[i].solo_si_visto = chk.checked; });
  }

  // --- Disparadores automáticos: helpers reutilizables (generales y por etapa) ---
  let disparadores = [];
  let audiosDisponibles = {};
  let fotosDisponibles = {};

  function opcionesClaveHTML(tipo, claveSeleccionada){
    const almacen = tipo === "audio" ? audiosDisponibles : fotosDisponibles;
    const claves = Object.keys(almacen || {});
    if(claves.length === 0){
      return '<option value="">(no hay ninguno subido todavía)</option>';
    }
    return claves.map(c => \`<option value="\${c}"\${c === claveSeleccionada ? " selected" : ""}>\${c}</option>\`).join("");
  }

  function renderDisparadoresEnContenedor(cont, lista, prefijoClase, alCambiar){
    if(lista.length === 0){
      cont.innerHTML = '<p class="hint" style="margin:0 0 12px;">Todavía no hay disparadores configurados.</p>';
      return;
    }
    cont.innerHTML = "";
    lista.forEach((d, i) => {
      const div = document.createElement("div");
      div.className = "paso";
      const esMensaje = d.tipo === "mensaje";
      const esSoloEtiqueta = d.tipo === "etiqueta";
      const campoContenido = esMensaje ? \`
        <label>Contenido del mensaje (acepta <code style="background:var(--surface-3); padding:1px 5px; border-radius:4px; font-family:var(--mono); font-size:12px;">[[audio:clave]]</code>, <code style="background:var(--surface-3); padding:1px 5px; border-radius:4px; font-family:var(--mono); font-size:12px;">[[foto:clave]]</code>, <code style="background:var(--surface-3); padding:1px 5px; border-radius:4px; font-family:var(--mono); font-size:12px;">[[pausa:N]]</code> — se manda TAL CUAL, sin pasar por la IA)</label>
        <textarea class="\${prefijoClase}-contenido" data-i="\${i}" rows="3" placeholder="Ej: Te dejo un audio con más detalles[[pausa:3]][[audio:precio]]¿Qué te parece?">\${(d.contenido || "").replace(/</g,"&lt;")}</textarea>
      \` : esSoloEtiqueta ? \`
        <p class="hint" style="margin:0;">Este tipo no manda ningún contenido — solo pone la etiqueta que escribas abajo. Útil para, por ejemplo, marcar desde el principio con qué recurso llegó un lead (ej. "Dieta"), y usarla después en otra etapa con coincidencia "por etiqueta" para saber qué mandarle.</p>
      \` : \`
        <label>Cuál mandar</label>
        <select class="\${prefijoClase}-clave" data-i="\${i}">\${opcionesClaveHTML(d.tipo, d.clave)}</select>
      \`;
      div.innerHTML = \`
        <div class="paso-head">
          <div class="paso-head-izq">
            <span class="fila-drag-handle" title="Arrastra para reordenar" draggable="true">⠿</span>
            <span class="eyebrow-num">DISPARADOR \${i + 1}</span>
          </div>
          <button type="button" class="\${prefijoClase}-quitar" data-i="\${i}">quitar</button>
        </div>
        <label>\${d.coincidencia === "etiqueta" ? "Etiqueta(s) que lo activan (una por línea) — si el lead YA tiene alguna de estas etiquetas puestas" : "Palabras o frases que lo activan (una por línea)"}</label>
        <textarea class="\${prefijoClase}-frases" data-i="\${i}" rows="3" placeholder="\${d.coincidencia === "etiqueta" ? "ej: Dieta" : "ej: precio\\ncuanto cuesta\\ninversion"}" style="margin-bottom:6px;">\${(d.frases || []).join("\\n")}</textarea>
        <p class="hint" style="margin:0 0 10px; font-size:12.5px;">Con "CUALQUIERA" o "EXACTAMENTE", cada línea es una alternativa distinta. Con "COMBINACIONES", cada línea es un grupo de palabras separadas por coma que TIENEN que estar TODAS presentes (ej. una línea "cansancio, estetico" activa solo si el mensaje trae las dos); puedes poner varias líneas-combinación distintas (ej. otra línea "hipertension, estetico") y con que se cumpla CUALQUIERA de ellas, activa. Con "POR ETIQUETA", en vez de revisar el mensaje, revisa si el lead YA TIENE alguna de las etiquetas escritas arriba puestas — 100% determinista, no depende del mensaje actual.</p>
        <label>¿Cómo debe coincidir?</label>
        <select class="\${prefijoClase}-coincidencia" data-i="\${i}" style="margin-bottom:10px;">
          <option value="contiene"\${d.coincidencia !== "exacta" && d.coincidencia !== "combinaciones" && d.coincidencia !== "etiqueta" ? " selected" : ""}>Contiene CUALQUIERA de las frases (una por una)</option>
          <option value="exacta"\${d.coincidencia === "exacta" ? " selected" : ""}>El mensaje es EXACTAMENTE una de esas frases</option>
          <option value="combinaciones"\${d.coincidencia === "combinaciones" ? " selected" : ""}>Combinaciones (grupos de palabras con coma, ej. "cansancio, estetico")</option>
          <option value="etiqueta"\${d.coincidencia === "etiqueta" ? " selected" : ""}>🏷️ Por etiqueta (si el lead ya tiene alguna de estas etiquetas puestas)</option>
        </select>
        <div class="row2" style="margin-bottom:10px;">
          <div>
            <label>Tipo</label>
            <select class="\${prefijoClase}-tipo" data-i="\${i}">
              <option value="audio"\${d.tipo === "audio" ? " selected" : ""}>🎤 Audio</option>
              <option value="foto"\${d.tipo === "foto" ? " selected" : ""}>🖼️ Foto</option>
              <option value="mensaje"\${esMensaje ? " selected" : ""}>📝 Mensaje (texto + fotos + audios + pausas combinados)</option>
              <option value="etiqueta"\${esSoloEtiqueta ? " selected" : ""}>🏷️ Solo agregar etiqueta (no manda nada)</option>
            </select>
          </div>
          <div>
            <label>Espera antes de enviarlo (segundos)</label>
            <input type="number" step="0.5" min="0" class="\${prefijoClase}-pausa" data-i="\${i}" value="\${d.pausa_segundos ?? 2}">
          </div>
        </div>
        \${campoContenido}
        <label style="margin-top:10px;">🏷️ Etiqueta a agregar al activarse (opcional\${esSoloEtiqueta ? ", obligatoria para este tipo" : ", además de mandar el contenido de arriba"})</label>
        <input type="text" class="\${prefijoClase}-etiqueta-agregar" data-i="\${i}" placeholder="Ej: Dieta" value="\${(d.etiqueta_a_agregar || "").replace(/"/g,"&quot;")}" style="margin-bottom:10px;">
        <label style="display:flex; align-items:flex-start; gap:9px; cursor:pointer; margin-top:10px;">
          <input type="checkbox" class="\${prefijoClase}-exclusivo" data-i="\${i}"\${d.exclusivo ? " checked" : ""} style="width:16px; height:16px; accent-color:var(--green); cursor:pointer; margin-top:1px; flex-shrink:0;">
          <span style="color:var(--text); font-size:13.5px; font-weight:500; line-height:1.45;">🚫 Exclusivo — al activarse, el prompt NO responde nada este turno (solo se manda este disparador)</span>
        </label>
        <label style="display:flex; align-items:flex-start; gap:9px; cursor:pointer; margin-top:10px;">
          <input type="checkbox" class="\${prefijoClase}-solo-entrar" data-i="\${i}"\${d.solo_al_entrar_a_etapa ? " checked" : ""} style="width:16px; height:16px; accent-color:#FFC542; cursor:pointer; margin-top:1px; flex-shrink:0;">
          <span style="color:var(--text); font-size:13.5px; font-weight:500; line-height:1.45;">🚪 Solo al ENTRAR a esta etapa — nunca se dispara en mensajes posteriores dentro de la misma etapa. Imprescindible si usas coincidencia "por etiqueta" (si no, se repetiría en cada mensaje, ya que la etiqueta es permanente).</span>
        </label>
      \`;
      cont.appendChild(div);
    });
    cont.querySelectorAll(\`.\${prefijoClase}-quitar\`).forEach(b => b.addEventListener("click", e => {
      alCambiar();
      lista.splice(+e.target.dataset.i, 1);
      renderDisparadoresEnContenedor(cont, lista, prefijoClase, alCambiar);
    }));
    cont.querySelectorAll(\`.\${prefijoClase}-tipo\`).forEach(sel => sel.addEventListener("change", () => {
      alCambiar();
      renderDisparadoresEnContenedor(cont, lista, prefijoClase, alCambiar);
    }));
    cont.querySelectorAll(\`.\${prefijoClase}-coincidencia\`).forEach(sel => sel.addEventListener("change", () => {
      alCambiar();
      renderDisparadoresEnContenedor(cont, lista, prefijoClase, alCambiar);
    }));
    habilitarArrastreDeFilas(cont, lista, alCambiar, () => renderDisparadoresEnContenedor(cont, lista, prefijoClase, alCambiar));
  }

  // Se lee por "data-i" (no por posición) porque el campo de contenido
  // cambia según el tipo: un disparador "mensaje" no tiene el select de
  // "cuál mandar", y viceversa — si se leyera por posición, los valores de
  // un disparador podrían mezclarse con los de otro.
  function leerDisparadoresDeContenedor(lista, prefijoClase){
    document.querySelectorAll(\`.\${prefijoClase}-frases\`).forEach((ta) => {
      const i = +ta.dataset.i;
      if(!lista[i]) return;
      lista[i].frases = ta.value.split("\\n").map(f => f.trim()).filter(Boolean);
    });
    document.querySelectorAll(\`.\${prefijoClase}-coincidencia\`).forEach((sel) => {
      const i = +sel.dataset.i;
      if(!lista[i]) return;
      lista[i].coincidencia = sel.value;
    });
    document.querySelectorAll(\`.\${prefijoClase}-tipo\`).forEach((sel) => {
      const i = +sel.dataset.i;
      if(!lista[i]) return;
      lista[i].tipo = sel.value;
    });
    document.querySelectorAll(\`.\${prefijoClase}-pausa\`).forEach((input) => {
      const i = +input.dataset.i;
      if(!lista[i]) return;
      lista[i].pausa_segundos = parseFloat(input.value) || 0;
    });
    document.querySelectorAll(\`.\${prefijoClase}-clave\`).forEach((sel) => {
      const i = +sel.dataset.i;
      if(!lista[i]) return;
      lista[i].clave = sel.value;
    });
    document.querySelectorAll(\`.\${prefijoClase}-contenido\`).forEach((ta) => {
      const i = +ta.dataset.i;
      if(!lista[i]) return;
      lista[i].contenido = ta.value;
    });
    document.querySelectorAll(\`.\${prefijoClase}-exclusivo\`).forEach((chk) => {
      const i = +chk.dataset.i;
      if(!lista[i]) return;
      lista[i].exclusivo = chk.checked;
    });
    document.querySelectorAll(\`.\${prefijoClase}-etiqueta-agregar\`).forEach((input) => {
      const i = +input.dataset.i;
      if(!lista[i]) return;
      lista[i].etiqueta_a_agregar = input.value.trim();
    });
    document.querySelectorAll(\`.\${prefijoClase}-solo-entrar\`).forEach((chk) => {
      const i = +chk.dataset.i;
      if(!lista[i]) return;
      lista[i].solo_al_entrar_a_etapa = chk.checked;
    });
  }

  function renderDisparadores(){
    renderDisparadoresEnContenedor(document.getElementById("listaDisparadores"), disparadores, "disp-gen", leerDisparadoresDelDOM);
  }
  function leerDisparadoresDelDOM(){
    leerDisparadoresDeContenedor(disparadores, "disp-gen");
  }

  // --- Transiciones automáticas de etapa por palabra clave (generales y por etapa) ---
  function opcionesEtapaDestinoHTML(claveSeleccionada, incluirSalir){
    let opciones = "";
    if(incluirSalir){
      opciones += \`<option value=""\${claveSeleccionada === "" ? " selected" : ""}>↩ Salir de etapas (usar prompt general)</option>\`;
    }
    const claves = etapas.filter(e => e.clave);
    if(claves.length === 0 && !incluirSalir){
      return '<option value="">(crea al menos una etapa primero)</option>';
    }
    opciones += claves.map(e => \`<option value="\${e.clave}"\${e.clave === claveSeleccionada ? " selected" : ""}>\${(e.nombre || e.clave).replace(/</g,"&lt;")}</option>\`).join("");
    return opciones;
  }

  function renderTransicionesEnContenedor(cont, lista, prefijoClase, alCambiar, incluirSalir){
    if(lista.length === 0){
      cont.innerHTML = '<p class="hint" style="margin:0 0 12px;">Todavía no hay transiciones configuradas.</p>';
      return;
    }
    cont.innerHTML = "";
    lista.forEach((t, i) => {
      const div = document.createElement("div");
      div.className = "paso";
      const esCondicion = t.coincidencia === "condicion";
      const campoActivador = esCondicion ? \`
        <label>Condición a evaluar (en lenguaje natural — la revisa la IA en cada mensaje)</label>
        <textarea class="\${prefijoClase}-condicion" data-i="\${i}" rows="2" placeholder='Ej: "El cliente mencionó tener 40 años de edad o más"' style="margin-bottom:10px;">\${(t.condicion || "").replace(/</g,"&lt;")}</textarea>
      \` : \`
        <label>\${t.coincidencia === "etiqueta" ? "Etiqueta(s) que la activan (una por línea) — si el lead YA tiene alguna de estas puestas" : "Palabras o frases que la activan (una por línea)"}</label>
        <textarea class="\${prefijoClase}-frases" data-i="\${i}" rows="3" placeholder="\${t.coincidencia === "etiqueta" ? "ej: Dieta" : "ej: si\\nsí quiero\\nme interesa\\n(o, si eliges Combinaciones: cansancio, estetico)"}" style="margin-bottom:6px;">\${(t.frases || []).join("\\n")}</textarea>
        \${t.coincidencia === "combinaciones" ? '<p class="hint" style="margin:0 0 10px; font-size:12.5px;">Cada línea es un grupo de palabras separadas por coma que TIENEN que estar TODAS presentes (ej. "cansancio, estetico"). Puedes poner varias líneas-combinación distintas; con que se cumpla CUALQUIERA, se activa.</p>' : ''}
        \${t.coincidencia === "etiqueta" ? '<p class="hint" style="margin:0 0 10px; font-size:12.5px;">En vez de revisar el mensaje, revisa si el lead YA TIENE alguna de estas etiquetas puestas (100% determinista, no depende de lo que escriba en ese momento) — útil, por ejemplo, para saber en la etapa "no califica" qué recurso pidió al inicio, usando una etiqueta que le pusiste desde la etapa de entrada.</p>' : ''}
      \`;
      div.innerHTML = \`
        <div class="paso-head">
          <div class="paso-head-izq">
            <span class="fila-drag-handle" title="Arrastra para reordenar" draggable="true">⠿</span>
            <span class="eyebrow-num">TRANSICIÓN \${i + 1}</span>
          </div>
          <button type="button" class="\${prefijoClase}-quitar" data-i="\${i}">quitar</button>
        </div>
        <label>¿Cómo debe activarse?</label>
        <select class="\${prefijoClase}-coincidencia" data-i="\${i}" style="margin-bottom:10px;">
          <option value="contiene"\${t.coincidencia !== "exacta" && t.coincidencia !== "condicion" && t.coincidencia !== "combinaciones" && t.coincidencia !== "etiqueta" ? " selected" : ""}>Contiene la frase en cualquier parte del mensaje</option>
          <option value="exacta"\${t.coincidencia === "exacta" ? " selected" : ""}>El mensaje es EXACTAMENTE esa palabra/frase</option>
          <option value="combinaciones"\${t.coincidencia === "combinaciones" ? " selected" : ""}>Combinaciones (grupos de palabras con coma, ej. "cansancio, estetico")</option>
          <option value="etiqueta"\${t.coincidencia === "etiqueta" ? " selected" : ""}>🏷️ Por etiqueta (si el lead ya tiene alguna de estas etiquetas puestas)</option>
          <option value="condicion"\${esCondicion ? " selected" : ""}>Según una condición (la evalúa la IA)</option>
        </select>
        \${campoActivador}
        <label>Mover a la etapa</label>
        <select class="\${prefijoClase}-destino" data-i="\${i}" style="margin-bottom:10px;">\${opcionesEtapaDestinoHTML(t.etapa_destino, incluirSalir)}</select>
        <label style="display:flex; align-items:center; gap:9px; cursor:pointer; margin:0 0 10px;">
          <input type="checkbox" class="\${prefijoClase}-silenciosa" data-i="\${i}"\${t.silenciosa ? " checked" : ""} style="width:16px; height:16px; accent-color:#C99BFF; cursor:pointer;">
          <span style="color:var(--text); font-size:13.5px; font-weight:500;">🔇 No responder nada al activarse (solo cambia de etapa)</span>
        </label>
        <label style="display:flex; align-items:center; gap:9px; cursor:pointer; margin:0;">
          <input type="checkbox" class="\${prefijoClase}-no-califica" data-i="\${i}"\${t.no_califica ? " checked" : ""} style="width:16px; height:16px; accent-color:var(--red); cursor:pointer;">
          <span style="color:var(--text); font-size:13.5px; font-weight:500;">🚫 Marcar como "NO CALIFICA" al activarse (para excluirlo de seguimientos, si lo configuras así)</span>
        </label>
        \${t.no_califica ? \`
        <label style="margin-top:10px;">Motivo (opcional, se guarda como referencia)</label>
        <input type="text" class="\${prefijoClase}-motivo-no-califica" data-i="\${i}" value="\${(t.motivo_no_califica || "").replace(/"/g,"&quot;")}" placeholder="Ej: Menor de 40 años">
        \` : ''}
        <label style="display:flex; align-items:center; gap:9px; cursor:pointer; margin:10px 0 0;">
          <input type="checkbox" class="\${prefijoClase}-agendo" data-i="\${i}"\${t.agendo ? " checked" : ""} style="width:16px; height:16px; accent-color:var(--green); cursor:pointer;">
          <span style="color:var(--text); font-size:13.5px; font-weight:500;">📅 Marcar como "AGENDÓ" al activarse (detiene sus seguimientos, si lo configuras así)</span>
        </label>
        <label style="display:flex; align-items:center; gap:9px; cursor:pointer; margin:10px 0 0;">
          <input type="checkbox" class="\${prefijoClase}-verificar-calendly" data-i="\${i}"\${t.verificar_calendly ? " checked" : ""} style="width:16px; height:16px; accent-color:#FFC542; cursor:pointer;">
          <span style="color:var(--text); font-size:13.5px; font-weight:500;">📆 Verificar EN VIVO en Calendly antes de activarse (si no encuentra la reserva, no cambia de etapa y le pide confirmar día/hora)</span>
        </label>
      \`;
      cont.appendChild(div);
    });
    cont.querySelectorAll(\`.\${prefijoClase}-no-califica\`).forEach(chk => chk.addEventListener("change", () => {
      alCambiar();
      renderTransicionesEnContenedor(cont, lista, prefijoClase, alCambiar, incluirSalir);
    }));
    cont.querySelectorAll(\`.\${prefijoClase}-quitar\`).forEach(b => b.addEventListener("click", e => {
      alCambiar();
      lista.splice(+e.target.dataset.i, 1);
      renderTransicionesEnContenedor(cont, lista, prefijoClase, alCambiar, incluirSalir);
    }));
    cont.querySelectorAll(\`.\${prefijoClase}-coincidencia\`).forEach(sel => sel.addEventListener("change", () => {
      alCambiar();
      renderTransicionesEnContenedor(cont, lista, prefijoClase, alCambiar, incluirSalir);
    }));
    habilitarArrastreDeFilas(cont, lista, alCambiar, () => renderTransicionesEnContenedor(cont, lista, prefijoClase, alCambiar, incluirSalir));
  }

  // Se lee por "data-i" (no por posición en la lista de elementos) porque el
  // campo de activación cambia según el modo: una transición en modo
  // "condición" no tiene textarea de frases, y viceversa — si se leyera por
  // posición, los valores de una transición podrían mezclarse con los de otra.
  function leerTransicionesDeContenedor(lista, prefijoClase){
    document.querySelectorAll(\`.\${prefijoClase}-coincidencia\`).forEach((sel) => {
      const i = +sel.dataset.i;
      if(!lista[i]) return;
      lista[i].coincidencia = sel.value;
    });
    document.querySelectorAll(\`.\${prefijoClase}-frases\`).forEach((ta) => {
      const i = +ta.dataset.i;
      if(!lista[i]) return;
      lista[i].frases = ta.value.split("\\n").map(f => f.trim()).filter(Boolean);
    });
    document.querySelectorAll(\`.\${prefijoClase}-condicion\`).forEach((ta) => {
      const i = +ta.dataset.i;
      if(!lista[i]) return;
      lista[i].condicion = ta.value.trim();
    });
    document.querySelectorAll(\`.\${prefijoClase}-destino\`).forEach((sel) => {
      const i = +sel.dataset.i;
      if(!lista[i]) return;
      lista[i].etapa_destino = sel.value;
    });
    document.querySelectorAll(\`.\${prefijoClase}-silenciosa\`).forEach((chk) => {
      const i = +chk.dataset.i;
      if(!lista[i]) return;
      lista[i].silenciosa = chk.checked;
    });
    document.querySelectorAll(\`.\${prefijoClase}-no-califica\`).forEach((chk) => {
      const i = +chk.dataset.i;
      if(!lista[i]) return;
      lista[i].no_califica = chk.checked;
    });
    document.querySelectorAll(\`.\${prefijoClase}-motivo-no-califica\`).forEach((input) => {
      const i = +input.dataset.i;
      if(!lista[i]) return;
      lista[i].motivo_no_califica = input.value;
    });
    document.querySelectorAll(\`.\${prefijoClase}-agendo\`).forEach((chk) => {
      const i = +chk.dataset.i;
      if(!lista[i]) return;
      lista[i].agendo = chk.checked;
    });
    document.querySelectorAll(\`.\${prefijoClase}-verificar-calendly\`).forEach((chk) => {
      const i = +chk.dataset.i;
      if(!lista[i]) return;
      lista[i].verificar_calendly = chk.checked;
    });
  }

  let transicionesGenerales = [];

  function renderTransicionesGenerales(){
    renderTransicionesEnContenedor(document.getElementById("listaTransicionesGenerales"), transicionesGenerales, "trans-gen", leerTransicionesGeneralesDelDOM, false);
  }
  function leerTransicionesGeneralesDelDOM(){
    leerTransicionesDeContenedor(transicionesGenerales, "trans-gen");
  }

  document.getElementById("addTransicionGeneral").addEventListener("click", () => {
    leerTransicionesGeneralesDelDOM();
    if(etapas.filter(e => e.clave).length === 0){
      alert("Primero crea al menos una etapa para poder mandar al lead hacia ella.");
      return;
    }
    transicionesGenerales.push({ frases: [], etapa_destino: etapas.find(e => e.clave)?.clave || "", coincidencia: "contiene", condicion: "", silenciosa: false, no_califica: false, motivo_no_califica: "", agendo: false, verificar_calendly: false });
    renderTransicionesGenerales();
  });

  document.getElementById("addDisparador").addEventListener("click", () => {
    leerDisparadoresDelDOM();
    disparadores.push({ frases: [], tipo: "audio", clave: "", contenido: "", pausa_segundos: 2, coincidencia: "contiene", exclusivo: false, etiqueta_a_agregar: "", solo_al_entrar_a_etapa: false });
    renderDisparadores();
  });

  // --- Etapas de la conversación ---
  let etapas = [];
  let indiceEtapaArrastrando = null;

  // --- Arrastrar y soltar genérico para filas ("paso") dentro de un
  // contenedor — reutilizado por disparadores y transiciones (generales y
  // por etapa), ya que ambos funcionan por PRIORIDAD: se revisan en el
  // orden de la lista y gana la primera que coincida. "arrastreGenerico"
  // guarda también una referencia al contenedor de origen, para no mezclar
  // un arrastre iniciado en una lista con el drop de otra lista distinta
  // (ej. no confundir los disparadores de la etapa A con los de la etapa B).
  let arrastreGenerico = null;

  function habilitarArrastreDeFilas(cont, lista, alCambiar, renderDeNuevo){
    cont.querySelectorAll(".fila-drag-handle").forEach(handle => {
      handle.addEventListener("dragstart", () => {
        const fila = handle.closest(".paso");
        const indice = Array.from(cont.children).indexOf(fila);
        arrastreGenerico = { cont, indice };
        fila.classList.add("arrastrando");
      });
      handle.addEventListener("dragend", () => {
        cont.querySelectorAll(".paso").forEach(f => f.classList.remove("arrastrando", "arrastrando-sobre"));
        arrastreGenerico = null;
      });
    });

    cont.querySelectorAll(".paso").forEach(fila => {
      fila.addEventListener("dragover", (e) => {
        if(!arrastreGenerico || arrastreGenerico.cont !== cont) return;
        e.preventDefault();
        fila.classList.add("arrastrando-sobre");
      });
      fila.addEventListener("dragleave", () => fila.classList.remove("arrastrando-sobre"));
      fila.addEventListener("drop", (e) => {
        e.preventDefault();
        fila.classList.remove("arrastrando-sobre");
        if(!arrastreGenerico || arrastreGenerico.cont !== cont) return;

        const indiceDestino = Array.from(cont.children).indexOf(fila);
        const indiceOrigen = arrastreGenerico.indice;
        arrastreGenerico = null;
        if(indiceDestino === indiceOrigen) return;

        alCambiar();
        const [movido] = lista.splice(indiceOrigen, 1);
        let nuevaPosicion = indiceDestino;
        if(indiceOrigen < indiceDestino) nuevaPosicion -= 1;
        lista.splice(nuevaPosicion, 0, movido);
        renderDeNuevo();
      });
    });
  }


  function slugify(txt){
    return (txt || "").trim().toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  }

  function renderEtapas(){
    const cont = document.getElementById("listaEtapas");
    if(etapas.length === 0){
      cont.innerHTML = '<p class="hint" style="margin:0 0 12px;">Todavía no has creado ninguna etapa. Mientras no tengas etapas, todo el bot usa el prompt general de la izquierda.</p>';
      return;
    }
    cont.innerHTML = "";
    etapas.forEach((et, i) => {
      const div = document.createElement("div");
      div.className = "etapa-card";
      div.dataset.i = i;
      div.innerHTML = \`
        <div class="etapa-card-head">
          <div class="etapa-card-head-izq">
            <span class="etapa-drag-handle" title="Arrastra para reordenar" draggable="true">⠿</span>
            <span class="eyebrow-num">ETAPA \${i + 1}\${et.nombre ? " · " + et.nombre.replace(/</g,"&lt;") : ""}</span>
            \${et.entrada ? '<span class="etapa-entrada-badge">🚪 ENTRADA</span>' : ""}
          </div>
          <button type="button" class="etapa-quitar" data-i="\${i}">quitar etapa</button>
        </div>
        <label class="etapa-entrada-check">
          <input type="checkbox" class="etapa-entrada" data-i="\${i}"\${et.entrada ? " checked" : ""}>
          <span>🚪 Etapa de entrada — los leads NUEVOS entran directo aquí, sin necesidad de ninguna palabra clave (si tienes otra marcada, se desmarca sola)</span>
        </label>
        <div class="row2" style="margin-bottom:12px;">
          <div>
            <label>Nombre para mostrar</label>
            <input type="text" class="etapa-nombre" data-i="\${i}" value="\${(et.nombre || "").replace(/"/g,"&quot;")}" placeholder="ej: Preguntando objetivo">
          </div>
          <div>
            <label>Clave (para el marcador [[etapa:clave]])</label>
            <input type="text" class="etapa-clave" data-i="\${i}" value="\${et.clave || ""}" placeholder="ej: objetivo">
          </div>
        </div>
        <label>Prompt de esta etapa (reemplaza al general mientras el lead esté aquí)</label>
        <textarea class="etapa-prompt" data-i="\${i}" rows="6" placeholder="Ej: Ahora solo pregunta cuál es su objetivo principal. Si responde que sí quiere que le expliques un plan, incluye [[etapa:plan]] al final. Si responde que no, sigue platicando sin insistir.">\${(et.prompt || "").replace(/</g,"&lt;")}</textarea>

        <div class="etapa-subseccion">
          <p class="etapa-subseccion-titulo">📌 Mensaje(s) fijo(s) al ENTRAR a esta etapa (opcional)</p>
          <details class="ayuda">
            <summary>¿Cómo funciona esto?</summary>
            <div class="hint-contenido">
              <p class="hint">
                Si lo llenas, en cuanto un lead entre a esta etapa (por palabra clave o por condición) se manda este
                texto TAL CUAL, carácter por carácter — sin pasar por la IA en absoluto. Útil cuando necesitas un
                control total del texto exacto (incluso con errores intencionales) o mandar un audio/foto justo al
                entrar. Acepta los mismos marcadores de siempre:
                <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">[[audio:clave]]</code>,
                <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">[[foto:clave]]</code>,
                <code style="background:var(--surface-3); padding:2px 6px; border-radius:5px; font-family:var(--mono);">[[pausa:N]]</code>.
                Si lo dejas vacío, la etapa responde normal con su prompt de arriba (y con la IA). Tiene prioridad sobre
                la opción "no responder nada" de la transición que trajo al lead aquí.
              </p>
              <p class="hint">
                <b>Un mensaje por línea.</b> Si pones varios (ej. 10 casos de éxito distintos), cada vez que un lead
                entre a esta etapa se manda uno diferente, rotando en orden — así no se repite siempre el mismo. Si
                solo pones uno, se manda siempre ese.
              </p>
            </div>
          </details>
          <textarea class="etapa-mensaje-fijo" data-i="\${i}" rows="4" placeholder="Ej: La salud es un tema importante, hay que solucionarlo cuanto antes[[audio:salud]]¿Te hace sentido esto?&#10;María bajó 15kg en 3 meses[[foto:caso1]]¿Te gustaría lograr algo similar?">\${(et.mensajes_fijos || []).join("\\n").replace(/</g,"&lt;")}</textarea>
        </div>

        <div class="etapa-subseccion">
          <p class="etapa-subseccion-titulo">🎯 Disparadores propios de esta etapa (opcional)</p>
          <details class="ayuda">
            <summary>¿Cómo funciona esto?</summary>
            <div class="hint-contenido">
              <p class="hint">Si una palabra coincide aquí, se activa este disparador (audio, foto, o un <b>📝 Mensaje</b> combinando texto + fotos + audios + pausas) y NO se revisan los disparadores generales. Si el mensaje del cliente no coincide con ninguno de aquí, se cae a los disparadores generales de la izquierda.</p>
            </div>
          </details>
          <div class="etapa-disparadores" data-i="\${i}"></div>
          <button type="button" class="add-paso etapa-add-disparador" data-i="\${i}">+ Agregar disparador de esta etapa</button>
        </div>

        <div class="etapa-subseccion">
          <p class="etapa-subseccion-titulo">🔀 Transiciones automáticas de SALIDA de esta etapa (por palabra clave, garantizado)</p>
          <details class="ayuda">
            <summary>¿Cómo funciona esto?</summary>
            <div class="hint-contenido">
              <p class="hint">Mientras el lead esté en ESTA etapa, si escribe alguna de estas frases, se mueve GARANTIZADO a la etapa que elijas (o vuelve al prompt general) — sin depender de que la IA ponga el marcador [[etapa:...]].</p>
            </div>
          </details>
          <label class="etapa-entrada-check" style="margin-bottom:14px;">
            <input type="checkbox" class="etapa-elegir-mejor" data-i="\${i}"\${et.elegir_mejor_condicion ? " checked" : ""}>
            <span>🎯 Si hay varias transiciones tipo "condición" en esta etapa, que la IA elija cuál es la MEJOR (en vez de la primera que diga que sí) — útil cuando tienes varias condiciones que podrían solaparse entre sí</span>
          </label>
          <label class="etapa-entrada-check" style="margin-bottom:14px;">
            <input type="checkbox" class="etapa-requiere-pregunta" data-i="\${i}"\${et.requiere_pregunta_final ? " checked" : ""}>
            <span>❓ Esta etapa SIEMPRE debe terminar con una pregunta — si la IA se le olvida (pasa a veces, sobre todo al resolver dudas), el sistema le pide automáticamente que la vuelva a escribir incluyéndola, antes de mandarla</span>
          </label>
          <div class="etapa-transiciones" data-i="\${i}"></div>
          <button type="button" class="add-paso etapa-add-transicion" data-i="\${i}">+ Agregar transición de esta etapa</button>
        </div>
      \`;
      cont.appendChild(div);
    });

    cont.querySelectorAll(".etapa-quitar").forEach(b => b.addEventListener("click", e => {
      leerEtapasDelDOM();
      etapas.splice(+e.target.dataset.i, 1);
      renderEtapas();
    }));

    // Solo puede haber UNA etapa de entrada: al marcar una, se desmarcan
    // todas las demás (un lead nuevo solo puede arrancar en un solo lugar).
    cont.querySelectorAll(".etapa-entrada").forEach(chk => chk.addEventListener("change", (e) => {
      leerEtapasDelDOM();
      const i = +e.target.dataset.i;
      if(etapas[i].entrada){
        etapas.forEach((et, j) => { if(j !== i) et.entrada = false; });
      }
      renderEtapas();
    }));

    // --- Arrastrar y soltar para reordenar etapas ---
    // El handle (⠿) es lo único con draggable="true"; al arrancar el
    // arrastre desde ahí, el navegador arrastra la tarjeta completa
    // (.etapa-card) porque es el elemento padre más cercano.
    cont.querySelectorAll(".etapa-drag-handle").forEach(handle => {
      handle.addEventListener("dragstart", (e) => {
        const tarjeta = handle.closest(".etapa-card");
        indiceEtapaArrastrando = +tarjeta.dataset.i;
        tarjeta.classList.add("arrastrando");
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", String(indiceEtapaArrastrando)); } catch (err) {}
      });
      handle.addEventListener("dragend", () => {
        cont.querySelectorAll(".etapa-card").forEach(c => c.classList.remove("arrastrando", "arrastrando-sobre"));
        indiceEtapaArrastrando = null;
      });
    });

    cont.querySelectorAll(".etapa-card").forEach(tarjeta => {
      tarjeta.addEventListener("dragover", (e) => {
        if(indiceEtapaArrastrando === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        tarjeta.classList.add("arrastrando-sobre");
      });
      tarjeta.addEventListener("dragleave", () => {
        tarjeta.classList.remove("arrastrando-sobre");
      });
      tarjeta.addEventListener("drop", (e) => {
        e.preventDefault();
        tarjeta.classList.remove("arrastrando-sobre");
        if(indiceEtapaArrastrando === null) return;
        const indiceDestino = +tarjeta.dataset.i;
        if(indiceDestino === indiceEtapaArrastrando){ indiceEtapaArrastrando = null; return; }

        leerEtapasDelDOM();
        const [movida] = etapas.splice(indiceEtapaArrastrando, 1);
        let nuevaPosicion = indiceDestino;
        if(indiceEtapaArrastrando < indiceDestino) nuevaPosicion -= 1;
        etapas.splice(nuevaPosicion, 0, movida);
        indiceEtapaArrastrando = null;
        renderEtapas();
      });
    });

    cont.querySelectorAll(".etapa-disparadores").forEach(subcont => {
      const i = +subcont.dataset.i;
      if(!etapas[i].disparadores) etapas[i].disparadores = [];
      const prefijo = "etapa" + i + "-disp";
      renderDisparadoresEnContenedor(subcont, etapas[i].disparadores, prefijo, () => leerDisparadoresDeContenedor(etapas[i].disparadores, prefijo));
    });

    cont.querySelectorAll(".etapa-add-disparador").forEach(b => b.addEventListener("click", (e) => {
      leerEtapasDelDOM();
      const i = +e.target.dataset.i;
      if(!etapas[i].disparadores) etapas[i].disparadores = [];
      etapas[i].disparadores.push({ frases: [], tipo: "audio", clave: "", contenido: "", pausa_segundos: 2, coincidencia: "contiene", exclusivo: false, etiqueta_a_agregar: "", solo_al_entrar_a_etapa: false });
      renderEtapas();
    }));

    cont.querySelectorAll(".etapa-transiciones").forEach(subcont => {
      const i = +subcont.dataset.i;
      if(!etapas[i].transiciones) etapas[i].transiciones = [];
      const prefijo = "etapa" + i + "-trans";
      renderTransicionesEnContenedor(subcont, etapas[i].transiciones, prefijo, () => leerTransicionesDeContenedor(etapas[i].transiciones, prefijo), true);
    });

    cont.querySelectorAll(".etapa-add-transicion").forEach(b => b.addEventListener("click", (e) => {
      leerEtapasDelDOM();
      const i = +e.target.dataset.i;
      if(!etapas[i].transiciones) etapas[i].transiciones = [];
      etapas[i].transiciones.push({ frases: [], etapa_destino: "", coincidencia: "contiene", condicion: "", silenciosa: false, no_califica: false, motivo_no_califica: "", agendo: false, verificar_calendly: false });
      renderEtapas();
    }));
  }

  function leerEtapasDelDOM(){
    document.querySelectorAll(".etapa-nombre").forEach((input, i) => { if(etapas[i]) etapas[i].nombre = input.value; });
    document.querySelectorAll(".etapa-clave").forEach((input, i) => { if(etapas[i]) etapas[i].clave = slugify(input.value); });
    document.querySelectorAll(".etapa-prompt").forEach((ta, i) => { if(etapas[i]) etapas[i].prompt = ta.value; });
    document.querySelectorAll(".etapa-mensaje-fijo").forEach((ta, i) => { if(etapas[i]) etapas[i].mensajes_fijos = ta.value.split("\\n").map(m => m.trim()).filter(Boolean); });
    document.querySelectorAll(".etapa-entrada").forEach((chk, i) => { if(etapas[i]) etapas[i].entrada = chk.checked; });
    document.querySelectorAll(".etapa-elegir-mejor").forEach((chk, i) => { if(etapas[i]) etapas[i].elegir_mejor_condicion = chk.checked; });
    document.querySelectorAll(".etapa-requiere-pregunta").forEach((chk, i) => { if(etapas[i]) etapas[i].requiere_pregunta_final = chk.checked; });
    document.querySelectorAll(".etapa-disparadores").forEach(subcont => {
      const i = +subcont.dataset.i;
      if(!etapas[i]) return;
      leerDisparadoresDeContenedor(etapas[i].disparadores || [], "etapa" + i + "-disp");
    });
    document.querySelectorAll(".etapa-transiciones").forEach(subcont => {
      const i = +subcont.dataset.i;
      if(!etapas[i]) return;
      leerTransicionesDeContenedor(etapas[i].transiciones || [], "etapa" + i + "-trans");
    });
  }

  document.getElementById("addEtapa").addEventListener("click", () => {
    leerEtapasDelDOM();
    etapas.push({ clave: "", nombre: "", prompt: "", mensajes_fijos: [], entrada: false, elegir_mejor_condicion: false, requiere_pregunta_final: false, disparadores: [], transiciones: [] });
    renderEtapas();
  });

  async function cargarConfig(){
    const cfg = await llamarGET("/config");
    const msg = document.getElementById("saveMsg");
    if(!cfg){
      msg.textContent = "⚠️ No se pudo cargar la configuración — no toques 'Guardar' todavía.";
      msg.className = "save-msg";
      msg.style.color = "var(--red)";
      return;
    }
    document.getElementById("prompt").value = cfg.ai_prompt || "";
    document.getElementById("contextoBase").value = cfg.contexto_base || "";
    document.getElementById("minDelay").value = cfg.min_delay ?? 8;
    document.getElementById("maxDelay").value = cfg.max_delay ?? 15;
    document.getElementById("maxHistorial").value = cfg.max_historial ?? 20;
    document.getElementById("calificacionActiva").checked = Boolean(cfg.calificacion_activa);
    document.getElementById("calificarAutomaticoConEnlace").checked = Boolean(cfg.calificar_automatico_con_enlace);
    document.getElementById("noSeguirSiNoCalifica").checked = Boolean(cfg.no_seguir_si_no_califica);
    document.getElementById("pararSeguimientosSiAgendo").checked = Boolean(cfg.parar_seguimientos_si_agendo);
    document.getElementById("pararSeguimientosSiAgendoEnlace").checked = Boolean(cfg.parar_seguimientos_si_agendo);
    document.getElementById("franjaHorariaActiva").checked = Boolean(cfg.franja_horaria_activa);
    document.getElementById("franjaHorariaActivaEnlace").checked = Boolean(cfg.franja_horaria_activa);
    document.getElementById("franjaHorariaDesde").value = cfg.franja_horaria_desde || "08:00";
    document.getElementById("franjaHorariaHasta").value = cfg.franja_horaria_hasta || "23:00";
    document.getElementById("mensajesErrorAudio").value = Array.isArray(cfg.mensajes_error_audio) ? cfg.mensajes_error_audio.join("\\n") : "";
    document.getElementById("criteriosCalificacion").value = cfg.criterios_calificacion || "";
    document.getElementById("enlaceCalificacion").value = cfg.enlace_calificacion || "";
    document.getElementById("calendlyPregunta").value = cfg.calendly_pregunta_instagram || "";
    pintarEstadoClave(cfg);
    pintarEstadoCalendly(cfg);
    pasos = Array.isArray(cfg.seguimientos) ? JSON.parse(JSON.stringify(cfg.seguimientos)) : [];
    renderPasos();
    pasosEnlace = Array.isArray(cfg.seguimientos_enlace) ? JSON.parse(JSON.stringify(cfg.seguimientos_enlace)) : [];
    renderPasosEnlace();
    audiosDisponibles = cfg.audios || {};
    fotosDisponibles = cfg.fotos || {};
    renderAudios(cfg.audios || {});
    renderFotos(cfg.fotos || {});
    disparadores = Array.isArray(cfg.disparadores) ? JSON.parse(JSON.stringify(cfg.disparadores)) : [];
    renderDisparadores();
    etapas = Array.isArray(cfg.etapas) ? JSON.parse(JSON.stringify(cfg.etapas)) : [];
    transicionesGenerales = Array.isArray(cfg.transiciones_generales) ? JSON.parse(JSON.stringify(cfg.transiciones_generales)) : [];
    document.getElementById("transGeneralesElegirMejor").checked = Boolean(cfg.transiciones_generales_elegir_mejor);
    renderEtapas();
    renderTransicionesGenerales();
    document.getElementById("btnGuardar").disabled = false;
  }

  function renderAudios(audios){
    const cont = document.getElementById("listaAudios");
    const claves = Object.keys(audios || {});
    if(claves.length === 0){
      cont.innerHTML = '<p class="hint" style="margin:0 0 4px;">Todavía no has subido ningún audio.</p>';
      return;
    }
    cont.innerHTML = claves.map(clave => {
      const a = audios[clave];
      return \`
        <div class="audio-item" data-clave="\${clave}">
          <div class="audio-info">
            <div class="audio-clave">[[audio:\${clave}]]</div>
            <div class="audio-nombre">\${(a.nombre_original || clave).replace(/</g,"&lt;")}</div>
          </div>
          <audio controls src="\${a.url}"></audio>
          <button type="button" class="quitar btn-audio-quitar" data-clave="\${clave}">quitar</button>
        </div>
      \`;
    }).join("");

    cont.querySelectorAll(".btn-audio-quitar").forEach(btn => {
      btn.addEventListener("click", async () => {
        const clave = btn.dataset.clave;
        if(!confirm('¿Eliminar el audio "' + clave + '"? Ya no se podrá usar en el prompt.')) return;
        btn.disabled = true; btn.textContent = "eliminando…";
        const data = await llamarPOST("/audios/eliminar", { clave });
        if(data && !data.error){
          const cfgActualizado = await llamarGET("/config");
          if(cfgActualizado){ audiosDisponibles = cfgActualizado.audios || {}; renderAudios(audiosDisponibles); renderDisparadores(); renderEtapas(); }
        } else {
          alert("No se pudo eliminar: " + (data?.error || "error desconocido"));
          btn.disabled = false; btn.textContent = "quitar";
        }
      });
    });
  }

  function leerArchivoComoBase64(archivo){
    return new Promise((resolve, reject) => {
      const lector = new FileReader();
      lector.onload = () => {
        const resultado = lector.result;
        const base64 = resultado.substring(resultado.indexOf(",") + 1);
        resolve(base64);
      };
      lector.onerror = () => reject(new Error("No se pudo leer el archivo."));
      lector.readAsDataURL(archivo);
    });
  }

  document.getElementById("btnSubirAudio").addEventListener("click", async () => {
    const nombre = document.getElementById("audioNombre").value.trim();
    const inputArchivo = document.getElementById("audioArchivo");
    const archivo = inputArchivo.files?.[0];
    const msg = document.getElementById("audioSubidaMsg");
    const btn = document.getElementById("btnSubirAudio");

    msg.style.color = "";
    if(!nombre){ msg.style.color = "var(--red)"; msg.textContent = "Ponle un nombre al audio primero."; return; }
    if(!archivo){ msg.style.color = "var(--red)"; msg.textContent = "Selecciona un archivo de audio primero."; return; }

    btn.disabled = true;
    msg.textContent = "Subiendo audio…";

    try {
      const base64 = await leerArchivoComoBase64(archivo);
      const data = await llamarPOST("/audios/subir", { nombre, base64, tipo: archivo.type });
      if(data && !data.error){
        msg.style.color = "var(--green)";
        msg.textContent = "✓ Audio \\"" + data.clave + "\\" subido correctamente. Úsalo como [[audio:" + data.clave + "]]";
        document.getElementById("audioNombre").value = "";
        inputArchivo.value = "";
        const cfgActualizado = await llamarGET("/config");
        if(cfgActualizado){ audiosDisponibles = cfgActualizado.audios || {}; renderAudios(audiosDisponibles); renderDisparadores(); renderEtapas(); }
      } else {
        msg.style.color = "var(--red)";
        msg.textContent = "❌ " + (data?.error || "No se pudo subir el audio.");
      }
    } catch (err) {
      msg.style.color = "var(--red)";
      msg.textContent = "❌ Error leyendo o subiendo el archivo: " + err.message;
    } finally {
      btn.disabled = false;
    }
  });

  function renderFotos(fotos){
    const cont = document.getElementById("listaFotos");
    const claves = Object.keys(fotos || {});
    if(claves.length === 0){
      cont.innerHTML = '<p class="hint" style="margin:0 0 4px;">Todavía no has subido ninguna foto.</p>';
      return;
    }
    cont.innerHTML = claves.map(clave => {
      const f = fotos[clave];
      return \`
        <div class="audio-item" data-clave="\${clave}">
          <img src="\${f.url}" alt="" style="width:52px; height:52px; object-fit:cover; border-radius:9px; flex-shrink:0;">
          <div class="audio-info">
            <div class="audio-clave">[[foto:\${clave}]]</div>
            <div class="audio-nombre">\${(f.nombre_original || clave).replace(/</g,"&lt;")}</div>
          </div>
          <button type="button" class="quitar btn-foto-quitar" data-clave="\${clave}">quitar</button>
        </div>
      \`;
    }).join("");

    cont.querySelectorAll(".btn-foto-quitar").forEach(btn => {
      btn.addEventListener("click", async () => {
        const clave = btn.dataset.clave;
        if(!confirm('¿Eliminar la foto "' + clave + '"? Ya no se podrá usar en el prompt ni en seguimientos.')) return;
        btn.disabled = true; btn.textContent = "eliminando…";
        const data = await llamarPOST("/fotos/eliminar", { clave });
        if(data && !data.error){
          const cfgActualizado = await llamarGET("/config");
          if(cfgActualizado){ fotosDisponibles = cfgActualizado.fotos || {}; renderFotos(fotosDisponibles); renderDisparadores(); renderEtapas(); }
        } else {
          alert("No se pudo eliminar: " + (data?.error || "error desconocido"));
          btn.disabled = false; btn.textContent = "quitar";
        }
      });
    });
  }

  document.getElementById("btnSubirFoto").addEventListener("click", async () => {
    const nombre = document.getElementById("fotoNombre").value.trim();
    const inputArchivo = document.getElementById("fotoArchivo");
    const archivo = inputArchivo.files?.[0];
    const msg = document.getElementById("fotoSubidaMsg");
    const btn = document.getElementById("btnSubirFoto");

    msg.style.color = "";
    if(!nombre){ msg.style.color = "var(--red)"; msg.textContent = "Ponle un nombre a la foto primero."; return; }
    if(!archivo){ msg.style.color = "var(--red)"; msg.textContent = "Selecciona un archivo de imagen primero."; return; }

    btn.disabled = true;
    msg.textContent = "Subiendo foto…";

    try {
      const base64 = await leerArchivoComoBase64(archivo);
      const data = await llamarPOST("/fotos/subir", { nombre, base64, tipo: archivo.type });
      if(data && !data.error){
        msg.style.color = "var(--green)";
        msg.textContent = "✓ Foto \\"" + data.clave + "\\" subida correctamente. Úsala como [[foto:" + data.clave + "]]";
        document.getElementById("fotoNombre").value = "";
        inputArchivo.value = "";
        const cfgActualizado = await llamarGET("/config");
        if(cfgActualizado){ fotosDisponibles = cfgActualizado.fotos || {}; renderFotos(fotosDisponibles); renderDisparadores(); renderEtapas(); }
      } else {
        msg.style.color = "var(--red)";
        msg.textContent = "❌ " + (data?.error || "No se pudo subir la foto.");
      }
    } catch (err) {
      msg.style.color = "var(--red)";
      msg.textContent = "❌ Error leyendo o subiendo el archivo: " + err.message;
    } finally {
      btn.disabled = false;
    }
  });

  function pintarEstadoClave(cfg){
    const estadoKey = document.getElementById("keyActual");
    if(cfg.openai_api_key_configurada){
      estadoKey.textContent = "Clave actual: " + cfg.openai_api_key_mascara;
      estadoKey.style.color = "";
    } else {
      estadoKey.textContent = "⚠️ No hay ninguna clave configurada todavía.";
      estadoKey.style.color = "var(--red)";
    }
  }

  function pintarEstadoCalendly(cfg){
    const estadoKey = document.getElementById("calendlyKeyActual");
    if(cfg.calendly_token_configurado){
      estadoKey.textContent = "Token actual: " + cfg.calendly_token_mascara;
      estadoKey.style.color = "";
    } else {
      estadoKey.textContent = "⚠️ No hay ningún token configurado todavía.";
      estadoKey.style.color = "var(--red)";
    }
  }

  document.getElementById("btnGuardar").addEventListener("click", async () => {
    leerPasosDelDOM();
    leerPasosEnlaceDelDOM();
    leerDisparadoresDelDOM();
    leerEtapasDelDOM();
    leerTransicionesGeneralesDelDOM();

    if(pasos.length === 0){
      if(!confirm("No hay ningún paso de seguimiento normal configurado. ¿Seguro que quieres guardar así (se quedará sin seguimientos automáticos)?")) return;
    }
    const disparadoresSinClave = disparadores.filter(d => !d.clave);
    if(disparadoresSinClave.length > 0){
      if(!confirm("Hay " + disparadoresSinClave.length + " disparador(es) general(es) sin ningún audio/foto seleccionado. Se van a ignorar al guardar. ¿Continuar?")) return;
    }
    const etapasSinClave = etapas.filter(e => !e.clave);
    if(etapasSinClave.length > 0){
      alert("Hay " + etapasSinClave.length + " etapa(s) sin una clave válida. Ponles una clave antes de guardar.");
      return;
    }
    const clavesDuplicadas = etapas.map(e => e.clave).filter((c, i, arr) => arr.indexOf(c) !== i);
    if(clavesDuplicadas.length > 0){
      alert("Hay etapas con la misma clave repetida: " + [...new Set(clavesDuplicadas)].join(", ") + ". Cada etapa necesita una clave única.");
      return;
    }

    const body = {
      ai_prompt: document.getElementById("prompt").value,
      contexto_base: document.getElementById("contextoBase").value,
      min_delay: parseInt(document.getElementById("minDelay").value, 10),
      max_delay: parseInt(document.getElementById("maxDelay").value, 10),
      max_historial: parseInt(document.getElementById("maxHistorial").value, 10),
      seguimientos: pasos,
      seguimientos_enlace: pasosEnlace,
      calificacion_activa: document.getElementById("calificacionActiva").checked,
      calificar_automatico_con_enlace: document.getElementById("calificarAutomaticoConEnlace").checked,
      no_seguir_si_no_califica: document.getElementById("noSeguirSiNoCalifica").checked,
      parar_seguimientos_si_agendo: document.getElementById("pararSeguimientosSiAgendo").checked,
      franja_horaria_activa: document.getElementById("franjaHorariaActiva").checked,
      franja_horaria_desde: document.getElementById("franjaHorariaDesde").value || "08:00",
      franja_horaria_hasta: document.getElementById("franjaHorariaHasta").value || "23:00",
      mensajes_error_audio: document.getElementById("mensajesErrorAudio").value.split("\\n").map(m => m.trim()).filter(Boolean),
      criterios_calificacion: document.getElementById("criteriosCalificacion").value,
      enlace_calificacion: document.getElementById("enlaceCalificacion").value,
      disparadores: disparadores,
      etapas: etapas,
      transiciones_generales: transicionesGenerales,
      transiciones_generales_elegir_mejor: document.getElementById("transGeneralesElegirMejor").checked,
      calendly_pregunta_instagram: document.getElementById("calendlyPregunta").value
    };
    const nuevaClave = document.getElementById("openaiKey").value.trim();
    if(nuevaClave) body.openai_api_key = nuevaClave;
    const nuevoTokenCalendly = document.getElementById("calendlyToken").value.trim();
    if(nuevoTokenCalendly) body.calendly_token = nuevoTokenCalendly;

    const msg = document.getElementById("saveMsg");
    msg.style.color = "";
    msg.textContent = "Guardando…"; msg.className = "save-msg";
    const data = await llamarPOST("/config", body);
    if(data){
      msg.textContent = "✓ Guardado"; msg.className = "save-msg ok";
      document.getElementById("openaiKey").value = "";
      document.getElementById("calendlyToken").value = "";
      if(data.config) pintarEstadoClave(data.config);
      if(data.config) pintarEstadoCalendly(data.config);
      if(data.config && Array.isArray(data.config.etapas)) { etapas = JSON.parse(JSON.stringify(data.config.etapas)); renderEtapas(); }
      if(data.config && Array.isArray(data.config.transiciones_generales)) { transicionesGenerales = JSON.parse(JSON.stringify(data.config.transiciones_generales)); renderTransicionesGenerales(); }
    }
    setTimeout(() => { msg.textContent = ""; }, 2500);
  });

  actualizarEstado();
  cargarConfig();
</script>
</body>
</html>
  `);
});

app.get("/chats", requireAdminSesion, (req, res) => {
  res.type("html").send(`
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chats — Instagram AI Responder</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${FUENTES_HTML}
${estilosBase()}
<style>
  .chat-shell{
    display:flex; gap:18px; height:calc(100vh - 230px); min-height:460px;
  }

  .chat-list-panel{
    width:320px; flex-shrink:0; background:var(--surface); border:1px solid var(--border);
    border-radius:var(--radius-lg); display:flex; flex-direction:column; overflow:hidden;
  }
  .chat-list-head{
    padding:16px 18px; border-bottom:1px solid var(--border); display:flex;
    align-items:center; justify-content:space-between; flex-shrink:0;
  }
  .chat-list-head-title{ font-family:var(--display); font-weight:600; font-size:15.5px; }
  .live-tag{
    display:flex; align-items:center; gap:6px; font-family:var(--mono); font-size:11px;
    color:var(--muted-dim); letter-spacing:.03em;
  }
  .chat-tabs{ display:flex; gap:5px; padding:8px 10px; border-bottom:1px solid var(--border); flex-shrink:0; }
  .chat-tab{
    flex:1; text-align:center; padding:6px 4px; border-radius:7px; font-size:12px;
    font-weight:600; cursor:pointer; color:var(--muted); background:var(--surface-3);
    border:1px solid transparent; transition:background .12s, color .12s;
  }
  .chat-tab:hover{ color:var(--text); }
  .chat-tab.active{ background:var(--green-soft); color:var(--green); border-color:rgba(49,217,124,.3); }
  .chat-tab.tab-handoff.active{ background:var(--red-soft); color:var(--red); border-color:rgba(255,93,93,.3); }
  .chat-tab.tab-califica.active{ background:var(--green-soft); color:var(--green); border-color:rgba(49,217,124,.4); }
  .chat-tab.tab-nocalifica.active{ background:var(--red-soft); color:var(--red); border-color:rgba(255,93,93,.4); }
  .chat-tab.tab-agendo.active{ background:var(--green-soft); color:var(--green); border-color:rgba(49,217,124,.4); }
  .chat-tab.tab-enlace.active{ background:rgba(63,199,232,.14); color:#3FC7E8; border-color:rgba(63,199,232,.4); }
  .chat-tab.tab-seguimiento.active{ background:rgba(255,197,66,.14); color:#FFC542; border-color:rgba(255,197,66,.4); }
  .chat-tab .count{ font-family:var(--mono); font-size:10.5px; opacity:.85; margin-left:2px; }
  .califica-badge{
    font-size:11px; margin-left:7px; flex-shrink:0;
  }
  .enlace-badge{
    font-size:11px; margin-left:7px; flex-shrink:0;
  }
  .etapa-chip{
    display:inline-block; font-family:var(--mono); font-size:10.5px; color:#C99BFF;
    background:rgba(201,155,255,.12); border:1px solid rgba(201,155,255,.3); border-radius:6px;
    padding:2px 7px; margin-left:7px; flex-shrink:0; vertical-align:middle;
  }
  .etiqueta-chip-mini{
    display:inline-block; font-size:10.5px; font-weight:600; color:#FFC542;
    background:rgba(255,197,66,.12); border:1px solid rgba(255,197,66,.3); border-radius:6px;
    padding:2px 7px; margin-left:7px; flex-shrink:0; vertical-align:middle;
  }
  .handoff-dot{
    width:8px; height:8px; border-radius:50%; background:var(--red); flex-shrink:0;
    display:inline-block; margin-left:7px; box-shadow:0 0 0 2px rgba(255,93,93,.18);
  }
  .uname-row{ display:flex; align-items:center; }
  .handoff-banner{
    background:var(--red-soft); color:var(--red); font-size:13px; padding:11px 20px;
    border-bottom:1px solid rgba(255,93,93,.25); display:none; align-items:center; gap:8px;
  }
  .handoff-banner.visible{ display:flex; }
  .pausado-banner{
    background:rgba(255,197,66,.1); color:#FFC542; font-size:13px; padding:11px 20px;
    border-bottom:1px solid rgba(255,197,66,.3); display:none; align-items:center; gap:8px; font-weight:600;
  }
  .pausado-banner.visible{ display:flex; }
  .btn-pausar-bot{
    background:var(--surface-3); border:1px solid var(--border); color:var(--text);
    border-radius:20px; padding:5px 12px; font-size:11.5px; font-weight:600; cursor:pointer;
  }
  .btn-pausar-bot:hover{ border-color:#FFC542; color:#FFC542; }
  .btn-pausar-bot.activo{ background:rgba(255,197,66,.16); border-color:rgba(255,197,66,.45); color:#FFC542; }
  .chat-status-bar{
    background:var(--surface); padding:8px 14px; border-bottom:1px solid var(--border);
    display:flex; align-items:center; gap:7px; flex-wrap:wrap;
  }
  .resumen-lead{ border-bottom:1px solid var(--border); background:var(--surface); }
  .resumen-lead summary{
    cursor:pointer; list-style:none; padding:9px 14px; font-size:12.5px; font-weight:600;
    color:#C99BFF; display:flex; align-items:center; gap:8px; user-select:none;
  }
  .resumen-lead summary::-webkit-details-marker{ display:none; }
  .resumen-lead summary::before{ content:"▸"; font-size:10px; transition:transform .15s; }
  .resumen-lead[open] summary::before{ transform:rotate(90deg); }
  .resumen-lead summary:hover{ color:#DDBBFF; }
  #resumenLeadRefrescar{ cursor:pointer; opacity:.7; margin-left:auto; }
  #resumenLeadRefrescar:hover{ opacity:1; }
  .resumen-lead-contenido{ padding:2px 14px 14px 30px; }
  .resumen-lead-grid{ display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px; }
  .resumen-lead-item{
    background:var(--surface-3); border:1px solid var(--border); border-radius:9px; padding:9px 12px;
  }
  .resumen-lead-item-label{ font-size:11px; color:var(--muted); margin-bottom:3px; }
  .resumen-lead-item-valor{ font-size:13.5px; font-weight:600; color:var(--text); }
  .resumen-lead-detalle{
    margin-top:10px; font-size:13px; color:var(--muted); line-height:1.5; font-style:italic;
  }
  .resumen-lead-fecha{ margin-top:8px; font-size:11px; color:var(--muted-dim); }
  .status-sep{ color:var(--muted-dim); font-size:12px; flex-shrink:0; }
  .status-chip{
    display:inline-flex; align-items:center; font-size:11.5px; font-weight:600;
    padding:4px 9px; border-radius:20px; white-space:nowrap; cursor:default;
  }
  .status-chip-califica{ background:var(--green-soft); color:var(--green); }
  .status-chip-nocalifica{ background:var(--red-soft); color:var(--red); }
  .status-chip-agendo{ background:rgba(49,217,124,.14); color:var(--green); }
  .status-chip-enlace{ background:rgba(63,199,232,.12); color:#3FC7E8; }
  .status-select{
    background:var(--surface-3); border:1px solid var(--border); color:var(--text);
    border-radius:7px; padding:5px 8px; font-size:11.5px; font-family:var(--body); max-width:150px;
  }
  .etiquetas-lista{ display:flex; gap:5px; flex-wrap:wrap; }
  .etiqueta-chip{
    display:inline-flex; align-items:center; gap:5px; background:rgba(255,197,66,.14);
    color:#FFC542; border:1px solid rgba(255,197,66,.35); border-radius:20px;
    padding:3px 5px 3px 10px; font-size:11.5px; font-weight:600;
  }
  .etiqueta-chip button{
    background:none; border:none; color:#FFC542; cursor:pointer; font-size:13px;
    line-height:1; padding:1px 3px; opacity:.7; border-radius:50%;
  }
  .etiqueta-chip button:hover{ opacity:1; background:rgba(255,197,66,.2); }
  .btn-add-etiqueta{
    background:var(--surface-3); border:1px solid var(--border); color:var(--text);
    border-radius:20px; padding:4px 9px; font-size:11.5px; font-weight:600; cursor:pointer;
  }
  .btn-add-etiqueta:hover{ border-color:#FFC542; color:#FFC542; }
  .add-etiqueta-wrap{ position:relative; display:inline-flex; flex-shrink:0; }
  .etiqueta-popover{
    position:absolute; top:100%; left:0; margin-top:6px; background:var(--surface-2);
    border:1px solid var(--border); border-radius:10px; padding:10px; display:flex; gap:8px;
    box-shadow:0 8px 24px rgba(0,0,0,.35); z-index:20;
  }
  .etiqueta-popover input{
    background:var(--surface-3); border:1px solid var(--border); color:var(--text);
    border-radius:7px; padding:7px 10px; font-size:13px; font-family:var(--body); width:200px;
  }
  .etiqueta-popover button{
    background:#FFC542; border:none; color:#1a1a1a; border-radius:7px; padding:7px 12px;
    font-size:13px; font-weight:700; cursor:pointer; white-space:nowrap;
  }
  /* --- Barra compacta: segmento del resumen + botón resumen + exportar CSV --- */
  .chat-toolbar{
    display:flex; align-items:center; gap:6px; padding:8px 10px;
    border-bottom:1px solid var(--border); flex-shrink:0; flex-wrap:wrap;
  }
  .select-mini{
    flex:1; min-width:64px; background:var(--surface-3); border:1px solid var(--border); color:var(--text);
    border-radius:7px; padding:6px 6px; font-size:11.5px; font-family:var(--body);
  }
  .btn-mini{
    display:inline-flex; align-items:center; justify-content:center; white-space:nowrap;
    background:rgba(63,199,232,.1); color:#3FC7E8; border:1px solid rgba(63,199,232,.3);
    border-radius:7px; padding:6px 9px; font-size:11.5px; font-weight:600; cursor:pointer;
    text-decoration:none; transition:background .12s, border-color .12s; flex-shrink:0;
  }
  .btn-mini:hover:not(:disabled){ background:rgba(63,199,232,.18); }
  .btn-mini:disabled{ opacity:.6; cursor:default; }
  .chat-export{ flex-shrink:0; }
  .chat-input-bar{
    display:none; gap:10px; padding:14px 18px; border-top:1px solid var(--border);
    align-items:flex-end; flex-shrink:0;
  }
  .chat-input-bar textarea{
    flex:1; resize:none; min-height:42px; max-height:120px; background:var(--surface-3);
    border:1px solid var(--border); border-radius:10px; color:var(--text); padding:10px 12px;
    font-family:var(--body); font-size:14.5px; outline:none; line-height:1.4;
  }
  .chat-input-bar textarea:focus{ border-color:var(--green); }
  .btn-enviar{
    background:var(--green); color:#0A0D13; border:none; border-radius:10px; padding:11px 20px;
    font-family:var(--display); font-weight:600; font-size:14px; cursor:pointer; flex-shrink:0;
    transition:filter .15s;
  }
  .btn-enviar:hover{ filter:brightness(1.08); }
  .btn-enviar:disabled{ opacity:.5; cursor:default; }
  .btn-adjuntar{
    background:var(--surface-3); border:1px solid var(--border); color:var(--muted);
    border-radius:10px; width:42px; height:42px; flex-shrink:0; cursor:pointer; font-size:18px;
    display:flex; align-items:center; justify-content:center; transition:background .12s, color .12s, border-color .12s;
  }
  .btn-adjuntar:hover{ color:var(--green); border-color:var(--green); }
  .btn-adjuntar:disabled{ opacity:.5; cursor:default; }
  .btn-adjuntar.grabando{
    background:var(--red-soft); color:var(--red); border-color:rgba(255,93,93,.4);
    width:auto; padding:0 12px; font-family:var(--mono); font-size:13px; font-weight:600;
  }
  .bubble-imagen{ padding:5px !important; background:transparent !important; }
  .bubble-imagen img{ max-width:220px; max-height:280px; border-radius:12px; display:block; object-fit:cover; }
  .bubble-imagen audio{ display:block; height:38px; width:220px; }
  .menu-contextual{
    position:fixed; z-index:1000; background:var(--surface-3); border:1px solid var(--border);
    border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,.4); padding:6px; min-width:230px; display:none;
  }
  .menu-contextual.visible{ display:block; }
  .menu-contextual-item{
    display:block; width:100%; text-align:left; background:none; border:none; color:var(--red);
    padding:10px 12px; font-size:13.5px; font-weight:600; cursor:pointer; border-radius:8px;
  }
  .menu-contextual-item:hover{ background:rgba(255,93,93,.12); }
  .chat-input-error{
    padding:0 18px 12px; color:var(--red); font-size:12.5px; display:none; flex-shrink:0;
  }
  .chat-input-error.visible{ display:block; }
  .chat-list{ flex:1; overflow-y:auto; }
  .chat-list-item{
    display:flex; align-items:flex-start; gap:12px; padding:14px 18px;
    border-bottom:1px solid var(--border); cursor:pointer; transition:background .12s;
  }
  .chat-list-item:hover{ background:var(--surface-2); }
  .chat-list-item.active{ background:var(--green-soft); }
  .chat-list-item-text{ flex:1; min-width:0; }
  .chat-avatar{
    width:42px; height:42px; border-radius:50%; object-fit:cover; flex-shrink:0;
    background:var(--surface-3);
  }
  .avatar-fallback{
    display:flex; align-items:center; justify-content:center;
    color:var(--muted); font-family:var(--display); font-weight:600; font-size:16px;
  }
  .chat-list-item .uname{
    font-family:var(--display); font-weight:600; font-size:14.5px; color:var(--text);
    margin-bottom:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .chat-list-item .preview{
    font-size:13.5px; color:var(--muted); overflow:hidden; text-overflow:ellipsis;
    white-space:nowrap; margin-bottom:4px;
  }
  .chat-list-item .time{ font-size:11.5px; color:var(--muted-dim); font-family:var(--mono); }
  .vacio-lista{ color:var(--muted); font-size:14.5px; padding:20px 18px; }

  .chat-window{
    flex:1; display:flex; flex-direction:column; background:var(--surface);
    border:1px solid var(--border); border-radius:var(--radius-lg); overflow:hidden; min-width:0;
  }
  .chat-window-head{
    padding:14px 20px; border-bottom:1px solid var(--border); flex-shrink:0;
    display:flex; align-items:center; gap:12px;
  }
  .chat-window-head .chat-avatar{ width:38px; height:38px; }
  .chat-window-head-text{ min-width:0; }
  .chat-window-head-uname{
    font-family:var(--display); font-weight:600; font-size:15px; color:var(--text);
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .chat-window-head-id{ font-family:var(--mono); font-size:11px; color:var(--muted-dim); margin-top:1px; }
  .chat-messages{
    flex:1; overflow-y:auto; padding:22px; display:flex; flex-direction:column; gap:12px;
  }
  .bubble-row{ display:flex; flex-direction:column; max-width:70%; }
  .bubble-row.user{ align-self:flex-start; align-items:flex-start; }
  .bubble-row.assistant{ align-self:flex-end; align-items:flex-end; }
  .bubble{
    padding:11px 15px; border-radius:15px; font-size:14.5px; line-height:1.55;
    white-space:pre-wrap; word-break:break-word;
  }
  .bubble-row.user .bubble{ background:var(--surface-3); color:var(--text); border-bottom-left-radius:4px; }
  .bubble-row.assistant .bubble{ background:var(--green); color:#04140D; border-bottom-right-radius:4px; }
  .bubble-time{ font-size:11px; color:var(--muted-dim); margin-top:4px; font-family:var(--mono); padding:0 3px; }
  .chat-empty{
    flex:1; display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:15px;
  }
  @media (max-width:860px){
    .chat-shell{ flex-direction:column; height:auto; }
    .chat-list-panel{ width:100%; max-height:280px; }
    .chat-window{ min-height:420px; }
  }
</style>
</head>
<body>
  <div class="app-shell">
  ${sidebarHTML("chats")}
  <div class="content-area">
  <div class="main">
    <div class="page-header">
      <div class="page-header-left">
        <p class="page-eyebrow">Instagram</p>
        <h1 class="page-title">Chats en vivo</h1>
      </div>
    </div>
    <p class="page-sub">Conversaciones de la cuenta de Instagram conectada. La lista y el chat abierto se actualizan solos cada pocos segundos.</p>

    <div class="chat-shell">
      <div class="chat-list-panel">
        <div class="chat-list-head">
          <span class="chat-list-head-title">Conversaciones</span>
          <span class="live-tag"><span class="status-dot"></span>en vivo</span>
        </div>
        <div class="chat-tabs">
          <div class="chat-tab active" id="tabTodas" data-filtro="todas" title="Todas">Todas <span class="count" id="countTodas"></span></div>
          <div class="chat-tab tab-califica" id="tabCalifica" data-filtro="califica" title="Califica">✅ <span class="count" id="countCalifica"></span></div>
          <div class="chat-tab tab-nocalifica" id="tabNoCalifica" data-filtro="nocalifica" title="No Califica">🚫 <span class="count" id="countNoCalifica"></span></div>
          <div class="chat-tab tab-agendo" id="tabAgendo" data-filtro="agendo" title="Agendó">📅 <span class="count" id="countAgendo"></span></div>
          <div class="chat-tab tab-enlace" id="tabEnlace" data-filtro="enlace" title="Enlace enviado">🔗 <span class="count" id="countEnlace"></span></div>
          <div class="chat-tab tab-handoff" id="tabHandoff" data-filtro="handoff" title="Handoff (+24h)">⏰ <span class="count" id="countHandoff"></span></div>
          <div class="chat-tab tab-seguimiento" id="tabSeguimiento" data-filtro="seguimiento" title="Seguimiento pendiente (handoff, sin contar los que ya agendaron o no califican)">🔁 <span class="count" id="countSeguimiento"></span></div>
        </div>
        <div class="chat-toolbar">
          <select id="segmentoReporteDolores" class="select-mini" title="Segmento a analizar en el resumen de dolores/obstáculos">
            <option value="todos">Todos</option>
            <option value="califica">✅ Califican</option>
            <option value="nocalifica">🚫 No califican</option>
            <option value="agendo">📅 Agendaron (confirmado)</option>
            <option value="enlace">🔗 Enlace enviado</option>
          </select>
          <button type="button" class="btn-mini" id="btnReporteDolores" title="Analiza tus conversaciones y descarga un CSV con las frecuencias de dolores y obstáculos que mencionaron tus leads.">📊 Resumen</button>
          <div class="chat-export" id="chatExportWrap" style="display:none;">
            <a id="btnExportar" href="#" class="btn-mini">⬇ CSV</a>
          </div>
        </div>
        <div class="chat-list" id="listaChats"><p class="vacio-lista">Cargando…</p></div>
      </div>

      <div class="chat-window">
        <div class="chat-window-head" id="chatHead">
          <span style="color:var(--muted); font-size:14px;">Selecciona una conversación</span>
        </div>
        <div class="handoff-banner" id="handoffBanner">
          ⏰ Esta conversación salió de la ventana de 24 horas de Instagram — el bot ya no puede mandar mensajes normales aquí, se requiere atención manual (o una plantilla aprobada).
        </div>
        <div class="pausado-banner" id="pausadoBanner">
          ⏸️ El bot está PAUSADO para esta conversación — no va a responder automáticamente hasta que le des a "▶️ Reanudar bot".
        </div>
        <div class="chat-status-bar" id="chatStatusBar" style="display:none;">
          <span class="status-chip status-chip-califica" id="chipCalifica" style="display:none;">✅ Califica</span>
          <span class="status-chip status-chip-nocalifica" id="chipNoCalifica" style="display:none;">🚫 No Califica</span>
          <span class="status-chip status-chip-agendo" id="chipAgendo" style="display:none;">📅 Agendó</span>
          <span class="status-chip status-chip-enlace" id="chipEnlace" style="display:none;">🔗 Enlace</span>
          <span class="status-chip status-chip-monto" id="chipMonto" style="display:none; background:rgba(255,197,66,.14); color:#FFC542;"></span>
          <span class="status-sep">·</span>
          <select id="selectEtapa" class="status-select"><option value="">Sin etapa (general)</option></select>
          <span class="status-sep">·</span>
          <div class="etiquetas-lista" id="etiquetasLista"></div>
          <div class="add-etiqueta-wrap">
            <button type="button" class="btn-add-etiqueta" id="btnAddEtiqueta">+ 🏷️</button>
            <div class="etiqueta-popover" id="etiquetaPopover" style="display:none;">
              <input type="text" id="inputNuevaEtiqueta" placeholder="Escribe o elige una etiqueta..." list="listaEtiquetasExistentes" autocomplete="off">
              <datalist id="listaEtiquetasExistentes"></datalist>
              <button type="button" id="btnConfirmarEtiqueta">Agregar</button>
            </div>
          </div>
          <div class="add-etiqueta-wrap">
            <button type="button" class="btn-add-etiqueta" id="btnAddMonto">+ 💰</button>
            <div class="etiqueta-popover" id="montoPopover" style="display:none;">
              <input type="number" id="inputMontoPagado" placeholder="Ej: 100" min="0" step="0.01" style="width:120px;">
              <button type="button" id="btnConfirmarMonto">Guardar</button>
            </div>
          </div>
          <span class="status-sep">·</span>
          <button type="button" class="btn-pausar-bot" id="btnPausarBot" title="Pausar el bot para esta conversación — tú respondes manualmente">⏸️ Pausar bot</button>
        </div>
        <details class="resumen-lead" id="resumenLeadDetails" style="display:none;">
          <summary>📋 Resumen del lead <span id="resumenLeadRefrescar" title="Volver a generar" style="display:none;">🔄</span></summary>
          <div class="resumen-lead-contenido" id="resumenLeadContenido">
            <p class="hint" style="margin:0;">Ábrelo para generarlo (analiza la conversación con IA, tarda unos segundos).</p>
          </div>
        </details>
        <div class="chat-messages" id="chatMensajes">
          <div class="chat-empty">Elige una conversación de la izquierda para ver los mensajes.</div>
        </div>
        <div class="chat-input-error" id="chatInputError"></div>
        <div class="chat-input-bar" id="chatInputBar">
          <button class="btn-adjuntar" id="btnAdjuntarFoto" title="Enviar una foto">📷</button>
          <input type="file" id="inputFotoManual" accept="image/*" style="display:none;">
          <button class="btn-adjuntar" id="btnGrabarAudio" title="Grabar y enviar un audio">🎤</button>
          <textarea id="mensajeManual" rows="1" placeholder="Escribe una respuesta manual…"></textarea>
          <button class="btn-enviar" id="btnEnviarManual">Enviar</button>
        </div>
      </div>
    </div>
  </div>
  </div>
  </div>

  <div class="menu-contextual" id="menuContextual">
    <button type="button" class="menu-contextual-item" id="btnBorrarChat">🗑 Borrar conversación (empezar de cero)</button>
  </div>

<script>
  async function llamarGET(endpoint){
    const res = await fetch(endpoint);
    if(res.status === 401){ window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname); return null; }
    return res.json();
  }

  let conversaciones = [];
  let senderSeleccionado = null;
  let mensajesMostrados = []; // {role, content, creado_en} — página actual mostrada, orden ascendente
  let hayMasAntiguos = false;
  let cargandoAntiguos = false;
  let filtroActual = "todas";
  let etapasDisponibles = [];
  let etiquetaCompraConfigurada = "";

  function formatearFecha(iso){
    if(!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString("es-MX", { day:"2-digit", month:"short" }) + ", " +
      d.toLocaleTimeString("es-MX", { hour:"2-digit", minute:"2-digit" });
  }

  function escapar(txt){
    return (txt || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  function inicialDe(c){
    const base = c.username || c.sender_id || "?";
    return base.charAt(0).toUpperCase();
  }

  function avatarHTML(c, claseExtra){
    const inicial = inicialDe(c);
    if (c.profile_pic) {
      return \`<img class="chat-avatar\${claseExtra ? " " + claseExtra : ""}" src="\${c.profile_pic}" alt=""
        onerror="this.outerHTML='<div class=\\'chat-avatar avatar-fallback\${claseExtra ? " " + claseExtra : ""}\\'>\${inicial}</div>'">\`;
    }
    return \`<div class="chat-avatar avatar-fallback\${claseExtra ? " " + claseExtra : ""}">\${inicial}</div>\`;
  }

  function nombreMostrar(c){
    return c.username ? "@" + c.username : c.sender_id;
  }

  async function cargarEtapasDisponibles(){
    const cfg = await llamarGET("/config");
    if(cfg && Array.isArray(cfg.etapas)) etapasDisponibles = cfg.etapas;
    if(cfg) etiquetaCompraConfigurada = cfg.dashboard_etiqueta_compro || "";
  }

  // Compara etiquetas igual que el resto del sistema: sin mayúsculas ni
  // acentos, para que "Compró", "compro" y "COMPRÓ" cuenten como la misma.
  function normalizarEtiqueta(t){
    return (t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  }

  function tieneEtiqueta(conv, nombreEtiqueta){
    if(!nombreEtiqueta) return false;
    const objetivo = normalizarEtiqueta(nombreEtiqueta);
    return Array.isArray(conv.etiquetas) && conv.etiquetas.some(e => normalizarEtiqueta(e) === objetivo);
  }

  function actualizarContadores(){
    const totalHandoff = conversaciones.filter(c => !c.en_ventana_24h).length;
    const totalCalifica = conversaciones.filter(c => c.califica).length;
    const totalNoCalifica = conversaciones.filter(c => c.no_califica).length;
    const totalAgendo = conversaciones.filter(c => c.agendo).length;
    const totalEnlace = conversaciones.filter(c => c.enlace_enviado).length;
    const totalSeguimiento = conversaciones.filter(c => !c.en_ventana_24h && !c.no_califica && !c.agendo && !tieneEtiqueta(c, etiquetaCompraConfigurada)).length;
    document.getElementById("countTodas").textContent = conversaciones.length;
    document.getElementById("countHandoff").textContent = totalHandoff;
    document.getElementById("countCalifica").textContent = totalCalifica;
    document.getElementById("countNoCalifica").textContent = totalNoCalifica;
    document.getElementById("countAgendo").textContent = totalAgendo;
    document.getElementById("countEnlace").textContent = totalEnlace;
    document.getElementById("countSeguimiento").textContent = totalSeguimiento;
    actualizarBotonExportar({
      todas: conversaciones.length, handoff: totalHandoff, califica: totalCalifica,
      nocalifica: totalNoCalifica, agendo: totalAgendo, enlace: totalEnlace, seguimiento: totalSeguimiento
    });
  }

  // El botón de exportar aparece SIEMPRE, sin importar qué pestaña tengas
  // abierta — un solo endpoint flexible en el servidor sirve cualquiera de
  // las 7 categorías, tú decides si lo descargas o no.
  function actualizarBotonExportar(totales){
    const wrap = document.getElementById("chatExportWrap");
    const btn = document.getElementById("btnExportar");

    const estilos = {
      todas: "", handoff: "",
      califica: "border-color:rgba(49,217,124,.3); color:var(--green);",
      nocalifica: "border-color:rgba(255,93,93,.35); color:var(--red);",
      agendo: "border-color:rgba(49,217,124,.3); color:var(--green);",
      enlace: "border-color:rgba(63,199,232,.35); color:#3FC7E8;",
      seguimiento: "border-color:rgba(255,197,66,.4); color:#FFC542;"
    };
    const titulos = {
      todas: "Exportar todos los leads", handoff: "Exportar handoff", califica: "Exportar calificados",
      nocalifica: "Exportar no califican", agendo: "Exportar agendaron", enlace: "Exportar enlace enviado",
      seguimiento: "Exportar seguimiento pendiente"
    };

    const total = totales[filtroActual] ?? 0;
    wrap.style.display = "inline-block";
    btn.setAttribute("href", "/exportar/leads.csv?filtro=" + encodeURIComponent(filtroActual));
    btn.setAttribute("style", estilos[filtroActual] || "");
    btn.setAttribute("title", titulos[filtroActual] || "Exportar");
    btn.textContent = "⬇ CSV (" + total + ")";
  }

  function conversacionesFiltradas(){
    if(filtroActual === "handoff") return conversaciones.filter(c => !c.en_ventana_24h);
    if(filtroActual === "califica") return conversaciones.filter(c => c.califica);
    if(filtroActual === "nocalifica") return conversaciones.filter(c => c.no_califica);
    if(filtroActual === "agendo") return conversaciones.filter(c => c.agendo);
    if(filtroActual === "enlace") return conversaciones.filter(c => c.enlace_enviado);
    // "Seguimiento pendiente": todos los que salieron de la ventana de 24h
    // (handoff), EXCLUYENDO a los que ya no califican (no vale la pena
    // insistirles), a los que ya agendaron (ya lograron lo que se buscaba),
    // y a los que ya tienen la etiqueta de "Compró" (por si alguien cerró
    // fuera del flujo normal del bot, sin haber confirmado "agendé").
    if(filtroActual === "seguimiento") return conversaciones.filter(c => !c.en_ventana_24h && !c.no_califica && !c.agendo && !tieneEtiqueta(c, etiquetaCompraConfigurada));
    return conversaciones;
  }

  function renderLista(){
    const cont = document.getElementById("listaChats");
    actualizarContadores();
    const lista = conversacionesFiltradas();

    if(lista.length === 0){
      let vacioTxt = '<p class="vacio-lista">Todavía no hay conversaciones.</p>';
      if(filtroActual === "handoff") vacioTxt = '<p class="vacio-lista">🎉 Ninguna conversación en handoff — todas están dentro de la ventana de 24h.</p>';
      if(filtroActual === "califica") vacioTxt = '<p class="vacio-lista">Todavía no hay leads calificados con los criterios actuales.</p>';
      if(filtroActual === "enlace") vacioTxt = '<p class="vacio-lista">Todavía no se le ha mandado el enlace de calificación a nadie.</p>';
      cont.innerHTML = vacioTxt;
      return;
    }

    cont.innerHTML = lista.map(c => \`
      <div class="chat-list-item\${senderSeleccionado === c.sender_id ? " active" : ""}" data-id="\${c.sender_id}">
        \${avatarHTML(c)}
        <div class="chat-list-item-text">
          <div class="uname-row">
            <span class="uname">\${escapar(nombreMostrar(c))}</span>
            \${c.bot_pausado ? '<span class="califica-badge" title="Bot pausado — respondes tú manualmente">⏸️</span>' : ''}
            \${c.califica ? '<span class="califica-badge" title="Califica">✅</span>' : ''}
            \${c.no_califica ? '<span class="califica-badge" title="No Califica' + (c.razon_no_califica ? ": " + escapar(c.razon_no_califica) : "") + '">🚫</span>' : ''}
            \${c.agendo ? '<span class="califica-badge" title="Agendó">📅</span>' : ''}
            \${c.enlace_enviado ? '<span class="enlace-badge" title="Enlace enviado">🔗</span>' : ''}
            \${(c.etiquetas && c.etiquetas.length > 0) ? '<span class="etiqueta-chip-mini" title="' + escapar(c.etiquetas.join(", ")) + '">🏷️ ' + escapar(c.etiquetas[0]) + (c.etiquetas.length > 1 ? ' +' + (c.etiquetas.length - 1) : '') + '</span>' : ''}
            \${c.etapa_nombre ? '<span class="etapa-chip" title="Etapa actual">' + escapar(c.etapa_nombre) + '</span>' : ''}
            \${!c.en_ventana_24h ? '<span class="handoff-dot" title="Fuera de la ventana de 24h"></span>' : ''}
          </div>
          <div class="preview">\${c.ultimo_role === "assistant" ? "🤖 " : ""}\${escapar(c.ultimo_texto) || "(sin mensajes)"}</div>
          <div class="time">\${formatearFecha(c.actualizado_en)}</div>
        </div>
      </div>
    \`).join("");

    cont.querySelectorAll(".chat-list-item").forEach(el => {
      el.addEventListener("click", () => seleccionarChat(el.dataset.id));
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        mostrarMenuContextual(e.clientX, e.clientY, el.dataset.id);
      });
    });
  }

  let senderMenuContextual = null;

  function mostrarMenuContextual(x, y, senderId){
    senderMenuContextual = senderId;
    const menu = document.getElementById("menuContextual");
    const anchoEstimado = 240, altoEstimado = 50;
    const left = Math.min(x, window.innerWidth - anchoEstimado - 10);
    const top = Math.min(y, window.innerHeight - altoEstimado - 10);
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.classList.add("visible");
  }

  function ocultarMenuContextual(){
    document.getElementById("menuContextual").classList.remove("visible");
    senderMenuContextual = null;
  }

  document.addEventListener("click", ocultarMenuContextual);
  document.addEventListener("contextmenu", (e) => {
    if(!e.target.closest(".chat-list-item")) ocultarMenuContextual();
  });

  document.getElementById("btnBorrarChat").addEventListener("click", async (e) => {
    e.stopPropagation();
    const senderId = senderMenuContextual;
    ocultarMenuContextual();
    if(!senderId) return;
    if(!confirm("¿Borrar por completo esta conversación? Se pierde todo el historial y no se puede deshacer.\\n\\nLa próxima vez que esta persona escriba, el bot empezará desde cero (como si nunca hubiera hablado con ella).")) return;

    try {
      const res = await fetch("/chats/borrar", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ senderId })
      });
      if(res.status === 401){ window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname); return; }
      const data = await res.json();
      if(data && !data.error){
        if(senderSeleccionado === senderId){
          senderSeleccionado = null;
          mensajesMostrados = [];
          renderHead();
          actualizarInputBar();
          document.getElementById("chatMensajes").innerHTML = '<div class="chat-empty">Elige una conversación de la izquierda para ver los mensajes.</div>';
        }
        await cargarConversaciones();
      } else {
        alert("No se pudo borrar: " + (data?.error || "error desconocido"));
      }
    } catch (err) {
      alert("Error de conexión al borrar la conversación.");
    }
  });

  function opcionesEtapaHTML(claveActual){
    let html = '<option value="">Sin etapa (general)</option>';
    html += etapasDisponibles.map(e => \`<option value="\${e.clave}"\${e.clave === claveActual ? " selected" : ""}>\${escapar(e.nombre || e.clave)}</option>\`).join("");
    return html;
  }

  let senderMostradoEnResumen = null;
  const resumenesCache = {}; // { senderId: { ...datos } } — para no volver a gastar en IA si ya se generó

  function renderHead(){
    const head = document.getElementById("chatHead");
    const banner = document.getElementById("handoffBanner");
    const bannerPausado = document.getElementById("pausadoBanner");
    const statusBar = document.getElementById("chatStatusBar");
    const chipCalifica = document.getElementById("chipCalifica");
    const chipNoCalifica = document.getElementById("chipNoCalifica");
    const chipAgendo = document.getElementById("chipAgendo");
    const chipEnlace = document.getElementById("chipEnlace");
    const chipMonto = document.getElementById("chipMonto");
    const btnPausarBot = document.getElementById("btnPausarBot");
    const resumenDetails = document.getElementById("resumenLeadDetails");
    if(!senderSeleccionado){
      head.innerHTML = '<span style="color:var(--muted); font-size:14px;">Selecciona una conversación</span>';
      banner.classList.remove("visible");
      bannerPausado.classList.remove("visible");
      statusBar.style.display = "none";
      resumenDetails.style.display = "none";
      return;
    }
    resumenDetails.style.display = "block";
    // Si se cambió de conversación (no solo un refresco de la misma), se
    // cierra el desplegable y se limpia — cada lead tiene su propio resumen,
    // no queremos que se quede pegado el de otra persona.
    if(senderSeleccionado !== senderMostradoEnResumen){
      senderMostradoEnResumen = senderSeleccionado;
      resumenDetails.removeAttribute("open");
      document.getElementById("resumenLeadRefrescar").style.display = "none";
      if(resumenesCache[senderSeleccionado]){
        renderResumenLead(resumenesCache[senderSeleccionado]);
        document.getElementById("resumenLeadRefrescar").style.display = "inline";
      } else {
        document.getElementById("resumenLeadContenido").innerHTML = '<p class="hint" style="margin:0;">Ábrelo para generarlo (analiza la conversación con IA, tarda unos segundos).</p>';
      }
    }
    const conv = conversaciones.find(c => c.sender_id === senderSeleccionado) || { sender_id: senderSeleccionado, en_ventana_24h: true };
    head.innerHTML = \`
      \${avatarHTML(conv)}
      <div class="chat-window-head-text">
        <div class="chat-window-head-uname">\${escapar(nombreMostrar(conv))}\${conv.califica ? ' <span title="Califica">✅</span>' : ''}\${conv.no_califica ? ' <span title="No Califica">🚫</span>' : ''}\${conv.agendo ? ' <span title="Agendó">📅</span>' : ''}\${conv.enlace_enviado ? ' <span title="Enlace enviado">🔗</span>' : ''}\${conv.bot_pausado ? ' <span title="Bot pausado">⏸️</span>' : ''}</div>
        <div class="chat-window-head-id">\${conv.sender_id}</div>
      </div>
    \`;
    banner.classList.toggle("visible", conv.en_ventana_24h === false);
    bannerPausado.classList.toggle("visible", Boolean(conv.bot_pausado));
    statusBar.style.display = "flex";

    if(conv.bot_pausado){
      btnPausarBot.textContent = "▶️ Reanudar bot";
      btnPausarBot.classList.add("activo");
      btnPausarBot.title = "Reanudar el bot para esta conversación";
    } else {
      btnPausarBot.textContent = "⏸️ Pausar bot";
      btnPausarBot.classList.remove("activo");
      btnPausarBot.title = "Pausar el bot para esta conversación — tú respondes manualmente";
    }

    // Cada chip es pequeño y solo muestra el detalle (razón/fecha) al pasar
    // el mouse por encima (title) — así la barra queda compacta aunque
    // varios estados estén activos a la vez, en vez de apilar un banner
    // completo por cada uno.
    if(conv.califica){
      chipCalifica.title = "Califica" + (conv.razon_calificacion ? ": " + conv.razon_calificacion : "");
      chipCalifica.style.display = "inline-flex";
    } else {
      chipCalifica.style.display = "none";
    }

    if(conv.no_califica){
      chipNoCalifica.title = "No Califica" + (conv.razon_no_califica ? ": " + conv.razon_no_califica : "");
      chipNoCalifica.style.display = "inline-flex";
    } else {
      chipNoCalifica.style.display = "none";
    }

    if(conv.agendo){
      chipAgendo.title = "Confirmó que ya agendó" + (conv.agendo_en ? " (" + formatearFecha(conv.agendo_en) + ")" : "");
      chipAgendo.style.display = "inline-flex";
    } else {
      chipAgendo.style.display = "none";
    }

    if(conv.enlace_enviado){
      const estadoSeguimiento = conv.enlace_seguimiento_activo
        ? "seguimiento especial en curso (paso " + ((conv.enlace_pasos_enviados || 0) + 1) + ")"
        : "seguimiento especial terminado, ahora sigue el normal";
      chipEnlace.title = "Enlace de calificación enviado" + (conv.enlace_enviado_en ? " (" + formatearFecha(conv.enlace_enviado_en) + ")" : "") + " — " + estadoSeguimiento;
      chipEnlace.style.display = "inline-flex";
    } else {
      chipEnlace.style.display = "none";
    }

    if(conv.monto_pagado > 0){
      chipMonto.textContent = "💰 $" + Number(conv.monto_pagado).toLocaleString("es-MX");
      chipMonto.title = "Monto pagado registrado — clic en + 💰 para editarlo";
      chipMonto.style.display = "inline-flex";
    } else {
      chipMonto.style.display = "none";
    }

    // Selector de etapa: siempre visible mientras haya una conversación
    // seleccionada, sirve tanto para ver la etapa actual como para cambiarla
    // a mano (útil si la IA no puso el marcador [[etapa:..]] correctamente).
    const selectEtapa = document.getElementById("selectEtapa");
    selectEtapa.innerHTML = opcionesEtapaHTML(conv.etapa || "");

    // Etiquetas manuales
    const listaEtiquetas = document.getElementById("etiquetasLista");
    const etiquetas = Array.isArray(conv.etiquetas) ? conv.etiquetas : [];
    listaEtiquetas.innerHTML = etiquetas.map(et => \`
      <span class="etiqueta-chip">\${escapar(et)}<button type="button" class="btn-quitar-etiqueta" data-etiqueta="\${escapar(et)}" title="Quitar etiqueta">×</button></span>
    \`).join("");
    listaEtiquetas.querySelectorAll(".btn-quitar-etiqueta").forEach(btn => {
      btn.addEventListener("click", async () => {
        const etiqueta = btn.dataset.etiqueta;
        const res = await fetch("/chats/etiqueta/quitar", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ senderId: senderSeleccionado, etiqueta })
        });
        if(res.status === 401){ window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname); return; }
        const data = await res.json();
        if(data.ok){
          const c = conversaciones.find(c => c.sender_id === senderSeleccionado);
          if(c) c.etiquetas = data.etiquetas;
          renderHead();
        }
      });
    });
  }

  // --- Popover para agregar una etiqueta manual ---
  const popoverEtiqueta = document.getElementById("etiquetaPopover");
  const inputNuevaEtiqueta = document.getElementById("inputNuevaEtiqueta");

  document.getElementById("btnAddEtiqueta").addEventListener("click", async () => {
    const abriendo = popoverEtiqueta.style.display === "none";
    popoverEtiqueta.style.display = abriendo ? "flex" : "none";
    if(abriendo){
      inputNuevaEtiqueta.value = "";
      inputNuevaEtiqueta.focus();
      const data = await llamarGET("/etiquetas");
      const datalist = document.getElementById("listaEtiquetasExistentes");
      datalist.innerHTML = (data?.etiquetas || []).map(et => \`<option value="\${escapar(et)}">\`).join("");
    }
  });

  async function confirmarNuevaEtiqueta(){
    const etiqueta = inputNuevaEtiqueta.value.trim();
    if(!etiqueta || !senderSeleccionado) return;
    const res = await fetch("/chats/etiqueta/agregar", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId: senderSeleccionado, etiqueta })
    });
    if(res.status === 401){ window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname); return; }
    const data = await res.json();
    if(data.ok){
      const c = conversaciones.find(c => c.sender_id === senderSeleccionado);
      if(c) c.etiquetas = data.etiquetas;
      popoverEtiqueta.style.display = "none";
      renderHead();
      cargarEtiquetasEnSelectorReporte();
    }
  }

  document.getElementById("btnConfirmarEtiqueta").addEventListener("click", confirmarNuevaEtiqueta);
  inputNuevaEtiqueta.addEventListener("keydown", (e) => {
    if(e.key === "Enter"){ e.preventDefault(); confirmarNuevaEtiqueta(); }
  });
  document.addEventListener("click", (e) => {
    if(popoverEtiqueta.style.display !== "none" && !popoverEtiqueta.contains(e.target) && e.target.id !== "btnAddEtiqueta"){
      popoverEtiqueta.style.display = "none";
    }
  });

  // --- Popover para registrar cuánto pagó el lead (cash collected) ---
  const popoverMonto = document.getElementById("montoPopover");
  const inputMontoPagado = document.getElementById("inputMontoPagado");

  document.getElementById("btnAddMonto").addEventListener("click", () => {
    const abriendo = popoverMonto.style.display === "none";
    popoverMonto.style.display = abriendo ? "flex" : "none";
    if(abriendo){
      const c = conversaciones.find(c => c.sender_id === senderSeleccionado);
      inputMontoPagado.value = (c?.monto_pagado > 0) ? c.monto_pagado : "";
      inputMontoPagado.focus();
    }
  });

  async function confirmarMontoPagado(){
    if(!senderSeleccionado) return;
    const monto = inputMontoPagado.value.trim();
    if(monto === "" || isNaN(Number(monto)) || Number(monto) < 0) return;
    const res = await fetch("/chats/monto-pagado", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId: senderSeleccionado, monto: Number(monto) })
    });
    if(res.status === 401){ window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname); return; }
    const data = await res.json();
    if(data.ok){
      const c = conversaciones.find(c => c.sender_id === senderSeleccionado);
      if(c) c.monto_pagado = data.monto_pagado;
      popoverMonto.style.display = "none";
      renderHead();
    }
  }

  document.getElementById("btnConfirmarMonto").addEventListener("click", confirmarMontoPagado);
  inputMontoPagado.addEventListener("keydown", (e) => {
    if(e.key === "Enter"){ e.preventDefault(); confirmarMontoPagado(); }
  });
  document.addEventListener("click", (e) => {
    if(popoverMonto.style.display !== "none" && !popoverMonto.contains(e.target) && e.target.id !== "btnAddMonto"){
      popoverMonto.style.display = "none";
    }
  });

  document.getElementById("btnPausarBot").addEventListener("click", async () => {
    if(!senderSeleccionado) return;
    const c = conversaciones.find(c => c.sender_id === senderSeleccionado);
    const nuevoEstado = !(c?.bot_pausado);
    const btn = document.getElementById("btnPausarBot");
    btn.disabled = true;
    try {
      const res = await fetch("/chats/pausar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderId: senderSeleccionado, pausado: nuevoEstado })
      });
      if(res.status === 401){ window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname); return; }
      const data = await res.json();
      if(data.ok){
        if(c) c.bot_pausado = data.bot_pausado;
        renderHead();
      }
    } catch (err) {
      alert("No se pudo cambiar el estado del bot: " + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // --- Resumen del lead (edad, peso a perder, obstáculo, dolores) ---
  function renderResumenLead(datos){
    const cont = document.getElementById("resumenLeadContenido");
    if(datos.vacio){
      cont.innerHTML = '<p class="hint" style="margin:0;">Todavía no hay suficiente conversación con este lead para generar un resumen.</p>';
      return;
    }
    const item = (label, valor) => \`
      <div class="resumen-lead-item">
        <div class="resumen-lead-item-label">\${label}</div>
        <div class="resumen-lead-item-valor">\${valor ? escapar(valor) : '<span style="color:var(--muted-dim); font-weight:400;">No especifica</span>'}</div>
      </div>
    \`;
    cont.innerHTML = \`
      <div class="resumen-lead-grid">
        \${item("🎂 Edad", datos.edad)}
        \${item("⚖️ Peso actual", datos.peso_actual)}
        \${item("🎯 Peso objetivo", datos.peso_objetivo)}
        \${item("📉 Peso a perder", datos.peso_a_perder)}
        \${item("🚧 Obstáculo", datos.obstaculo)}
        \${item("💪 Dolor de salud", datos.dolor_salud)}
        \${item("✨ Motivo estético", datos.dolor_estetico)}
      </div>
      \${datos.detalle ? '<div class="resumen-lead-detalle">"' + escapar(datos.detalle) + '"</div>' : ''}
      \${datos.generado_en ? '<div class="resumen-lead-fecha">Generado el ' + formatearFecha(datos.generado_en) + '</div>' : ''}
    \`;
  }

  async function generarResumenLead(senderId, forzar){
    const cont = document.getElementById("resumenLeadContenido");
    // Si ya está en la caché de esta sesión del navegador y no se pidió
    // forzar, se usa directo sin llamar al servidor — pero aunque no esté
    // en esta caché (ej. recién cambiaste de pestaña), el servidor YA tiene
    // el resumen guardado de antes y lo devuelve sin volver a gastar en IA;
    // solo se regenera si "forzar" es true (el botón 🔄).
    if(!forzar && resumenesCache[senderId]){
      renderResumenLead(resumenesCache[senderId]);
      return;
    }
    cont.innerHTML = '<p class="hint" style="margin:0;">⏳ ' + (forzar ? "Analizando de nuevo…" : "Buscando el resumen…") + '</p>';
    try {
      const url = "/chats/resumen/" + encodeURIComponent(senderId) + (forzar ? "?forzar=true" : "");
      const res = await fetch(url);
      if(res.status === 401){ window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname); return; }
      const data = await res.json();
      if(!res.ok || data.error){
        cont.innerHTML = '<p class="hint" style="margin:0; color:var(--red);">❌ ' + escapar(data.error || "No se pudo generar el resumen.") + '</p>';
        return;
      }
      resumenesCache[senderId] = data;
      renderResumenLead(data);
      document.getElementById("resumenLeadRefrescar").style.display = "inline";
    } catch (err) {
      cont.innerHTML = '<p class="hint" style="margin:0; color:var(--red);">❌ Error de conexión: ' + escapar(err.message) + '</p>';
    }
  }

  document.getElementById("resumenLeadDetails").addEventListener("toggle", (e) => {
    if(e.target.open && senderSeleccionado && !resumenesCache[senderSeleccionado]){
      generarResumenLead(senderSeleccionado, false);
    }
  });

  document.getElementById("resumenLeadRefrescar").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if(senderSeleccionado) generarResumenLead(senderSeleccionado, true);
  });

  document.getElementById("selectEtapa").addEventListener("change", async (e) => {
    if(!senderSeleccionado) return;
    const nuevaEtapa = e.target.value;
    const res = await fetch("/chats/etapa", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId: senderSeleccionado, etapa: nuevaEtapa })
    });
    if(res.status === 401){ window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname); return; }
    const data = await res.json();
    if(data && !data.error){
      await cargarConversaciones();
    } else {
      alert("No se pudo cambiar la etapa: " + (data?.error || "error desconocido"));
    }
  });

  function actualizarInputBar(){
    const bar = document.getElementById("chatInputBar");
    bar.style.display = senderSeleccionado ? "flex" : "none";
    const errorBox = document.getElementById("chatInputError");
    errorBox.classList.remove("visible");
    errorBox.textContent = "";
  }

  async function enviarManual(){
    if(!senderSeleccionado) return;
    const ta = document.getElementById("mensajeManual");
    const texto = ta.value.trim();
    if(!texto) return;

    const btn = document.getElementById("btnEnviarManual");
    const errorBox = document.getElementById("chatInputError");
    errorBox.classList.remove("visible");
    errorBox.textContent = "";
    btn.disabled = true;
    btn.textContent = "Enviando…";

    try {
      const res = await fetch("/chats/enviar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderId: senderSeleccionado, mensaje: texto })
      });
      if(res.status === 401){
        window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname);
        return;
      }
      const data = await res.json();
      if(!res.ok){
        errorBox.textContent = "❌ " + (data.error || "No se pudo enviar el mensaje.");
        errorBox.classList.add("visible");
      } else {
        ta.value = "";
        ta.style.height = "auto";
        await revisarMensajesNuevos();
        await cargarConversaciones();
      }
    } catch (err) {
      errorBox.textContent = "❌ Error de conexión al enviar el mensaje.";
      errorBox.classList.add("visible");
    } finally {
      btn.disabled = false;
      btn.textContent = "Enviar";
    }
  }

  document.getElementById("btnEnviarManual").addEventListener("click", enviarManual);
  document.getElementById("mensajeManual").addEventListener("keydown", (e) => {
    if(e.key === "Enter" && !e.shiftKey){
      e.preventDefault();
      enviarManual();
    }
  });
  document.getElementById("mensajeManual").addEventListener("input", function(){
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 120) + "px";
  });

  function leerArchivoComoBase64Chat(archivo){
    return new Promise((resolve, reject) => {
      const lector = new FileReader();
      lector.onload = () => {
        const resultado = lector.result;
        resolve(resultado.substring(resultado.indexOf(",") + 1));
      };
      lector.onerror = () => reject(new Error("No se pudo leer el archivo."));
      lector.readAsDataURL(archivo);
    });
  }

  document.getElementById("btnAdjuntarFoto").addEventListener("click", () => {
    if(!senderSeleccionado) return;
    document.getElementById("inputFotoManual").click();
  });

  document.getElementById("inputFotoManual").addEventListener("change", async (e) => {
    const archivo = e.target.files?.[0];
    e.target.value = "";
    if(!archivo || !senderSeleccionado) return;

    const errorBox = document.getElementById("chatInputError");
    const btnFoto = document.getElementById("btnAdjuntarFoto");
    errorBox.classList.remove("visible");
    errorBox.textContent = "";
    btnFoto.disabled = true;
    btnFoto.textContent = "⏳";

    try {
      const base64 = await leerArchivoComoBase64Chat(archivo);
      const res = await fetch("/chats/enviar-foto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderId: senderSeleccionado, base64, tipo: archivo.type })
      });
      if(res.status === 401){
        window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname);
        return;
      }
      const data = await res.json();
      if(!res.ok){
        errorBox.textContent = "❌ " + (data.error || "No se pudo enviar la foto.");
        errorBox.classList.add("visible");
      } else {
        await revisarMensajesNuevos();
        await cargarConversaciones();
      }
    } catch (err) {
      errorBox.textContent = "❌ Error de conexión al enviar la foto.";
      errorBox.classList.add("visible");
    } finally {
      btnFoto.disabled = false;
      btnFoto.textContent = "📷";
    }
  });

  let mediaRecorder = null;
  let audioChunksGrabacion = [];
  let streamGrabacionActual = null;
  let grabandoAudio = false;
  let grabacionTimerInterval = null;
  let grabacionSegundos = 0;
  const btnGrabarAudio = document.getElementById("btnGrabarAudio");

  async function iniciarGrabacionAudio(){
    const errorBox = document.getElementById("chatInputError");
    errorBox.classList.remove("visible");
    errorBox.textContent = "";

    try {
      streamGrabacionActual = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      errorBox.textContent = "❌ No se pudo acceder al micrófono: " + err.message;
      errorBox.classList.add("visible");
      return;
    }

    audioChunksGrabacion = [];
    mediaRecorder = new MediaRecorder(streamGrabacionActual);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksGrabacion.push(e.data); };
    mediaRecorder.start();

    grabandoAudio = true;
    grabacionSegundos = 0;
    btnGrabarAudio.classList.add("grabando");
    btnGrabarAudio.textContent = "⏹ 0:00";
    grabacionTimerInterval = setInterval(() => {
      grabacionSegundos++;
      const m = Math.floor(grabacionSegundos / 60);
      const s = String(grabacionSegundos % 60).padStart(2, "0");
      btnGrabarAudio.textContent = "⏹ " + m + ":" + s;
    }, 1000);
  }

  async function detenerYEnviarGrabacion(){
    clearInterval(grabacionTimerInterval);
    grabandoAudio = false;
    btnGrabarAudio.classList.remove("grabando");
    btnGrabarAudio.disabled = true;
    btnGrabarAudio.textContent = "⏳";

    const blob = await new Promise((resolve) => {
      mediaRecorder.onstop = () => {
        resolve(new Blob(audioChunksGrabacion, { type: mediaRecorder.mimeType || "audio/webm" }));
      };
      mediaRecorder.stop();
    });

    if (streamGrabacionActual) streamGrabacionActual.getTracks().forEach(t => t.stop());

    const errorBox = document.getElementById("chatInputError");

    if (blob.size === 0) {
      btnGrabarAudio.disabled = false;
      btnGrabarAudio.textContent = "🎤";
      return;
    }

    try {
      const base64 = await new Promise((resolve, reject) => {
        const lector = new FileReader();
        lector.onload = () => resolve(lector.result.substring(lector.result.indexOf(",") + 1));
        lector.onerror = () => reject(new Error("No se pudo procesar el audio grabado."));
        lector.readAsDataURL(blob);
      });

      const res = await fetch("/chats/enviar-audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderId: senderSeleccionado, base64, tipo: blob.type })
      });
      if(res.status === 401){
        window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname);
        return;
      }
      const data = await res.json();
      if(!res.ok){
        errorBox.textContent = "❌ " + (data.error || "No se pudo enviar el audio.");
        errorBox.classList.add("visible");
      } else {
        await revisarMensajesNuevos();
        await cargarConversaciones();
      }
    } catch (err) {
      errorBox.textContent = "❌ Error enviando el audio: " + err.message;
      errorBox.classList.add("visible");
    } finally {
      btnGrabarAudio.disabled = false;
      btnGrabarAudio.textContent = "🎤";
    }
  }

  btnGrabarAudio.addEventListener("click", () => {
    if(!senderSeleccionado) return;
    if(!grabandoAudio) iniciarGrabacionAudio();
    else detenerYEnviarGrabacion();
  });

  document.getElementById("tabTodas").addEventListener("click", () => {
    filtroActual = "todas";
    document.querySelectorAll(".chat-tab").forEach(t => t.classList.remove("active"));
    document.getElementById("tabTodas").classList.add("active");
    renderLista();
  });
  document.getElementById("tabHandoff").addEventListener("click", () => {
    filtroActual = "handoff";
    document.querySelectorAll(".chat-tab").forEach(t => t.classList.remove("active"));
    document.getElementById("tabHandoff").classList.add("active");
    renderLista();
  });
  document.getElementById("tabSeguimiento").addEventListener("click", () => {
    filtroActual = "seguimiento";
    document.querySelectorAll(".chat-tab").forEach(t => t.classList.remove("active"));
    document.getElementById("tabSeguimiento").classList.add("active");
    renderLista();
  });
  document.getElementById("tabCalifica").addEventListener("click", () => {
    filtroActual = "califica";
    document.querySelectorAll(".chat-tab").forEach(t => t.classList.remove("active"));
    document.getElementById("tabCalifica").classList.add("active");
    renderLista();
  });
  document.getElementById("tabNoCalifica").addEventListener("click", () => {
    filtroActual = "nocalifica";
    document.querySelectorAll(".chat-tab").forEach(t => t.classList.remove("active"));
    document.getElementById("tabNoCalifica").classList.add("active");
    renderLista();
  });
  document.getElementById("tabAgendo").addEventListener("click", () => {
    filtroActual = "agendo";
    document.querySelectorAll(".chat-tab").forEach(t => t.classList.remove("active"));
    document.getElementById("tabAgendo").classList.add("active");
    renderLista();
  });
  document.getElementById("tabEnlace").addEventListener("click", () => {
    filtroActual = "enlace";
    document.querySelectorAll(".chat-tab").forEach(t => t.classList.remove("active"));
    document.getElementById("tabEnlace").classList.add("active");
    renderLista();
  });

  async function cargarConversaciones(){
    const data = await llamarGET("/conversaciones");
    if(!data) return;
    conversaciones = data.conversaciones || [];
    renderLista();
    if(senderSeleccionado) renderHead();
  }

  async function seleccionarChat(senderId){
    senderSeleccionado = senderId;
    mensajesMostrados = [];
    hayMasAntiguos = false;
    renderLista();
    renderHead();
    actualizarInputBar();
    document.getElementById("mensajeManual").value = "";
    document.getElementById("chatMensajes").innerHTML = '<div class="chat-empty">Cargando…</div>';
    document.getElementById("chatMensajes").dataset.primeraVez = "";
    await cargarUltimaPagina();
  }

  function construirBurbujaHTML(m){
    const esImagen = typeof m.content === "string" && m.content.startsWith("[[imagen]]");
    const esAudio = typeof m.content === "string" && m.content.startsWith("[[audio]]");
    let contenidoHTML;
    if (esImagen) {
      contenidoHTML = \`<img src="\${m.content.slice(10)}" alt="imagen enviada" loading="lazy">\`;
    } else if (esAudio) {
      contenidoHTML = \`<audio controls src="\${m.content.slice(9)}"></audio>\`;
    } else {
      contenidoHTML = escapar(m.content);
    }
    return \`
      <div class="bubble-row \${m.role === "assistant" ? "assistant" : "user"}">
        <div class="bubble\${(esImagen || esAudio) ? " bubble-imagen" : ""}">\${contenidoHTML}</div>
      </div>
    \`;
  }

  function renderMensajesCompleto(){
    const cont = document.getElementById("chatMensajes");
    if(mensajesMostrados.length === 0){
      cont.innerHTML = '<div class="chat-empty">Sin mensajes todavía en esta conversación.</div>';
      return;
    }
    const estabaAbajo = cont.scrollTop + cont.clientHeight >= cont.scrollHeight - 60;
    cont.innerHTML = mensajesMostrados.map(construirBurbujaHTML).join("");
    if(estabaAbajo || cont.dataset.primeraVez !== "hecho"){
      cont.scrollTop = cont.scrollHeight;
      cont.dataset.primeraVez = "hecho";
    }
  }

  // Carga la página más reciente de la conversación (los últimos mensajes) —
  // se usa al seleccionar un chat por primera vez.
  async function cargarUltimaPagina(){
    if(!senderSeleccionado) return;
    const data = await llamarGET("/historial-paginado/" + encodeURIComponent(senderSeleccionado) + "?limite=30");
    if(!data) return;
    mensajesMostrados = data.mensajes || [];
    hayMasAntiguos = Boolean(data.hay_mas_antiguos);
    document.getElementById("chatMensajes").dataset.primeraVez = "";
    renderMensajesCompleto();
  }

  // Se llama cuando el usuario hace scroll hacia arriba y llega cerca del
  // principio: pide la página de mensajes INMEDIATAMENTE ANTERIOR a la más
  // vieja que ya se está mostrando, y la agrega arriba sin perder la
  // posición visual de scroll (para que no "salte" la conversación).
  async function cargarPaginaAntigua(){
    if(!senderSeleccionado || !hayMasAntiguos || cargandoAntiguos) return;
    if(mensajesMostrados.length === 0) return;

    cargandoAntiguos = true;
    const cont = document.getElementById("chatMensajes");
    const alturaAntes = cont.scrollHeight;
    const scrollAntes = cont.scrollTop;

    const antes = mensajesMostrados[0].creado_en;
    const data = await llamarGET("/historial-paginado/" + encodeURIComponent(senderSeleccionado) + "?limite=30&antes=" + encodeURIComponent(antes));
    cargandoAntiguos = false;
    if(!data) return;

    const masAntiguos = data.mensajes || [];
    hayMasAntiguos = Boolean(data.hay_mas_antiguos);
    if(masAntiguos.length === 0) return;

    mensajesMostrados = [...masAntiguos, ...mensajesMostrados];
    renderMensajesCompleto();

    const alturaDespues = cont.scrollHeight;
    cont.scrollTop = scrollAntes + (alturaDespues - alturaAntes);
  }

  // Revisa si llegaron mensajes NUEVOS (más recientes que el último que ya
  // se está mostrando) y los agrega al final, sin rehacer todo el chat —
  // así no se rompe el scroll si el usuario está revisando mensajes viejos
  // hacia arriba en ese momento. Se usa tanto en el polling automático como
  // justo después de mandar un mensaje/foto/audio manual.
  async function revisarMensajesNuevos(){
    if(!senderSeleccionado) return;
    const data = await llamarGET("/historial-paginado/" + encodeURIComponent(senderSeleccionado) + "?limite=30");
    if(!data) return;
    const llegados = data.mensajes || [];
    if(llegados.length === 0) return;

    const ultimoActual = mensajesMostrados.length > 0 ? mensajesMostrados[mensajesMostrados.length - 1].creado_en : null;
    const nuevos = ultimoActual ? llegados.filter(m => m.creado_en > ultimoActual) : llegados;
    if(nuevos.length === 0) return;

    const cont = document.getElementById("chatMensajes");
    const estabaAbajo = cont.scrollTop + cont.clientHeight >= cont.scrollHeight - 60;

    mensajesMostrados = [...mensajesMostrados, ...nuevos];

    if(cont.dataset.primeraVez !== "hecho"){
      renderMensajesCompleto();
    } else {
      cont.insertAdjacentHTML("beforeend", nuevos.map(construirBurbujaHTML).join(""));
      if(estabaAbajo) cont.scrollTop = cont.scrollHeight;
    }
  }

  document.getElementById("chatMensajes").addEventListener("scroll", () => {
    const cont = document.getElementById("chatMensajes");
    if(cont.scrollTop < 80) cargarPaginaAntigua();
  });

  setInterval(() => {
    cargarConversaciones();
    if(senderSeleccionado) revisarMensajesNuevos();
  }, 4000);

  document.getElementById("btnReporteDolores").addEventListener("click", async () => {
    const btn = document.getElementById("btnReporteDolores");
    const textoOriginal = btn.textContent;
    const segmento = document.getElementById("segmentoReporteDolores").value;
    btn.disabled = true;
    btn.textContent = "⏳ Generando… (puede tardar un momento)";

    try {
      const res = await fetch("/exportar/dolores-obstaculos.csv?filtro=" + encodeURIComponent(segmento));
      if(res.status === 401){
        window.location.href = "/login?redirect=" + encodeURIComponent(window.location.pathname);
        return;
      }
      if(!res.ok){
        const data = await res.json().catch(() => ({}));
        alert("No se pudo generar el reporte: " + (data.error || "error desconocido"));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      let sufijo = "";
      if(segmento.startsWith("etiqueta:")) sufijo = "_" + segmento.slice(9).toLowerCase().replace(/\s+/g, "_");
      else if(segmento === "califica") sufijo = "_califican";
      else if(segmento === "nocalifica") sufijo = "_no_califican";
      else if(segmento === "agendo") sufijo = "_agendaron";
      else if(segmento === "enlace") sufijo = "_enlace_enviado";
      a.download = "dolores_obstaculos" + sufijo + "_" + new Date().toISOString().slice(0, 10) + ".csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Error de conexión generando el reporte: " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = textoOriginal;
    }
  });

  // Las etiquetas manuales que existan se agregan como opciones extra al
  // selector del reporte, para poder analizar cualquier grupo (ej. "compró").
  async function cargarEtiquetasEnSelectorReporte(){
    const data = await llamarGET("/etiquetas");
    const etiquetas = data?.etiquetas || [];
    if(etiquetas.length === 0) return;
    const select = document.getElementById("segmentoReporteDolores");
    etiquetas.forEach(et => {
      const valor = "etiqueta:" + et;
      if(select.querySelector(\`option[value="\${valor}"]\`)) return; // ya estaba, no se duplica
      const opt = document.createElement("option");
      opt.value = valor;
      opt.textContent = "🏷️ " + et;
      select.appendChild(opt);
    });
  }

  cargarEtapasDisponibles();
  cargarConversaciones();
  cargarEtiquetasEnSelectorReporte();
</script>
</body>
</html>
  `);
});

// Exporta a CSV las conversaciones que ya salieron de la ventana de 24h de
// Instagram (handoff), para poder darles seguimiento manual fuera del bot.
app.get("/exportar/handoff.csv", requireAdminKey, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("conversaciones")
      .select("sender_id, historial, ultimo_mensaje_usuario, actualizado_en")
      .order("ultimo_mensaje_usuario", { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    const fueraDeVentana = (data || []).filter((c) => {
      if (!c.ultimo_mensaje_usuario) return false;
      return (Date.now() - new Date(c.ultimo_mensaje_usuario).getTime()) >= VENTANA_24H_MS;
    });

    const filas = await Promise.all(fueraDeVentana.map(async (c) => {
      const perfil = await obtenerPerfilInstagram(c.sender_id);
      const historial = Array.isArray(c.historial) ? c.historial : [];
      const ultimo = historial.length > 0 ? historial[historial.length - 1] : null;
      const horasInactivo = Math.round((Date.now() - new Date(c.ultimo_mensaje_usuario).getTime()) / 3600000);

      return {
        username: perfil?.username || "",
        sender_id: c.sender_id,
        ultimo_mensaje_usuario: c.ultimo_mensaje_usuario,
        horas_inactivo: horasInactivo,
        ultimo_mensaje: ultimo ? ultimo.content : ""
      };
    }));

    const encabezados = ["username", "sender_id", "ultimo_mensaje_usuario", "horas_inactivo", "ultimo_mensaje"];
    const escaparCSV = (valor) => {
      const txt = String(valor ?? "");
      return /[",\n]/.test(txt) ? '"' + txt.replace(/"/g, '""') + '"' : txt;
    };

    const lineas = [
      encabezados.join(","),
      ...filas.map((f) => encabezados.map((h) => escaparCSV(f[h])).join(","))
    ];

    const csv = "\uFEFF" + lineas.join("\r\n");
    const fechaArchivo = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="handoff_${fechaArchivo}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Exporta a CSV los leads que ya calificaron según los criterios definidos en /panel.
app.get("/exportar/calificados.csv", requireAdminKey, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("conversaciones")
      .select("sender_id, historial, ultimo_mensaje_usuario, calificado_en, razon_calificacion, enlace_enviado, enlace_enviado_en")
      .eq("califica", true)
      .order("calificado_en", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const filas = await Promise.all((data || []).map(async (c) => {
      const perfil = await obtenerPerfilInstagram(c.sender_id);
      const historial = Array.isArray(c.historial) ? c.historial : [];
      const ultimo = historial.length > 0 ? historial[historial.length - 1] : null;
      const enVentana24h = c.ultimo_mensaje_usuario
        ? (Date.now() - new Date(c.ultimo_mensaje_usuario).getTime()) < VENTANA_24H_MS
        : false;

      return {
        username: perfil?.username || "",
        sender_id: c.sender_id,
        calificado_en: c.calificado_en || "",
        razon_calificacion: c.razon_calificacion || "",
        enlace_enviado: c.enlace_enviado ? "sí" : "no",
        enlace_enviado_en: c.enlace_enviado_en || "",
        en_ventana_24h: enVentana24h ? "sí" : "no (handoff)",
        ultimo_mensaje: ultimo ? ultimo.content : ""
      };
    }));

    const encabezados = ["username", "sender_id", "calificado_en", "razon_calificacion", "enlace_enviado", "enlace_enviado_en", "en_ventana_24h", "ultimo_mensaje"];
    const escaparCSV = (valor) => {
      const txt = String(valor ?? "");
      return /[",\n]/.test(txt) ? '"' + txt.replace(/"/g, '""') + '"' : txt;
    };

    const lineas = [
      encabezados.join(","),
      ...filas.map((f) => encabezados.map((h) => escaparCSV(f[h])).join(","))
    ];

    const csv = "\uFEFF" + lineas.join("\r\n");
    const fechaArchivo = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="calificados_${fechaArchivo}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Exporta a CSV los leads a los que ya se les mandó el enlace de calificación
// (calendario/formulario), detectado automáticamente en las respuestas del bot.
app.get("/exportar/enlace.csv", requireAdminKey, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("conversaciones")
      .select("sender_id, historial, ultimo_mensaje_usuario, enlace_enviado_en, califica, razon_calificacion")
      .eq("enlace_enviado", true)
      .order("enlace_enviado_en", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const filas = await Promise.all((data || []).map(async (c) => {
      const perfil = await obtenerPerfilInstagram(c.sender_id);
      const historial = Array.isArray(c.historial) ? c.historial : [];
      const ultimo = historial.length > 0 ? historial[historial.length - 1] : null;
      const enVentana24h = c.ultimo_mensaje_usuario
        ? (Date.now() - new Date(c.ultimo_mensaje_usuario).getTime()) < VENTANA_24H_MS
        : false;

      return {
        username: perfil?.username || "",
        sender_id: c.sender_id,
        enlace_enviado_en: c.enlace_enviado_en || "",
        califica: c.califica ? "sí" : "no",
        razon_calificacion: c.razon_calificacion || "",
        en_ventana_24h: enVentana24h ? "sí" : "no (handoff)",
        ultimo_mensaje: ultimo ? ultimo.content : ""
      };
    }));

    const encabezados = ["username", "sender_id", "enlace_enviado_en", "califica", "razon_calificacion", "en_ventana_24h", "ultimo_mensaje"];
    const escaparCSV = (valor) => {
      const txt = String(valor ?? "");
      return /[",\n]/.test(txt) ? '"' + txt.replace(/"/g, '""') + '"' : txt;
    };

    const lineas = [
      encabezados.join(","),
      ...filas.map((f) => encabezados.map((h) => escaparCSV(f[h])).join(","))
    ];

    const csv = "\uFEFF" + lineas.join("\r\n");
    const fechaArchivo = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="enlace_enviado_${fechaArchivo}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Analiza TODAS las conversaciones (hasta un límite razonable, las más
// recientes primero) y exporta un CSV con las frecuencias de dolores de
// salud, motivos estéticos, y obstáculos que fueron mencionando los leads —
// pensado para entender mejor al cliente y usarlo en publicidad/comunicación.
// Se procesa bajo demanda (el admin lo pide desde /chats) porque cada
// conversación requiere una llamada a la IA — puede tardar según cuántas
// conversaciones tengas. Se usa el registro COMPLETO de mensajes
// (mensajes_chat), no el "historial" recortado, para no perderse info que
// se haya dicho al principio de una conversación larga.
const LIMITE_CONVERSACIONES_REPORTE = 300;
const TAMANO_LOTE_REPORTE = 8;

// Exporta a CSV cualquier grupo de leads (según la pestaña activa en
// /chats: todas, califica, nocalifica, agendo, enlace, handoff, o
// seguimiento) — un solo endpoint flexible en vez de uno distinto por
// categoría, así el botón de descarga puede aparecer siempre, sin importar
// qué pestaña tengas abierta.
app.get("/exportar/leads.csv", requireAdminKey, async (req, res) => {
  try {
    const filtro = req.query.filtro || "todas";

    const { data, error } = await supabase
      .from("conversaciones")
      .select("sender_id, historial, ultimo_mensaje_usuario, actualizado_en, califica, calificado_en, razon_calificacion, no_califica, no_califica_en, razon_no_califica, agendo, agendo_en, enlace_enviado, enlace_enviado_en, etapa, etiquetas, monto_pagado")
      .order("actualizado_en", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    let filtradas = (data || []).map(c => {
      const enVentana24h = c.ultimo_mensaje_usuario
        ? (Date.now() - new Date(c.ultimo_mensaje_usuario).getTime()) < VENTANA_24H_MS
        : false;
      return { ...c, en_ventana_24h: enVentana24h };
    });

    if (filtro === "califica") filtradas = filtradas.filter(c => c.califica);
    else if (filtro === "nocalifica") filtradas = filtradas.filter(c => c.no_califica);
    else if (filtro === "agendo") filtradas = filtradas.filter(c => c.agendo);
    else if (filtro === "enlace") filtradas = filtradas.filter(c => c.enlace_enviado);
    else if (filtro === "handoff") filtradas = filtradas.filter(c => !c.en_ventana_24h);
    else if (filtro === "seguimiento") {
      const etiquetaCompra = configActual.dashboard_etiqueta_compro?.trim();
      const objetivo = etiquetaCompra ? normalizarParaComparar(etiquetaCompra) : null;
      filtradas = filtradas.filter(c =>
        !c.en_ventana_24h && !c.no_califica && !c.agendo &&
        !(objetivo && Array.isArray(c.etiquetas) && c.etiquetas.some(e => normalizarParaComparar(e) === objetivo))
      );
    }
    // "todas" (o cualquier otro valor): sin filtro adicional.

    const filas = await Promise.all(filtradas.map(async (c) => {
      const perfil = await obtenerPerfilInstagram(c.sender_id);
      const historial = Array.isArray(c.historial) ? c.historial : [];
      const ultimo = historial.length > 0 ? historial[historial.length - 1] : null;

      return {
        username: perfil?.username || "",
        sender_id: c.sender_id,
        etapa: c.etapa || "",
        califica: c.califica ? "sí" : "no",
        razon_calificacion: c.razon_calificacion || "",
        no_califica: c.no_califica ? "sí" : "no",
        razon_no_califica: c.razon_no_califica || "",
        agendo: c.agendo ? "sí" : "no",
        agendo_en: c.agendo_en || "",
        enlace_enviado: c.enlace_enviado ? "sí" : "no",
        enlace_enviado_en: c.enlace_enviado_en || "",
        en_ventana_24h: c.en_ventana_24h ? "sí" : "no (handoff)",
        etiquetas: Array.isArray(c.etiquetas) ? c.etiquetas.join(" | ") : "",
        monto_pagado: c.monto_pagado || 0,
        ultimo_mensaje_usuario: c.ultimo_mensaje_usuario || "",
        ultimo_mensaje: ultimo ? ultimo.content : ""
      };
    }));

    const encabezados = [
      "username", "sender_id", "etapa", "califica", "razon_calificacion",
      "no_califica", "razon_no_califica", "agendo", "agendo_en",
      "enlace_enviado", "enlace_enviado_en", "en_ventana_24h", "etiquetas",
      "monto_pagado", "ultimo_mensaje_usuario", "ultimo_mensaje"
    ];
    const escaparCSV = (valor) => {
      const txt = String(valor ?? "");
      return /[",\n]/.test(txt) ? '"' + txt.replace(/"/g, '""') + '"' : txt;
    };

    const lineas = [
      encabezados.join(","),
      ...filas.map((f) => encabezados.map((h) => escaparCSV(f[h])).join(","))
    ];

    const csv = "\uFEFF" + lineas.join("\r\n");
    const fechaArchivo = new Date().toISOString().slice(0, 10);
    const nombresArchivo = {
      todas: "todos_los_leads", califica: "califican", nocalifica: "no_califican",
      agendo: "agendaron", enlace: "enlace_enviado", handoff: "handoff", seguimiento: "seguimiento_pendiente"
    };
    const nombreArchivo = nombresArchivo[filtro] || "leads";

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${nombreArchivo}_${fechaArchivo}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/exportar/dolores-obstaculos.csv", requireAdminKey, async (req, res) => {
  try {
    // "filtro" permite enfocar el análisis en cualquier grupo: todos, los
    // que califican, los que NO califican, los que agendaron, los que
    // recibieron el enlace, o cualquier ETIQUETA manual que hayas creado
    // (ej. "compró") — usando el prefijo "etiqueta:nombre".
    const filtroRaw = req.query.filtro || "todos";
    const esEtiqueta = filtroRaw.startsWith("etiqueta:");
    const nombreEtiqueta = esEtiqueta ? filtroRaw.slice("etiqueta:".length) : null;
    const filtro = esEtiqueta ? "etiqueta" : (["califica", "nocalifica", "agendo", "enlace"].includes(filtroRaw) ? filtroRaw : "todos");

    let consulta = supabase
      .from("conversaciones")
      .select("sender_id")
      .order("actualizado_en", { ascending: false })
      .limit(LIMITE_CONVERSACIONES_REPORTE);

    if (filtro === "califica") consulta = consulta.eq("califica", true);
    if (filtro === "nocalifica") consulta = consulta.eq("no_califica", true);
    if (filtro === "agendo") consulta = consulta.eq("agendo", true);
    if (filtro === "enlace") consulta = consulta.eq("enlace_enviado", true);
    if (filtro === "etiqueta" && nombreEtiqueta) consulta = consulta.contains("etiquetas", [nombreEtiqueta]);

    const { data: conversaciones, error } = await consulta;

    if (error) return res.status(500).json({ error: error.message });

    const listaSenders = (conversaciones || []).map(c => c.sender_id);
    const resultados = [];

    for (let i = 0; i < listaSenders.length; i += TAMANO_LOTE_REPORTE) {
      const lote = listaSenders.slice(i, i + TAMANO_LOTE_REPORTE);

      const analisisLote = await Promise.all(lote.map(async (senderId) => {
        const { data: mensajes, error: errorMsgs } = await supabase
          .from("mensajes_chat")
          .select("role, content")
          .eq("sender_id", senderId)
          .order("creado_en", { ascending: true })
          .limit(200);

        if (errorMsgs) {
          console.error(`❌ Error leyendo mensajes_chat de ${senderId} para el reporte:`, errorMsgs.message);
          return null;
        }
        if (!mensajes || mensajes.length === 0) return null;
        if (!mensajes.some(m => m.role === "user")) return null; // sin nada que el cliente haya dicho

        const transcripcion = mensajes
          .filter(m => typeof m.content === "string" && !m.content.startsWith("[[imagen]]") && !m.content.startsWith("[[audio]]"))
          .map(m => `${m.role === "user" ? "Cliente" : "Asistente"}: ${m.content}`)
          .join("\n");

        if (!transcripcion.trim()) return null;

        const analisis = await analizarDoloresYObstaculos(transcripcion);
        if (!analisis) return null;

        const perfil = await obtenerPerfilInstagram(senderId);
        return { senderId, username: perfil?.username || senderId, ...analisis };
      }));

      resultados.push(...analisisLote.filter(Boolean));
    }

    const totalAnalizados = resultados.length;

    // "campos" es una lista porque la columna de "Dolor" combina salud +
    // estético en una sola bolsa de categorías (un mismo lead puede aportar
    // hasta 2 menciones si mencionó ambos tipos en su conversación).
    function contarCategorias(campos) {
      const conteos = {};
      for (const r of resultados) {
        for (const campo of campos) {
          const valor = r?.[campo];
          if (!valor || typeof valor !== "string") continue;
          const clave = normalizarParaComparar(valor);
          if (!clave) continue;
          conteos[clave] = (conteos[clave] || 0) + 1;
        }
      }
      return conteos;
    }

    // Se ordena de mayor a menor frecuencia y se arma como su propia lista
    // de filas [categoria, cantidad, porcentaje] — así en el CSV quedan como
    // bloques de columnas separados uno al lado del otro (Dolor / Obstáculo),
    // mucho más fácil de leer en Excel que una sola lista larga mezclada.
    function filasDeCategoria(conteos) {
      const entradas = Object.entries(conteos).sort((a, b) => b[1] - a[1]);
      return entradas.map(([categoria, cantidad]) => {
        const porcentaje = totalAnalizados > 0 ? ((cantidad / totalAnalizados) * 100).toFixed(1) + "%" : "0.0%";
        return [categoria, cantidad, porcentaje];
      });
    }

    const filasDolor = filasDeCategoria(contarCategorias(["dolor_salud", "dolor_estetico"]));
    const filasObstaculo = filasDeCategoria(contarCategorias(["obstaculo"]));

    const escaparCSV = (valor) => {
      const txt = String(valor ?? "");
      return /[",\n]/.test(txt) ? '"' + txt.replace(/"/g, '""') + '"' : txt;
    };

    const nombresSegmento = {
      todos: "Todos los leads",
      califica: "Solo leads que califican",
      nocalifica: "Solo leads que NO califican",
      agendo: "Solo leads que agendaron (confirmado)",
      enlace: "Solo leads con enlace de calendario enviado"
    };
    const nombreSegmento = esEtiqueta ? `Solo leads con la etiqueta "${nombreEtiqueta}"` : (nombresSegmento[filtro] || "Todos los leads");

    // Bloque 1: resumen de frecuencias (Dolor / Obstáculo), igual que antes.
    const encabezadoBloques = [
      "Dolor", "Cantidad", "Porcentaje", "",
      "Obstáculo", "Cantidad", "Porcentaje"
    ];

    const totalFilasResumen = Math.max(filasDolor.length, filasObstaculo.length);
    const filasResumen = [];
    for (let i = 0; i < totalFilasResumen; i++) {
      const dolor = filasDolor[i] || ["", "", ""];
      const obstaculo = filasObstaculo[i] || ["", "", ""];
      filasResumen.push([...dolor, "", ...obstaculo]);
    }

    // Bloque 2: detalle por cada lead — cuánto peso quiere perder, su
    // obstáculo, y una descripción legible de cómo le afecta / por qué
    // quiere bajar. Pensado para redactar contenido/publicidad usando sus
    // propias palabras, no solo para ver frecuencias agregadas.
    // Bloque 2: detalle por cada lead — edad, peso actual, peso objetivo,
    // cuánto peso quiere perder, su obstáculo, y una descripción legible de
    // cómo le afecta / por qué quiere bajar. Pensado para redactar
    // contenido/publicidad usando sus propias palabras, no solo para ver
    // frecuencias agregadas.
    const encabezadoDetalle = ["Usuario", "Edad", "Peso actual", "Peso objetivo", "Cuánto peso quiere perder", "Obstáculo", "Cómo le afecta / motivo"];
    const filasDetalle = resultados.map(r => [
      "@" + (r.username || r.senderId),
      r.edad || "(no especifica)",
      r.peso_actual || "(no especifica)",
      r.peso_objetivo || "(no especifica)",
      r.peso_a_perder || "(no especifica)",
      r.obstaculo || "(no menciona)",
      r.detalle || "(no especifica)"
    ]);

    const lineas = [
      `Segmento analizado:,${nombreSegmento}`,
      `Total de conversaciones analizadas:,${totalAnalizados}`,
      "",
      "RESUMEN DE FRECUENCIAS",
      encabezadoBloques.map(escaparCSV).join(","),
      ...filasResumen.map((fila) => fila.map(escaparCSV).join(",")),
      "",
      "DETALLE POR LEAD",
      encabezadoDetalle.map(escaparCSV).join(","),
      ...filasDetalle.map((fila) => fila.map(escaparCSV).join(","))
    ];

    const csv = "\uFEFF" + lineas.join("\r\n");
    const fechaArchivo = new Date().toISOString().slice(0, 10);
    const sufijosArchivo = { todos: "", califica: "_califican", nocalifica: "_no_califican", agendo: "_agendaron_confirmado", enlace: "_enlace_enviado" };
    const sufijoArchivo = esEtiqueta ? "_" + normalizarParaComparar(nombreEtiqueta).replace(/\s+/g, "_") : (sufijosArchivo[filtro] || "");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="dolores_obstaculos${sufijoArchivo}_${fechaArchivo}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/seguimientos/:senderId?", requireAdminKey, async (req, res) => {
  if (!req.params.senderId) {
    return res.json({ configuracion: configActual.seguimientos, configuracion_enlace: configActual.seguimientos_enlace });
  }
  const { data, error } = await supabase
    .from("seguimientos_programados")
    .select("*")
    .eq("sender_id", req.params.senderId)
    .order("disparar_en", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ configuracion: configActual.seguimientos, configuracion_enlace: configActual.seguimientos_enlace, seguimientos: data });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
