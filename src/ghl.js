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
  // GHL nests messages under data.messages.messages on this endpoint
  return res.data.messages?.messages || res.data.messages || [];
}

// Find the most recent conversation for a contact (needed because GHL workflow
// webhooks don't always include a conversationId)
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

// Trigger the initial outreach for a contact who expressed interest but didn't buy
async function sendInitialOutreach(contactId) {
  const contact = await getContact(contactId);
  const firstName = contact.firstName || "there";

  const freebie = process.env.FREEBIE_NAME;
  const freebieLink = process.env.FREEBIE_LINK;
  const courseName = process.env.COURSE_NAME || "our course";

  // Include the freebie line only if both name and link are configured
  const freebieLine =
    freebie && freebieLink
      ? `No worries at all — I'd love to send you ${freebie} completely free: ${freebieLink}\n\n`
      : `No worries at all — I'd still love to help you out.\n\n`;

  const message =
    `Hey ${firstName}! I noticed you checked out ${courseName} but didn't grab a spot. ` +
    freebieLine +
    `Quick question though — what held you back? Was it timing, price, or something else? ` +
    `I want to make sure I can help you out. 😊`;

  return await sendSMS(contactId, message);
}

module.exports = {
  getContact,
  getConversation,
  getMessages,
  findConversationByContact,
  sendSMS,
  sendEmail,
  sendInitialOutreach,
};
