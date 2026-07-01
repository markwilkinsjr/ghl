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
  pickEligibleContacts,
  searchContactsByTag,
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
    // GHL webhook nests the message body under `message.body`. Fall back to
    // top-level fields for other webhook shapes. Coerce to string so
    // downstream `.trim()` etc. never crash.
    let incomingText = String(
      payload.message?.body ||
      payload.messageBody ||
      payload.body ||
      payload.text ||
      ""
    );

    if (!contactId) {
      return res.status(400).json({ error: "Missing contactId" });
    }

    // Fetch contact to check exclusion tags + conversation state
    const contact = await getContact(contactId);

    const skip = contactShouldBeSkipped(contact);
    if (skip.skip) {
      console.log(`Skipping contact ${contactId} — ${skip.reason}`);
      return res.json({ skipped: skip.reason });
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

// Auto-batch preview — dry run: shows which contacts WOULD receive outreach.
// Sends no texts. Safe to run any time.
app.post("/outreach/auto-batch/preview", verifyWebhookSecret, async (req, res) => {
  try {
    const count = Number(req.body?.count) || 25;
    const { eligible, skipped, pool_size } = await pickEligibleContacts(count);
    res.json({
      pool_size,
      would_send: eligible.length,
      would_skip: skipped.length,
      picks: eligible.map((c) => ({
        id: c.id,
        name: `${c.firstName || ""} ${c.lastName || ""}`.trim() || c.contactName,
        email: c.email,
        phone: c.phone,
      })),
      skipped_sample: skipped.slice(0, 10),
    });
  } catch (err) {
    console.error("Preview error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Auto-batch run — picks N eligible contacts and sends outreach with pacing.
app.post("/outreach/auto-batch/run", verifyWebhookSecret, async (req, res) => {
  try {
    const count = Number(req.body?.count) || 25;
    const delayMs = Number(req.body?.delayMs) || 3000;

    const { eligible } = await pickEligibleContacts(count);
    if (eligible.length === 0) {
      return res.json({ sent: 0, message: "No eligible contacts found." });
    }

    const results = [];
    for (const c of eligible) {
      try {
        const r = await sendInitialOutreach(c.id);
        results.push({ id: c.id, name: c.firstName, phone: c.phone, ...r });
      } catch (e) {
        results.push({ id: c.id, error: e.message });
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }

    const sent = results.filter((r) => r.success).length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.filter((r) => r.error).length;

    res.json({ requested: count, sent, skipped, failed, results });
  } catch (err) {
    console.error("Auto-batch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Report: campaign performance for everyone tagged `ai-outreach-sent`.
// Returns counts + a list of contacts by stage.
app.post("/report", verifyWebhookSecret, async (req, res) => {
  try {
    const outreached = await searchContactsByTag("ai-outreach-sent");

    const stats = {
      total_texted: outreached.length,
      hot_leads: 0,
      opted_out: 0,
      conversation_ended: 0,
      replied: 0,
      no_reply_yet: 0,
    };

    const buckets = { hot: [], opted_out: [], ended: [], replied: [], no_reply: [] };

    // For each contact, fetch conversation to count inbound (their replies)
    for (const c of outreached) {
      const tags = (c.tags || []).map((t) => String(t).toLowerCase());
      let convo, msgs = [];
      try {
        convo = await findConversationByContact(c.id);
        if (convo?.id) msgs = await getMessages(convo.id);
      } catch (e) {
        // ignore, treat as no reply
      }
      const inbound = msgs.filter((m) => m.direction === "inbound");
      const replied = inbound.length > 0;

      const row = {
        id: c.id,
        name: `${c.firstName || ""} ${c.lastName || ""}`.trim() || c.contactName || "(no name)",
        phone: c.phone,
        replies: inbound.length,
      };

      if (tags.includes("hot-lead")) {
        stats.hot_leads++;
        buckets.hot.push(row);
      }
      if (tags.includes("opted-out")) {
        stats.opted_out++;
        buckets.opted_out.push(row);
      }
      if (tags.includes("conversation-ended") && !tags.includes("opted-out")) {
        stats.conversation_ended++;
        buckets.ended.push(row);
      }
      if (replied) {
        stats.replied++;
        if (!tags.includes("hot-lead")) buckets.replied.push(row);
      } else {
        stats.no_reply_yet++;
        buckets.no_reply.push(row);
      }
    }

    stats.reply_rate =
      stats.total_texted > 0
        ? Math.round((stats.replied / stats.total_texted) * 100) + "%"
        : "0%";

    res.json({
      generated_at: new Date().toISOString(),
      stats,
      hot_leads: buckets.hot,
      opted_out: buckets.opted_out,
      conversation_ended: buckets.ended,
      replied_still_active: buckets.replied,
      no_reply_yet: buckets.no_reply,
    });
  } catch (err) {
    console.error("Report error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Conversations report — for every lead who replied, dump the message thread
// so you can review Jordan's live handling.
app.post("/report/conversations", verifyWebhookSecret, async (req, res) => {
  try {
    const outreached = await searchContactsByTag("ai-outreach-sent");
    const threads = [];

    for (const c of outreached) {
      let msgs = [];
      try {
        const convo = await findConversationByContact(c.id);
        if (convo?.id) msgs = await getMessages(convo.id);
      } catch (e) {
        continue;
      }

      // GHL returns newest first — reverse to chronological
      const chronological = [...msgs].reverse();
      const inbound = chronological.filter((m) => m.direction === "inbound");
      if (inbound.length === 0) continue;

      const tags = (c.tags || []).map((t) => String(t).toLowerCase());
      threads.push({
        id: c.id,
        name: `${c.firstName || ""} ${c.lastName || ""}`.trim() || c.contactName || "(no name)",
        phone: c.phone,
        tags: tags.filter((t) =>
          ["hot-lead", "opted-out", "conversation-ended", "ai-outreach-sent"].includes(t)
        ),
        message_count: chronological.length,
        thread: chronological.map((m) => ({
          from: m.direction === "inbound" ? "LEAD" : "JORDAN",
          at: m.dateAdded,
          body: (m.body || m.text || "").trim(),
        })),
      });
    }

    // Sort so most-active convos come first
    threads.sort((a, b) => b.message_count - a.message_count);

    res.json({
      generated_at: new Date().toISOString(),
      active_conversations: threads.length,
      threads,
    });
  } catch (err) {
    console.error("Conversations report error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Catch-up: for every contact tagged `ai-outreach-sent`, look at their conversation.
// If the LAST message is from the lead (Jordan never replied), respond now.
// This heals conversations that were dropped during a webhook bug window.
app.post("/catchup", verifyWebhookSecret, async (req, res) => {
  try {
    const outreached = await searchContactsByTag("ai-outreach-sent");
    const results = [];

    for (const c of outreached) {
      const tags = (c.tags || []).map((t) => String(t).toLowerCase());

      // Already opted-out or conversation-ended — leave alone
      if (tags.includes("opted-out") || tags.includes("conversation-ended")) {
        results.push({ id: c.id, name: c.firstName, action: "skipped (already ended)" });
        continue;
      }

      const check = contactShouldBeSkipped(c);
      if (check.skip) {
        results.push({ id: c.id, name: c.firstName, action: `skipped (${check.reason})` });
        continue;
      }

      let msgs = [];
      let conversationId;
      try {
        const convo = await findConversationByContact(c.id);
        conversationId = convo?.id;
        if (conversationId) msgs = await getMessages(conversationId);
      } catch (e) {
        results.push({ id: c.id, error: e.message });
        continue;
      }

      if (msgs.length === 0) {
        results.push({ id: c.id, name: c.firstName, action: "no messages" });
        continue;
      }

      // GHL returns newest first — msgs[0] is the LAST message
      const last = msgs[0];
      if (last.direction !== "inbound") {
        results.push({ id: c.id, name: c.firstName, action: "already handled (last msg is Jordan's)" });
        continue;
      }

      const incomingText = String(last.body || last.text || "").trim();
      if (!incomingText) {
        results.push({ id: c.id, name: c.firstName, action: "empty last message" });
        continue;
      }

      // Handle STOP retroactively
      if (isOptOut(incomingText)) {
        await addTag(c.id, ["opted-out", "conversation-ended"]);
        results.push({ id: c.id, name: c.firstName, action: `opted-out (said "${incomingText}")` });
        continue;
      }

      // Have Jordan reply
      const history = [...msgs].reverse();
      try {
        const { text, isGoodbye, isHot } = await generateReply(history, incomingText);
        if (isGoodbye) {
          await addTag(c.id, ["conversation-ended"]);
          results.push({ id: c.id, name: c.firstName, action: "conversation ended (goodbye)" });
          continue;
        }
        if (isHot) {
          await addTag(c.id, ["hot-lead", "needs-human-followup"]);
        }
        await sendSMS(c.id, text);
        results.push({
          id: c.id,
          name: c.firstName,
          action: "replied",
          hot: isHot || false,
          reply_preview: text.slice(0, 100),
        });
      } catch (e) {
        results.push({ id: c.id, name: c.firstName, error: e.message });
      }

      // Small pause between sends
      await new Promise((r) => setTimeout(r, 1500));
    }

    const replied = results.filter((r) => r.action === "replied").length;
    const optedOut = results.filter((r) => String(r.action).startsWith("opted-out")).length;
    const hot = results.filter((r) => r.hot).length;

    res.json({
      total_checked: outreached.length,
      replied,
      opted_out_retroactively: optedOut,
      new_hot_leads: hot,
      results,
    });
  } catch (err) {
    console.error("Catchup error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
