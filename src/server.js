require("dotenv").config();
const express = require("express");
const { getContact, getMessages, sendSMS, sendInitialOutreach } = require("./ghl");
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
    const payload = req.body;
    console.log("Inbound webhook received:", JSON.stringify(payload, null, 2));

    const { contactId, conversationId, body: incomingText, direction, type } = payload;

    // Only process inbound messages (from the contact)
    if (direction !== "inbound") {
      return res.json({ skipped: "not an inbound message" });
    }

    // Only handle SMS and Email for now
    if (!["SMS", "Email"].includes(type)) {
      return res.json({ skipped: `unsupported type: ${type}` });
    }

    if (!contactId || !incomingText) {
      return res.status(400).json({ error: "Missing contactId or body" });
    }

    // Fetch recent conversation history so Claude has context
    const messages = await getMessages(conversationId);
    // GHL returns newest first — reverse so it's chronological
    const history = [...messages].reverse();

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
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Inbound webhook: POST http://localhost:${PORT}/webhook/inbound`);
  console.log(`Manual outreach: POST http://localhost:${PORT}/outreach`);
});
