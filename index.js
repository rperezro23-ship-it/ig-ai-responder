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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
