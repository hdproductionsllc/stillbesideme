/**
 * poemGenerator.js – AI memorial poem/letter generation via Anthropic Claude API.
 *
 * Supports both pet tributes and human memorials (Letter From Heaven).
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
 * Build the pet memorial prompt.
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
- Feels warm and comforting – about love and presence, not just grief
- Is personal and unique, never generic
- Is appropriate for permanent display as wall art (timeless, dignified)
- Does NOT use clichés like "rainbow bridge" or "angel wings" unless the owner specifically referenced them
- NEVER mentions death, dying, the devil, hell, darkness, morbid imagery, or anything unsettling. This is about love and presence, not loss and darkness
- Keeps the tone warm, hopeful, and life-affirming. Focus on what the pet brought to the family, not on the absence
- Has natural line breaks suitable for display on a memorial canvas
- Could make someone smile through tears
- Never uses em dashes

Return ONLY the poem text. No title, no attribution, no explanation.`;
}

/**
 * Build the human memorial "Letter From Heaven" prompt.
 */
function buildHumanPrompt({ name, relationship, nickname, personality, favoriteMemory, favoriteSaying, legacy }) {
  return `You are writing a short letter from someone who has passed away, addressed to their loved ones. This is a "Letter From Heaven" – a first-person message from the deceased, as if they could write one last note to the people they love. It will be printed on a beautiful wall art canvas that will hang in someone's home for years.

About the person writing this letter:
- Name: ${name || 'your loved one'}
- They were: ${relationship || 'a beloved family member'}
- Nickname/what family called them: ${nickname || 'none provided'}
- What made them who they were: ${personality || 'not provided'}
- A memory that captures them: ${favoriteMemory || 'not provided'}
- Something they always said: ${favoriteSaying || 'not provided'}
- What they taught their family: ${legacy || 'not provided'}

Write a 10-14 line first-person letter that:
- Is written FROM the deceased TO their loved ones (uses "I" and "you")
- References their name or role (${relationship || 'loved one'}) naturally
- Weaves in at least one specific detail shared above (a saying, a memory, a personality trait)
- Feels warm, reassuring, and loving – as if they're comforting the reader from beyond
- Conveys "I'm okay, I'm still with you, don't be sad"
- Is personal and unique, never generic
- Is appropriate for permanent display as wall art (timeless, dignified)
- NEVER mentions death, dying, the devil, hell, darkness, morbid imagery, or anything unsettling
- Does NOT use clichés like "pearly gates" or "streets of gold" unless the family referenced them
- Keeps the tone warm, hopeful, and life-affirming
- Has natural line breaks suitable for display on a memorial canvas
- Could make someone smile through tears
- Never uses em dashes

Return ONLY the letter text. No title, no "Love," sign-off, no attribution, no explanation.`;
}

/**
 * Generate a poem/letter via the Anthropic API.
 * Dispatches by category: 'human' → Letter From Heaven, else → pet poem.
 * Returns { poem, generationId, stubbed: false } on success.
 * Falls back to stub if no API key or on error.
 */
async function generate(details) {
  const api = getClient();
  const isHuman = details.category === 'human';

  if (!api) {
    return isHuman ? generateHumanStub(details) : generateStub(details);
  }

  try {
    const prompt = isHuman ? buildHumanPrompt(details) : buildPrompt(details);

    const response = await api.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'user', content: prompt }
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
    return isHuman ? generateHumanStub(details) : generateStub(details);
  }
}

/**
 * Template-based fallback poem for pets.
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
    ? `\nAnd that ${favoriteThing.toLowerCase()} – it will always make us smile.`
    : '';

  const poem = `Dear ${name},

You were never just a ${type} –
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

/**
 * Template-based fallback letter for human memorials.
 */
function generateHumanStub({ name, relationship, personality, favoriteMemory, favoriteSaying }) {
  const displayName = name || 'your loved one';
  const role = relationship || 'someone who loved you';

  const personalLine = personality
    ? `You know me – ${personality.split('.')[0].toLowerCase()}.`
    : 'You know who I was, and that will never change.';

  const memoryLine = favoriteMemory
    ? `\nRemember ${favoriteMemory.toLowerCase().startsWith('the ') || favoriteMemory.toLowerCase().startsWith('when ') ? favoriteMemory.charAt(0).toLowerCase() + favoriteMemory.slice(1) : 'the time ' + favoriteMemory.charAt(0).toLowerCase() + favoriteMemory.slice(1)}?\nHold onto that. That was us at our best.`
    : '';

  const sayingLine = favoriteSaying
    ? `\nAnd remember what I always told you:\n"${favoriteSaying}"`
    : '';

  const poem = `My dear ones,

If you're reading this, I want you to know
I'm okay. I'm at peace.
And I'm still right here beside you.

${personalLine}
That never goes away.${memoryLine}${sayingLine}

Don't spend your days missing me.
Spend them the way I'd want you to:
laughing, loving, living fully.

Every sunrise, every quiet moment,
every time you feel a warmth you can't explain,
that's me, still beside you,
still loving you, always.`;

  return {
    poem,
    generationId: `stub-${Date.now()}`,
    stubbed: true
  };
}

module.exports = { generate };
