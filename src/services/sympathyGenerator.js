/**
 * sympathyGenerator.js – AI sympathy message generation via Anthropic Claude API.
 *
 * Uses Haiku (cheap model) to generate short sympathy messages.
 * Falls back to template-based messages when no API key is configured.
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 150;

let client = null;

function getClient() {
  if (client) return client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === 'sk-ant-placeholder') return null;
  client = new Anthropic({ apiKey: key });
  return client;
}

/**
 * Build the sympathy message prompt.
 */
function buildPrompt({ relationship, name, context, tone }) {
  return `You are writing 3 short sympathy messages for someone who has lost a loved one. These will be used in a card, text, or note.

Details:
- Recipient's name: ${name || 'the recipient'}
- Who they lost: ${relationship || 'a loved one'}
- Additional context: ${context || 'none provided'}

Write exactly 3 sympathy messages, separated by "---" on its own line:

1. FORMAL: Professional and respectful (2-3 sentences)
2. WARM: Heartfelt and caring (2-3 sentences)
3. PERSONAL: Intimate and specific, referencing the context if provided (2-3 sentences)

Rules:
- Address the recipient by name if provided
- Reference the specific loss naturally (not "your loss" generically)
- Be genuine, never clichéd
- Do NOT use phrases like "they're in a better place" or "everything happens for a reason"
- Keep each message under 50 words
- Never use em dashes

Return ONLY the 3 messages separated by "---". No labels, no numbering, no explanation.`;
}

/**
 * Parse the API response into 3 separate messages.
 */
function parseMessages(text) {
  const parts = text.split(/\n---\n|\n-{3,}\n/).map(s => s.trim()).filter(Boolean);
  if (parts.length >= 3) return parts.slice(0, 3);
  if (parts.length === 2) return [...parts, parts[1]];
  if (parts.length === 1) return [parts[0], parts[0], parts[0]];
  return null;
}

/**
 * Generate sympathy messages via the Anthropic API.
 */
async function generate(details) {
  const api = getClient();

  if (!api) {
    return generateStub(details);
  }

  try {
    const prompt = buildPrompt(details);
    const response = await api.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0].text.trim();
    const messages = parseMessages(text);

    if (!messages) {
      return generateStub(details);
    }

    return {
      messages,
      generationId: `ai-${Date.now()}`,
      stubbed: false
    };
  } catch (err) {
    console.error('Sympathy generation API error:', err.message);
    return generateStub(details);
  }
}

/**
 * Template-based fallback messages.
 */
function generateStub({ relationship, name, context }) {
  const recipientName = name || 'friend';
  const lostPerson = relationship || 'loved one';

  const formal = `Dear ${recipientName}, I was deeply saddened to hear about the loss of your ${lostPerson}. Please know that you and your family are in my thoughts during this difficult time. With heartfelt sympathy.`;

  const warm = `${recipientName}, I am so sorry about your ${lostPerson}. There are no perfect words for a time like this, but I want you to know that I care about you and I am here for whatever you need.`;

  const personal = context
    ? `${recipientName}, hearing about your ${lostPerson} broke my heart. ${context.charAt(0).toUpperCase() + context.slice(1)} is something I will always remember about them. You are not alone in this.`
    : `${recipientName}, I keep thinking about your ${lostPerson} and the love you shared. That kind of bond doesn't disappear. I am here for you, whenever you need me.`;

  return {
    messages: [formal, warm, personal],
    generationId: `stub-${Date.now()}`,
    stubbed: true
  };
}

module.exports = { generate };
