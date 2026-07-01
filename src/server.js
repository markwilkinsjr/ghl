require("dotenv").config();
const express = require("express");
const {
  getContact,
  getMessages,
  findConversationByContact,
  sendSMS,
  addTag,
  contactShouldBeSkipped,
  sendInitialOutreach,
} = require("./ghl");
const { generateReply, isOptOut } = require("./claude");

const app = express();
app.use(express.json());

function verifyWebhookSecret(req, res, next) {
  const secret = req.headers["x-ghl-signature"] || req.query.secret;
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/health", (req, res) => res.json({ status: "ok" }));

// Inbound message webhook — fired by GHL when a contact replies
app.post("/webhook/inbound", async (req, res) => {
  try {
    const payload = req.body || {};
    console.log("Inbound webhook received:", JSON.stringify(payload, null, 2));

    const contactId =
      payload.contactId || payload.contact_id || payload.contact?.id || payload.id;
    let conversationId = payload.conversationId || payload.conversation_id;
    let incomingText =
      payload.body || payload.message || payload.messageBody || payload.text || "";

    if (!contactId) {
      return res.status(400).json({ error: "Missing contactId" });
    }

    // Fetch contact to check exclusion tags + conversation state
    const contact = await getContact(contactId);

    if (contactShouldBeSkipped(contact)) {
      console.log(`Skipping contact ${contactId} — exclusion tag`);
      return res.json({ skipped: "contact has exclusion tag" });
    }

    // If Jordan already said goodbye, stop responding
    const tags = (contact.tags || []).map((t) => String(t).toLowerCase());
    if (tags.includes("conversation-ended")) {
      console.log(`Skipping contact ${contactId} — conversation already ended`);
      return res.json({ skipped: "conversation ended" });
    }

    if (!conversationId) {
      const convo = await findConversationByContact(contactId);
      conversationId = convo?.id;
    }

    let history = [];
    if (conversationId) {
      const messages = await getMessages(conversationId);
      history = [...messages].reverse();
    }

    if (!incomingText && history.length) {
      const lastInbound = [...history]
        .reverse()
        .find((m) => m.direction === "inbound");
      incomingText = lastInbound?.body || lastInbound?.text || "";
    }

    if (!incomingText) {
      return res.json({ skipped: "no message text to respond to" });
    }

    // Hard STOP handling — TCPA compliance
    if (isOptOut(incomingText)) {
      await addTag(contactId, ["opted-out", "conversation-ended"]);
      console.log(`Contact ${contactId} opted out — stopping`);
      return res.json({ success: true, action: "opted-out" });
    }

    // Ask Claude for a reply
    const { text, isGoodbye, isHot } = await generateReply(history, incomingText);

    if (isGoodbye) {
      await addTag(contactId, ["conversation-ended"]);
      console.log(`Claude returned goodbye — ending conversation with ${contactId}`);
      return res.json({ success: true, action: "conversation-ended" });
    }

    if (isHot) {
      await addTag(contactId, ["hot-lead", "needs-human-followup"]);
      console.log(`🔥 HOT LEAD detected: ${contactId}`);
    }

    await sendSMS(contactId, text);

    console.log(`Replied to ${contactId}: ${text}`);
    res.json({ success: true, reply: text, hot: isHot });
  } catch (err) {
    console.error("Error handling inbound webhook:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Manual outreach trigger — respects the exclusion list
app.post("/outreach", verifyWebhookSecret, async (req, res) => {
  try {
    const { contactId } = req.body;
    if (!contactId) return res.status(400).json({ error: "contactId required" });
    const result = await sendInitialOutreach(contactId);
    res.json(result);
  } catch (err) {
    console.error("Error sending outreach:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Batch endpoint — send outreach to many contacts at once (with pacing)
app.post("/outreach/batch", verifyWebhookSecret, async (req, res) => {
  try {
    const { contactIds = [], delayMs = 3000 } = req.body;
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json({ error: "contactIds array required" });
    }

    const results = [];
    for (const contactId of contactIds) {
      try {
        const r = await sendInitialOutreach(contactId);
        results.push({ contactId, ...r });
      } catch (e) {
        results.push({ contactId, error: e.message });
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }

    const sent = results.filter((r) => r.success).length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.filter((r) => r.error).length;

    res.json({ total: contactIds.length, sent, skipped, failed, results });
  } catch (err) {
    console.error("Error in batch outreach:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
