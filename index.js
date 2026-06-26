const express = require("express");
const axios   = require("axios");
const OpenAI  = require("openai");

const app = express();
app.use(express.json());

const APP_SECRET      = process.env.APP_SECRET;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const AI_PROMPT       = process.env.AI_PROMPT || "Eres el asistente de Roberto, entrenador fitness. Responde de forma amigable y breve en español.";
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const yaRespondidos = new Set();

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

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  console.log("📩 Body completo:", JSON.stringify(body, null, 2));

  if (body.object !== "instagram") {
    console.log("⚠️ Ignorado, object es:", body.object);
    return;
  }

  for (const entry of body.entry || []) {
    console.log("🔍 Entry:", JSON.stringify(entry, null, 2));

    const eventos = [];

    for (const change of entry.changes || []) {
      console.log("🔍 Change field:", change.field, "value:", JSON.stringify(change.value));
      if (change.field === "messages" && change.value) {
        eventos.push(change.value);
      }
    }

    for (const ev of entry.messaging || []) {
      eventos.push(ev);
    }

    console.log("📋 Eventos a procesar:", eventos.length);

    for (const event of eventos) {
      const senderId = event.sender?.id;
      const mensaje  = event.message?.text;

      console.log(`👤 senderId: ${senderId}, mensaje: ${mensaje}`);

      if (!senderId || !mensaje) {
        console.log("⚠️ Sin senderId o mensaje, saltando");
        continue;
      }
      if (event.message?.is_echo) {
        console.log("⚠️ Es echo, saltando");
        continue;
      }

      const msgId = event.message?.mid;
      if (msgId && yaRespondidos.has(msgId)) {
        console.log("⚠️ Ya respondido, saltando");
        continue;
      }
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

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Instagram AI Responder activo 🤖" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
