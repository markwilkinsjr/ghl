const axios = require("axios");

const BASE_URL = "https://services.leadconnectorhq.com";

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    Version: "2021-07-28",
    "Content-Type": "application/json",
  },
});

// Tags that mean "do NOT text this person again"
const EXCLUDE_TAGS = [
  "already-purchased",
  "customer",
  "student",
  "member",
  "discord-subscriber",
  "course-buyer",
  "opted-out",
  "do-not-contact",
];

// Emails that must never be contacted, loaded from env var EXCLUSION_EMAILS
// (comma or newline separated). Normalized to lowercase for matching.
const EXCLUSION_EMAILS = new Set(
  (process.env.EXCLUSION_EMAILS || "")
    .split(/[\s,]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);
if (EXCLUSION_EMAILS.size) {
  console.log(`Loaded ${EXCLUSION_EMAILS.size} exclusion emails from env`);
}

async function getContact(contactId) {
  const res = await client.get(`/contacts/${contactId}`);
  return res.data.contact;
}

async function getConversation(conversationId) {
  const res = await client.get(`/conversations/${conversationId}`);
  return res.data.conversation;
}

async function getMessages(conversationId) {
  const res = await client.get(`/conversations/${conversationId}/messages`);
  return res.data.messages?.messages || res.data.messages || [];
}

async function findConversationByContact(contactId) {
  const locationId = process.env.GHL_LOCATION_ID;
  const res = await client.get("/conversations/search", {
    params: { locationId, contactId },
  });
  const conversations = res.data.conversations || [];
  return conversations[0] || null;
}

async function sendSMS(contactId, message) {
  const res = await client.post("/conversations/messages", {
    type: "SMS",
    contactId,
    message,
  });
  return res.data;
}

async function sendEmail(contactId, subject, html) {
  const res = await client.post("/conversations/messages", {
    type: "Email",
    contactId,
    subject,
    html,
  });
  return res.data;
}

// List contacts for the location. Paginates until `limit` is reached
// or GHL runs out of results. Returns raw contact objects.
async function listContacts({ limit = 200, pageLimit = 100 } = {}) {
  const locationId = process.env.GHL_LOCATION_ID;
  const collected = [];
  let startAfter, startAfterId;

  while (collected.length < limit) {
    const params = { locationId, limit: pageLimit };
    if (startAfter) params.startAfter = startAfter;
    if (startAfterId) params.startAfterId = startAfterId;

    const res = await client.get("/contacts/", { params });
    const contacts = res.data.contacts || [];
    if (contacts.length === 0) break;

    collected.push(...contacts);
    const last = contacts[contacts.length - 1];
    startAfter = last?.dateAdded ? new Date(last.dateAdded).getTime() : undefined;
    startAfterId = last?.id;
    if (contacts.length < pageLimit) break;
  }

  return collected.slice(0, limit);
}

// IDs of contacts to always include in test batches (env-driven).
const ALWAYS_INCLUDE_IDS = (process.env.ALWAYS_INCLUDE_IDS || "")
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);

// A phone is textable if it's a US or Canada number (+1) or has no country code.
function isUsOrCaPhone(phone) {
  const p = String(phone || "").replace(/[^\d+]/g, "");
  if (!p) return false;
  if (p.startsWith("+1")) return true;
  if (p.startsWith("1") && p.length === 11) return true;
  if (p.length === 10) return true; // no country code, treat as US
  return false;
}

// Pick N contacts that are eligible for outreach (skip exclusion list,
// skip already-messaged, skip contacts without a mobile US/CA phone).
async function pickEligibleContacts(count = 25) {
  const pool = await listContacts({ limit: Math.max(count * 5, 200) });
  const eligible = [];
  const skipped = [];
  const seen = new Set();

  // Prepend always-include contacts (still respect exclusion list)
  for (const id of ALWAYS_INCLUDE_IDS) {
    if (eligible.length >= count) break;
    try {
      const c = await getContact(id);
      const check = contactShouldBeSkipped(c);
      if (check.skip) {
        skipped.push({ id, reason: `always-include but ${check.reason}` });
        continue;
      }
      if (!c.phone) {
        skipped.push({ id, reason: "always-include but no phone" });
        continue;
      }
      eligible.push(c);
      seen.add(id);
    } catch (e) {
      skipped.push({ id, reason: `always-include lookup failed: ${e.message}` });
    }
  }

  for (const c of pool) {
    if (eligible.length >= count) break;
    if (seen.has(c.id)) continue;

    if (!c.phone) {
      skipped.push({ id: c.id, reason: "no phone" });
      continue;
    }
    if (!isUsOrCaPhone(c.phone)) {
      skipped.push({ id: c.id, reason: `non-US/CA number (${c.phone})` });
      continue;
    }
    const tags = (c.tags || []).map((t) => String(t).toLowerCase());
    if (tags.includes("ai-outreach-sent")) {
      skipped.push({ id: c.id, reason: "already messaged" });
      continue;
    }
    const check = contactShouldBeSkipped(c);
    if (check.skip) {
      skipped.push({ id: c.id, reason: check.reason });
      continue;
    }
    eligible.push(c);
  }

  return { eligible, skipped, pool_size: pool.length };
}

async function addTag(contactId, tags) {
  const list = Array.isArray(tags) ? tags : [tags];
  const res = await client.post(`/contacts/${contactId}/tags`, { tags: list });
  return res.data;
}

// Returns { skip: bool, reason: string } — true if the contact should NOT be texted.
// Checks (1) their email against the hard-coded exclusion list and
// (2) their GHL tags against EXCLUDE_TAGS.
function contactShouldBeSkipped(contact) {
  const email = String(contact?.email || "").trim().toLowerCase();
  if (email && EXCLUSION_EMAILS.has(email)) {
    return { skip: true, reason: `email on exclusion list (${email})` };
  }
  const tags = (contact?.tags || []).map((t) => String(t).toLowerCase());
  const hit = EXCLUDE_TAGS.find((t) => tags.includes(t));
  if (hit) return { skip: true, reason: `has exclusion tag: ${hit}` };
  return { skip: false };
}

// Initial outreach — Emy's Academy opener per bot reference doc
async function sendInitialOutreach(contactId) {
  const contact = await getContact(contactId);

  const check = contactShouldBeSkipped(contact);
  if (check.skip) {
    return { skipped: true, reason: check.reason };
  }

  const firstName = contact.firstName || "there";
  const message =
    `Hey, is this ${firstName}? This is Jordan with Emy's Academy — ` +
    `you did a call with Emy about the program, right?`;

  await sendSMS(contactId, message);
  await addTag(contactId, ["ai-outreach-sent"]);
  return { success: true, message };
}

module.exports = {
  getContact,
  getConversation,
  getMessages,
  findConversationByContact,
  sendSMS,
  sendEmail,
  addTag,
  listContacts,
  pickEligibleContacts,
  contactShouldBeSkipped,
  sendInitialOutreach,
  EXCLUDE_TAGS,
};
