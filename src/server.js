require("dotenv").config();
const express = require("express");
const {
  getContact,
  getMessages,
  findConversationByContact,
  sendSMS,
  sendInitialOutreach,
} = require("./ghl");
const { generateReply } = require("./claude");

const app = express();
app.use(express.json());

// Optional: verify GHL webhook secret
function verifyWebhookSecret(req, res, next) {
  const secret = req.headers["x-ghl-signature"] || req.query.secret;
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Inbound message webhook — fired by GHL when a contact replies
app.post("/webhook/inbound", verifyWebhookSecret, async (req, res) => {
  try {
    const payload = req.body || {};
    console.log("Inbound webhook received:", JSON.stringify(payload, null, 2));

    // GHL workflow webhooks vary in shape — pull fields from several possible names
    const contactId =
      payload.contactId || payload.contact_id || payload.contact?.id || payload.id;

    let conversationId = payload.conversationId || payload.conversation_id;

    // The reply text may arrive under different keys (or not at all)
    let incomingText =
      payload.body || payload.message || payload.messageBody || payload.text || "";

    if (!contactId) {
      console.warn("No contactId found in payload");
      return res.status(400).json({ error: "Missing contactId" });
    }

    // If we don't have a conversation, look it up by contact
    if (!conversationId) {
      const convo = await findConversationByContact(contactId);
      conversationId = convo?.id;
    }

    // Fetch conversation history so Claude has context
    let history = [];
    if (conversationId) {
      const messages = await getMessages(conversationId);
      // GHL returns newest first — reverse so it's chronological
      history = [...messages].reverse();
    }

    // If the webhook didn't include the message text, use the latest inbound
    // message from the fetched history
    if (!incomingText && history.length) {
      const lastInbound = [...history]
        .reverse()
        .find((m) => m.direction === "inbound");
      incomingText = lastInbound?.body || lastInbound?.text || "";
    }

    if (!incomingText) {
      console.warn("No incoming message text found");
      return res.json({ skipped: "no message text to respond to" });
    }

    // Generate Claude's reply
    const reply = await generateReply(history, incomingText);

    // Send back via SMS
    await sendSMS(contactId, reply);

    console.log(`Replied to contact ${contactId}: ${reply}`);
    res.json({ success: true, reply });
  } catch (err) {
    console.error("Error handling inbound webhook:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Manual trigger endpoint — call this to start the outreach for a specific contact
// POST /outreach { "contactId": "abc123" }
app.post("/outreach", verifyWebhookSecret, async (req, res) => {
  try {
    const { contactId } = req.body;
    if (!contactId) return res.status(400).json({ error: "contactId required" });

    const result = await sendInitialOutreach(contactId);
    console.log(`Initial outreach sent to ${contactId}`);
    res.json({ success: true, result });
  } catch (err) {
    console.error("Error sending outreach:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Inbound webhook: POST http://localhost:${PORT}/webhook/inbound`);
  console.log(`Manual outreach: POST http://localhost:${PORT}/outreach`);
});
