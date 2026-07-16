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
function buildPrompt({ relationship, name, context }) {
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

// ── Gift Note ────────────────────────────────────────────────────────
//
// A different job from the sympathy cards above, and deliberately a separate
// prompt rather than a `tone` flag on the same one. The card tool hands someone
// three options to copy out; this hands a buyer ONE draft they will edit in
// place and sign. That edit-and-approve step is the point — it is what makes
// the finished note theirs rather than ours, the same way nobody says Hallmark
// wrote their sympathy card. So the draft is deliberately plain and slightly
// under-written: it should read like a starting point the sender improves, not
// a polished artifact they feel unable to touch.

function buildGiftNotePrompt({ petName, recipientName, senderName, petType, memory }) {
  return `Write ONE short note from a person to a grieving friend. It will be printed on paper and enclosed with a framed memorial tribute of the friend's pet that died.

Details:
- Grieving friend's name: ${recipientName || 'unknown'}
- The pet who died: ${petName || 'their pet'}${petType ? ` (${petType})` : ''}
- Something the sender knows about the pet: ${memory || 'nothing specific provided'}
- The note is from: ${senderName || 'the sender'}

Rules:
- Write in the SENDER's voice, speaking directly to their friend. First person.
- 2 to 4 sentences. Under 60 words.
- Plain, warm, spoken language. What one friend actually says to another.
- Name the pet if you know it.
- Do NOT sign it — the name is added separately.
- Do NOT speak as the pet, and do NOT describe the gift or the frame.
- Never use "they're in a better place", "everything happens for a reason", "sorry for your loss", or "my deepest condolences".
- Never use em dashes.

Return ONLY the note text. No quotes, no labels, no explanation.`;
}

function giftNoteStub({ petName, recipientName }) {
  const who = recipientName || 'Hey';
  const pet = petName || 'them';
  return `${who}, I've been thinking about you so much this week. I know what ${pet} meant to you, and I wanted you to have something that lasts. I'm here whenever you need me.`;
}

/**
 * Generate a single editable gift-note draft.
 * @returns {{ draft: string, generationId: string, stubbed: boolean }}
 */
async function generateGiftNote(details) {
  const api = getClient();
  if (!api) {
    return { draft: giftNoteStub(details), generationId: `stub-${Date.now()}`, stubbed: true };
  }

  try {
    const response = await api.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: buildGiftNotePrompt(details) }],
    });

    const draft = response.content[0].text.trim().replace(/^["']|["']$/g, '');
    if (!draft) {
      return { draft: giftNoteStub(details), generationId: `stub-${Date.now()}`, stubbed: true };
    }

    return { draft, generationId: `ai-${Date.now()}`, stubbed: false };
  } catch (err) {
    console.error('Gift note generation API error:', err.message);
    return { draft: giftNoteStub(details), generationId: `stub-${Date.now()}`, stubbed: true };
  }
}

module.exports = { generate, generateGiftNote };
