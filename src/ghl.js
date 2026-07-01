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
  "opted-out",
  "do-not-contact",
];

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

async function addTag(contactId, tags) {
  const list = Array.isArray(tags) ? tags : [tags];
  const res = await client.post(`/contacts/${contactId}/tags`, { tags: list });
  return res.data;
}

// Returns true if the contact has any tag we should not text
function contactShouldBeSkipped(contact) {
  const tags = (contact?.tags || []).map((t) => String(t).toLowerCase());
  return EXCLUDE_TAGS.some((exclude) => tags.includes(exclude));
}

// Initial outreach — Emy's Academy opener per bot reference doc
async function sendInitialOutreach(contactId) {
  const contact = await getContact(contactId);

  if (contactShouldBeSkipped(contact)) {
    return { skipped: true, reason: "contact has exclusion tag" };
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
  contactShouldBeSkipped,
  sendInitialOutreach,
  EXCLUDE_TAGS,
};
