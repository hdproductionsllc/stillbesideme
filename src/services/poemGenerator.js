/**
 * poemGenerator.js — AI memorial poem generation via Anthropic Claude API.
 *
 * Falls back gracefully to a template-based poem when no API key is configured,
 * so the customizer never breaks regardless of environment.
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 300;

let client = null;

function getClient() {
  if (client) return client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === 'sk-ant-placeholder') return null;
  client = new Anthropic({ apiKey: key });
  return client;
}

/**
 * Build the prompt from the spec — this is the exact prompt from Section 7.
 */
function buildPrompt({ petName, petType, breed, nicknames, personality, favoriteMemory }) {
  return `You are writing a short memorial poem for a beloved pet who has passed away. This poem will be printed on a beautiful wall art canvas that will hang in the owner's home for years.

Pet Details:
- Name: ${petName || 'their beloved companion'}
- Nicknames: ${nicknames || 'none provided'}
- Type: ${petType || 'pet'}
- Breed: ${breed || 'not specified'}
- What made them special: ${personality || 'not provided'}
- A favorite memory: ${favoriteMemory || 'not provided'}

Write a 6-8 line poem that:
- References the pet by name at least once
- Incorporates at least one specific detail the owner shared
- Feels warm and comforting — about love and presence, not just grief
- Is personal and unique, never generic
- Is appropriate for permanent display as wall art (timeless, dignified)
- Does NOT use clichés like "rainbow bridge" or "angel wings" unless the owner specifically referenced them
- Has natural line breaks suitable for display on a memorial canvas
- Could make someone smile through tears

Return ONLY the poem text. No title, no attribution, no explanation.`;
}

/**
 * Generate a poem via the Anthropic API.
 * Returns { poem, generationId, stubbed: false } on success.
 * Falls back to stub if no API key or on error.
 */
async function generate(details) {
  const api = getClient();

  if (!api) {
    return generateStub(details);
  }

  try {
    const response = await api.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'user', content: buildPrompt(details) }
      ]
    });

    const poem = response.content[0].text.trim();

    return {
      poem,
      generationId: `ai-${Date.now()}`,
      stubbed: false
    };
  } catch (err) {
    console.error('Anthropic API error:', err.message);
    // Graceful fallback — never leave the customer hanging
    return generateStub(details);
  }
}

/**
 * Template-based fallback poem (the original stub, kept as safety net).
 */
function generateStub({ petName, petType, personality, favoriteMemory, favoriteThing }) {
  const name = petName || 'your beloved companion';
  const type = (petType || 'friend').toLowerCase();

  const personalLine = personality
    ? `${personality.split('.')[0]}.\nThat was your gift to us.`
    : 'Your gentle spirit touched everyone you met.\nThat was your gift to us.';

  const memoryLine = favoriteMemory
    ? `\nWe still remember ${favoriteMemory.toLowerCase().startsWith('the ') || favoriteMemory.toLowerCase().startsWith('when ') ? favoriteMemory.charAt(0).toLowerCase() + favoriteMemory.slice(1) : 'the way ' + favoriteMemory.charAt(0).toLowerCase() + favoriteMemory.slice(1)}.`
    : '';

  const toyLine = favoriteThing
    ? `\nAnd that ${favoriteThing.toLowerCase()} — it will always make us smile.`
    : '';

  const poem = `Dear ${name},

You were never just a ${type} —
you were the warmth in every room,
the joy in every morning,
the comfort in every quiet moment.

${personalLine}${memoryLine}${toyLine}

Now when the sunlight falls
through the window where you used to sleep,
we feel you there, still beside us,
still loved, still ours.

${name}, you are not gone.
You are woven into everything beautiful
we will ever know.`;

  return {
    poem,
    generationId: `stub-${Date.now()}`,
    stubbed: true
  };
}

module.exports = { generate };
