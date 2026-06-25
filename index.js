const express = require("express");
const axios   = require("axios");
const OpenAI  = require("openai");

const app = express();
app.use(express.json());

// ── Configuración (se ponen como variables de entorno en Render) ──
const APP_SECRET      = process.env.APP_SECRET;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;    // tú lo inventas, ej: "roberto123"
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const AI_PROMPT       = process.env.AI_PROMPT || "Eres el asistente de Roberto, entrenador fitness. Responde de forma amigable y breve en español.";
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN; // se obtiene después del OAuth

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Guarda los mensajes ya respondidos para no repetir
const yaRespondidos = new Set();

// ── Verificación del webhook (Meta lo llama una vez al configurar) ──
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

// ── Recibe mensajes nuevos de Instagram ──────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Responde inmediatamente a Meta

  const body = req.body;
  if (body.object !== "instagram") return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const senderId = event.sender?.id;
      const mensaje  = event.message?.text;

      if (!senderId || !mensaje) continue;

      // No responder mensajes enviados por nosotros mismos
      if (event.message?.is_echo) continue;

      // No repetir respuestas
      const msgId = event.message?.mid;
      if (msgId && yaRespondidos.has(msgId)) continue;
      if (msgId) yaRespondidos.add(msgId);

      console.log(`📨 Mensaje de ${senderId}: "${mensaje}"`);

      try {
        // Llama a OpenAI
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

        // Envía la respuesta via API de Instagram
        await axios.post(
          `https://graph.facebook.com/v19.0/me/messages`,
          {
            recipient: { id: senderId },
            message:   { text: respuesta }
          },
          {
            params: { access_token: IG_ACCESS_TOKEN }
          }
        );

        console.log(`✅ Respondido a ${senderId}`);
      } catch (err) {
        console.error(`❌ Error al responder:`, err.response?.data || err.message);
      }
    }
  }
});

// ── Ruta de salud para que Render sepa que el servidor está vivo ──
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Instagram AI Responder activo 🤖" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
