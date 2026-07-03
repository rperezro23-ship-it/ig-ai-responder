const express = require("express");
const crypto  = require("crypto");
const axios   = require("axios");
const OpenAI  = require("openai");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// Render está detrás de un proxy: sin esto, req.protocol siempre da "http"
// aunque el usuario haya entrado por https, lo cual rompe el redirect_uri
// que mandamos a Meta en el flujo de OAuth (Meta exige que coincida exacto).
app.set("trust proxy", true);

// Necesitamos el body "crudo" para poder verificar la firma que manda Meta
app.use(express.json({
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
  while (historial.length > configActual.max_historial) historial.shift();
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
  for (let i = 0; i < configActual.seguimientos.length; i++) {
    const { horas, mensajes } = configActual.seguimientos[i];
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

    if (!sigueVigente) {
      console.log(`⏭️ Seguimiento (paso ${pasoIndex}) para ${senderId} descartado: fuera de la ventana de 24h.`);
      await supabase.from("seguimientos_programados").update({ enviado: true }).eq("id", id);
      continue;
    }

    const pasoConfig = configActual.seguimientos[pasoIndex];
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

async function enviarMensajeInstagram(senderId, texto) {
  const cuenta = await obtenerCuentaActiva();
  if (!cuenta) throw new Error("No hay ninguna cuenta de Instagram conectada.");

  await axios.post(
    `https://graph.instagram.com/v25.0/${cuenta.ig_id}/messages`,
    {
      recipient: { id: senderId },
      message:   { text: texto }
    },
    {
      headers: { "Authorization": `Bearer ${cuenta.access_token}` }
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

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: configActual.ai_prompt },
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
      const mensaje  = event.message?.text;

      if (!senderId || !mensaje) continue;
      if (event.message?.is_echo) continue;

      const msgId = event.message?.mid;
      if (msgId && yaRespondidos.has(msgId)) continue;
      if (msgId) yaRespondidos.add(msgId);

      console.log(`📨 Mensaje recibido de ${senderId}: "${mensaje}" (esperando a ver si manda más líneas...)`);

      await registrarMensajeUsuario(senderId);
      await cancelarSeguimientosPendientesDB(senderId);

      encolarMensaje(senderId, mensaje);
    }
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

// Resumen de todas las conversaciones (usado por /chats para la lista de la izquierda).
// Solo trae lo necesario para pintar la lista: último mensaje, quién lo mandó y cuándo.
app.get("/conversaciones", requireAdminKey, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("conversaciones")
      .select("sender_id, historial, ultimo_mensaje_usuario, actualizado_en")
      .order("actualizado_en", { ascending: false })
      .limit(200);

    if (error) return res.status(500).json({ error: error.message });

    const resumen = await Promise.all((data || []).map(async (c) => {
      const historial = Array.isArray(c.historial) ? c.historial : [];
      const ultimo = historial.length > 0 ? historial[historial.length - 1] : null;
      const perfil = await obtenerPerfilInstagram(c.sender_id);

      const enVentana24h = c.ultimo_mensaje_usuario
        ? (Date.now() - new Date(c.ultimo_mensaje_usuario).getTime()) < VENTANA_24H_MS
        : false;

      return {
        sender_id: c.sender_id,
        username: perfil?.username || null,
        profile_pic: perfil?.profile_pic || null,
        ultimo_mensaje_usuario: c.ultimo_mensaje_usuario,
        actualizado_en: c.actualizado_en,
        ultimo_texto: ultimo ? ultimo.content : null,
        ultimo_role: ultimo ? ultimo.role : null,
        en_ventana_24h: enVentana24h
      };
    }));

    res.json({ conversaciones: resumen });
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
    await enviarMensajeInstagram(senderId, texto);
    await agregarAlHistorialDB(senderId, "assistant", texto);

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
  min_delay: MIN_DELAY_SECONDS,
  max_delay: MAX_DELAY_SECONDS,
  max_historial: MAX_HISTORIAL,
  seguimientos: SEGUIMIENTOS_CONFIG
};

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
      configActual.seguimientos = [...configActual.seguimientos].sort((a, b) => a.horas - b.horas);
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
  configActual.seguimientos = [...configActual.seguimientos].sort((a, b) => a.horas - b.horas);

  const { error } = await supabase
    .from("app_config")
    .upsert({ key: "bot_config", valor: configActual, actualizado_en: new Date().toISOString() });

  if (error) console.error("❌ Error guardando configuración en Supabase:", error.message);
  return configActual;
}

cargarConfigDesdeDB();

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
  res.json(configActual);
});

app.post("/config", requireAdminKey, async (req, res) => {
  try {
    const { ai_prompt, min_delay, max_delay, max_historial, seguimientos } = req.body || {};

    const nuevaConfig = {};
    if (typeof ai_prompt === "string" && ai_prompt.trim()) nuevaConfig.ai_prompt = ai_prompt.trim();
    if (Number.isFinite(min_delay) && min_delay >= 0) nuevaConfig.min_delay = min_delay;
    if (Number.isFinite(max_delay) && max_delay >= 0) nuevaConfig.max_delay = max_delay;
    if (Number.isFinite(max_historial) && max_historial > 0) nuevaConfig.max_historial = max_historial;
    if (Array.isArray(seguimientos)) nuevaConfig.seguimientos = seguimientos;

    const guardado = await guardarConfigDB(nuevaConfig);
    res.json({ mensaje: "✅ Configuración guardada", config: guardado });
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
  /* --- Estilos específicos del panel --- */
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
    background:rgba(255,255,255,.015);
  }
  .paso-head{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px; }
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
        <div class="card">
          <h2>Mensaje del bot</h2>
          <p class="hint">Instrucciones que sigue la IA para responder a los clientes. Sé específico: tono, qué información dar, qué evitar.</p>
          <label for="prompt">Prompt del sistema</label>
          <textarea id="prompt" rows="8" placeholder="Eres el asistente de..."></textarea>
        </div>

        <div class="card">
          <h2>Tiempos de respuesta</h2>
          <p class="hint">Antes de contestar, el bot espera un rato aleatorio entre estos dos valores — así da tiempo a que el cliente termine de escribir varias líneas seguidas.</p>
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
          <p class="hint">Cuántos mensajes recientes (tuyos y del cliente) recuerda el bot al responder. Más alto = más contexto, pero más costo por respuesta.</p>
          <label for="maxHistorial">Mensajes a recordar</label>
          <input type="number" id="maxHistorial" min="1">
        </div>
      </div>

      <div class="col">
        <div class="card">
          <h2>Seguimientos automáticos</h2>
          <p class="hint">Si el cliente deja de responder, el bot le manda estos mensajes después de X horas de silencio (siempre dentro de la ventana de 24h que permite Instagram). Cada paso rota entre varias opciones de mensaje para no sonar repetitivo.</p>
          <div id="pasos"></div>
          <button class="add-paso" id="addPaso" type="button">+ Agregar paso de seguimiento</button>
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

  // --- Seguimientos: editor dinámico ---
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
        <textarea class="paso-mensajes" data-i="\${i}" rows="3">\${(paso.mensajes || []).join("\\n")}</textarea>
      \`;
      cont.appendChild(div);
    });
    cont.querySelectorAll(".quitar").forEach(b => b.addEventListener("click", e => {
      pasos.splice(+e.target.dataset.i, 1); renderPasos();
    }));
  }

  document.getElementById("addPaso").addEventListener("click", () => {
    pasos.push({ horas: 1, mensajes: ["Escribe aquí un mensaje de seguimiento..."] });
    renderPasos();
  });

  function leerPasosDelDOM(){
    document.querySelectorAll(".paso-horas").forEach((input, i) => { pasos[i].horas = parseFloat(input.value) || 0; });
    document.querySelectorAll(".paso-mensajes").forEach((ta, i) => {
      pasos[i].mensajes = ta.value.split("\\n").map(m => m.trim()).filter(Boolean);
    });
  }

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
    document.getElementById("minDelay").value = cfg.min_delay ?? 8;
    document.getElementById("maxDelay").value = cfg.max_delay ?? 15;
    document.getElementById("maxHistorial").value = cfg.max_historial ?? 20;
    pasos = Array.isArray(cfg.seguimientos) ? JSON.parse(JSON.stringify(cfg.seguimientos)) : [];
    renderPasos();
    document.getElementById("btnGuardar").disabled = false;
  }

  document.getElementById("btnGuardar").addEventListener("click", async () => {
    leerPasosDelDOM();
    if(pasos.length === 0){
      if(!confirm("No hay ningún paso de seguimiento configurado. ¿Seguro que quieres guardar así (se quedará sin seguimientos automáticos)?")) return;
    }
    const body = {
      ai_prompt: document.getElementById("prompt").value,
      min_delay: parseInt(document.getElementById("minDelay").value, 10),
      max_delay: parseInt(document.getElementById("maxDelay").value, 10),
      max_historial: parseInt(document.getElementById("maxHistorial").value, 10),
      seguimientos: pasos
    };
    const msg = document.getElementById("saveMsg");
    msg.style.color = "";
    msg.textContent = "Guardando…"; msg.className = "save-msg";
    const data = await llamarPOST("/config", body);
    if(data){ msg.textContent = "✓ Guardado"; msg.className = "save-msg ok"; }
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
  .chat-tabs{ display:flex; gap:8px; padding:12px 14px; border-bottom:1px solid var(--border); flex-shrink:0; }
  .chat-tab{
    flex:1; text-align:center; padding:9px 8px; border-radius:9px; font-size:13px;
    font-weight:600; cursor:pointer; color:var(--muted); background:var(--surface-3);
    border:1px solid transparent; transition:background .12s, color .12s;
  }
  .chat-tab:hover{ color:var(--text); }
  .chat-tab.active{ background:var(--green-soft); color:var(--green); border-color:rgba(49,217,124,.3); }
  .chat-tab.tab-handoff.active{ background:var(--red-soft); color:var(--red); border-color:rgba(255,93,93,.3); }
  .chat-tab .count{ font-family:var(--mono); font-size:11.5px; opacity:.85; margin-left:4px; }
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
  .chat-export{ padding:10px 14px; border-bottom:1px solid var(--border); flex-shrink:0; }
  .btn-exportar{
    display:block; text-align:center; background:var(--surface-3); color:var(--text);
    border:1px solid var(--border); border-radius:9px; padding:10px 10px; font-size:13px;
    font-weight:600; text-decoration:none; transition:background .12s, border-color .12s, color .12s;
  }
  .btn-exportar:hover{ background:var(--surface-2); border-color:var(--red); color:var(--red); }
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
          <div class="chat-tab active" id="tabTodas" data-filtro="todas">Todas <span class="count" id="countTodas"></span></div>
          <div class="chat-tab tab-handoff" id="tabHandoff" data-filtro="handoff">Handoff (+24h) <span class="count" id="countHandoff"></span></div>
        </div>
        <div class="chat-export">
          <a id="btnExportarCSV" href="/exportar/handoff.csv" class="btn-exportar">⬇ Exportar CSV handoff <span id="exportCount">(0)</span></a>
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
        <div class="chat-messages" id="chatMensajes">
          <div class="chat-empty">Elige una conversación de la izquierda para ver los mensajes.</div>
        </div>
        <div class="chat-input-error" id="chatInputError"></div>
        <div class="chat-input-bar" id="chatInputBar">
          <textarea id="mensajeManual" rows="1" placeholder="Escribe una respuesta manual…"></textarea>
          <button class="btn-enviar" id="btnEnviarManual">Enviar</button>
        </div>
      </div>
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

  let conversaciones = [];
  let senderSeleccionado = null;
  let ultimoHistorialJSON = null;
  let filtroActual = "todas";

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

  // Genera el <img>; si la foto no carga (token vencido, permiso, etc.)
  // se reemplaza sola por un círculo con la inicial del usuario.
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

  function actualizarContadores(){
    const totalHandoff = conversaciones.filter(c => !c.en_ventana_24h).length;
    document.getElementById("countTodas").textContent = conversaciones.length;
    document.getElementById("countHandoff").textContent = totalHandoff;
    document.getElementById("exportCount").textContent = "(" + totalHandoff + ")";
  }

  function conversacionesFiltradas(){
    if(filtroActual === "handoff") return conversaciones.filter(c => !c.en_ventana_24h);
    return conversaciones;
  }

  function renderLista(){
    const cont = document.getElementById("listaChats");
    actualizarContadores();
    const lista = conversacionesFiltradas();

    if(lista.length === 0){
      cont.innerHTML = filtroActual === "handoff"
        ? '<p class="vacio-lista">🎉 Ninguna conversación en handoff — todas están dentro de la ventana de 24h.</p>'
        : '<p class="vacio-lista">Todavía no hay conversaciones.</p>';
      return;
    }

    cont.innerHTML = lista.map(c => \`
      <div class="chat-list-item\${senderSeleccionado === c.sender_id ? " active" : ""}" data-id="\${c.sender_id}">
        \${avatarHTML(c)}
        <div class="chat-list-item-text">
          <div class="uname-row">
            <span class="uname">\${escapar(nombreMostrar(c))}</span>
            \${!c.en_ventana_24h ? '<span class="handoff-dot" title="Fuera de la ventana de 24h"></span>' : ''}
          </div>
          <div class="preview">\${c.ultimo_role === "assistant" ? "🤖 " : ""}\${escapar(c.ultimo_texto) || "(sin mensajes)"}</div>
          <div class="time">\${formatearFecha(c.actualizado_en)}</div>
        </div>
      </div>
    \`).join("");

    cont.querySelectorAll(".chat-list-item").forEach(el => {
      el.addEventListener("click", () => seleccionarChat(el.dataset.id));
    });
  }

  function renderHead(){
    const head = document.getElementById("chatHead");
    const banner = document.getElementById("handoffBanner");
    if(!senderSeleccionado){
      head.innerHTML = '<span style="color:var(--muted); font-size:14px;">Selecciona una conversación</span>';
      banner.classList.remove("visible");
      return;
    }
    const conv = conversaciones.find(c => c.sender_id === senderSeleccionado) || { sender_id: senderSeleccionado, en_ventana_24h: true };
    head.innerHTML = \`
      \${avatarHTML(conv)}
      <div class="chat-window-head-text">
        <div class="chat-window-head-uname">\${escapar(nombreMostrar(conv))}</div>
        <div class="chat-window-head-id">\${conv.sender_id}</div>
      </div>
    \`;
    banner.classList.toggle("visible", conv.en_ventana_24h === false);
  }

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
        ultimoHistorialJSON = null;
        await cargarHistorial();
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

  document.getElementById("tabTodas").addEventListener("click", () => {
    filtroActual = "todas";
    document.getElementById("tabTodas").classList.add("active");
    document.getElementById("tabHandoff").classList.remove("active");
    renderLista();
  });
  document.getElementById("tabHandoff").addEventListener("click", () => {
    filtroActual = "handoff";
    document.getElementById("tabHandoff").classList.add("active");
    document.getElementById("tabTodas").classList.remove("active");
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
    ultimoHistorialJSON = null;
    renderLista();
    renderHead();
    actualizarInputBar();
    document.getElementById("mensajeManual").value = "";
    document.getElementById("chatMensajes").innerHTML = '<div class="chat-empty">Cargando…</div>';
    await cargarHistorial();
  }

  function renderMensajes(historial){
    const cont = document.getElementById("chatMensajes");
    if(!historial || historial.length === 0){
      cont.innerHTML = '<div class="chat-empty">Sin mensajes todavía en esta conversación.</div>';
      return;
    }
    const estabaAbajo = cont.scrollTop + cont.clientHeight >= cont.scrollHeight - 60;
    cont.innerHTML = historial.map(m => \`
      <div class="bubble-row \${m.role === "assistant" ? "assistant" : "user"}">
        <div class="bubble">\${escapar(m.content)}</div>
      </div>
    \`).join("");
    if(estabaAbajo || cont.dataset.primeraVez !== "hecho"){
      cont.scrollTop = cont.scrollHeight;
      cont.dataset.primeraVez = "hecho";
    }
  }

  async function cargarHistorial(){
    if(!senderSeleccionado) return;
    const data = await llamarGET("/historial/" + encodeURIComponent(senderSeleccionado));
    if(!data) return;
    const json = JSON.stringify(data.historial || []);
    if(json === ultimoHistorialJSON) return;
    ultimoHistorialJSON = json;
    document.getElementById("chatMensajes").dataset.primeraVez = "";
    renderMensajes(data.historial || []);
  }

  setInterval(() => {
    cargarConversaciones();
    if(senderSeleccionado) cargarHistorial();
  }, 4000);

  cargarConversaciones();
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
        username: perfil?.username ? "@" + perfil.username : "",
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

    // BOM al inicio para que Excel abra los acentos/emojis correctamente.
    const csv = "\uFEFF" + lineas.join("\r\n");
    const fechaArchivo = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="handoff_${fechaArchivo}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/seguimientos/:senderId?", requireAdminKey, async (req, res) => {
  if (!req.params.senderId) {
    return res.json({ configuracion: configActual.seguimientos });
  }
  const { data, error } = await supabase
    .from("seguimientos_programados")
    .select("*")
    .eq("sender_id", req.params.senderId)
    .order("disparar_en", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ configuracion: configActual.seguimientos, seguimientos: data });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
