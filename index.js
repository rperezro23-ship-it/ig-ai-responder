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

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const yaRespondidos = new Set();

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

      console.log(`📨 Mensaje de ${senderId}: "${mensaje}"`);

      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: AI_PROMPT },
            { role: "user",   content: mensaje }
          ],
          max_tokens: 300,
          temperature: 0.7
        });

        const respuesta = completion.choices[0]?.message?.content?.trim();
        if (!respuesta) continue;

        console.log(`🤖 Respuesta IA: "${respuesta}"`);

        // Endpoint correcto para Instagram API con Instagram Login
        await axios.post(
          `https://graph.instagram.com/v25.0/${IG_ACCOUNT_ID}/messages`,
          {
            recipient: { id: senderId },
            message:   { text: respuesta }
          },
          {
            headers: { "Authorization": `Bearer ${IG_ACCESS_TOKEN}` }
          }
        );

        console.log(`✅ Respondido a ${senderId}`);
      } catch (err) {
        console.error(`❌ Error al responder:`, err.response?.data || err.message);
      }
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
        <p>Esta aplicación no almacena de forma permanente el contenido de los mensajes
        directos procesados. Si deseas solicitar la eliminación de cualquier dato asociado
        a tu cuenta de Instagram que haya sido procesado por esta app, envía tu solicitud a:
        rperezro23@gmail.com, indicando tu nombre de usuario de Instagram. Procesaremos tu
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
// -------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
