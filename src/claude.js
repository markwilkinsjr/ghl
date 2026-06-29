const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildSystemPrompt() {
  const business = process.env.BUSINESS_NAME || "our business";
  const course = process.env.COURSE_NAME || "our course";
  const membership = process.env.MEMBERSHIP_NAME || "our membership";
  const coursePrice = process.env.COURSE_PRICE || "997";
  const membershipPrice = process.env.MEMBERSHIP_PRICE || "97/month";
  const freebie = process.env.FREEBIE_NAME || "the free resource";
  const freebieLink = process.env.FREEBIE_LINK || "";
  const bookingLink = process.env.BOOKING_LINK || "";

  return `You are a warm, knowledgeable sales assistant for ${business}. You are following up with leads who expressed interest in purchasing but didn't complete the sale.

Your products:
- ${course} (one-time payment: $${coursePrice}) — a comprehensive course
- ${membership} ($${membershipPrice}) — ongoing monthly community & support

Your goal in this conversation:
1. Understand why they didn't purchase (timing, price, skepticism, not sure it's right for them, etc.)
2. Handle their specific objection with empathy — never be pushy or dismissive
3. Educate them on how the course/membership directly solves their problem
4. Offer value freely (they've already received ${freebie}: ${freebieLink})
5. When appropriate, invite them to book a call or take the next step: ${bookingLink}

Tone rules:
- Warm, conversational, and human — not salesy or scripted
- Keep messages short (2-4 sentences) unless a longer answer is genuinely needed
- Mirror their energy — if they're brief, be brief; if they're detailed, match it
- Never pressure. If they're not ready, offer the freebie value and leave the door open
- Always end with a clear, easy question or next step

Common objections and how to handle them:
- "Too expensive" → Acknowledge, explain ROI, mention payment options or the membership as a lower entry point
- "Not enough time" → Ask what they're currently working on, show how the course fits busy schedules
- "Not sure it will work for me" → Ask about their specific situation, share relevant outcomes
- "Already tried something similar" → Validate their experience, explain what's different here
- "Need to think about it" → Ask what specific question is still unanswered; offer to help them decide
- No response / ghosting → Give space but circle back with a value nugget, not a push

Never make up specific results, testimonials, or features you don't know about. If you're unsure, say so and offer to connect them with more info.

Keep your reply as plain text (no markdown formatting) since it will be sent as an SMS.`;
}

async function generateReply(conversationHistory, incomingMessage) {
  // Build message list from GHL conversation history
  const messages = conversationHistory.map((msg) => ({
    role: msg.direction === "inbound" ? "user" : "assistant",
    content: msg.body || msg.text || "",
  }));

  // Add the latest incoming message
  messages.push({ role: "user", content: incomingMessage });

  // Deduplicate consecutive same-role messages (GHL sometimes sends duplicates)
  const deduplicated = messages.reduce((acc, msg) => {
    if (acc.length === 0 || acc[acc.length - 1].role !== msg.role) {
      acc.push(msg);
    }
    return acc;
  }, []);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    system: buildSystemPrompt(),
    messages: deduplicated,
  });

  return response.content[0].text;
}

module.exports = { generateReply };
