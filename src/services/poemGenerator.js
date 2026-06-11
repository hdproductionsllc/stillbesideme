/**
 * poemGenerator.js – AI memorial poem/letter generation via Anthropic Claude API.
 *
 * Primary model: Claude Fable 5 (claude-fable-5) — best available creative
 * writing. Falls back to Sonnet 4.6 on a refusal/error, and finally to a
 * template-based stub when no API key is configured, so the customizer
 * never breaks regardless of environment.
 *
 * Supports pet tributes (poem OR first-person "letter from them" format)
 * and human memorials (Letter From Heaven).
 *
 * Fable 5 API notes (verified against the Claude API reference):
 * - Do NOT pass a `thinking` param (always-on; explicit config = 400)
 * - Do NOT pass temperature/top_p/top_k (400)
 * - New tokenizer ≈30% more tokens than Sonnet — hence MAX_TOKENS 1024
 * - May return stop_reason 'refusal' with empty content — must check
 *   before reading content[0]
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-fable-5';
const FALLBACK_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = `You are a master elegist who writes brief, luminous memorial verse and letters. Your work is UV-printed onto a framed tribute that will hang on a family's wall for decades, so every word must earn its place.

Your craft principles:
- Concrete detail over abstraction. One real remembered thing (a worn tennis ball, a spot of sun on the kitchen floor) moves people more than any general sentiment.
- Warmth over grief. Write about love and presence, never absence and darkness.
- Plain, timeless language. No clichés, no greeting-card phrasing, nothing that will feel dated in twenty years.
- Restraint. Shorter and truer beats longer and ornate.
- Never use em dashes. Never use markdown formatting of any kind.`;

let client = null;

function getClient() {
  if (client) return client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === 'sk-ant-placeholder') return null;
  client = new Anthropic({ apiKey: key });
  return client;
}

/**
 * Build the pet memorial poem prompt.
 */
function buildPrompt({ petName, petType, breed, nicknames, personality, favoriteMemory, favoriteThing }) {
  return `Write a memorial poem for a beloved pet. It will be printed beside their photo in a framed tribute.

Pet Details:
- Name: ${petName || 'their beloved companion'}
- Nicknames: ${nicknames || 'none provided'}
- Type: ${petType || 'pet'}
- Breed: ${breed || 'not specified'}
- What made them special: ${personality || 'not provided'}
- A favorite memory: ${favoriteMemory || 'not provided'}
- Their favorite toy or treat: ${favoriteThing || 'not provided'}

Write an 8-12 line poem with one stanza break that:
- References the pet by name at least once
- Weaves in at least one specific detail the owner shared, transformed into imagery (don't just restate it)
- Feels warm and comforting, about love and presence
- Does NOT use clichés like "rainbow bridge" or "angel wings" unless the owner specifically referenced them
- NEVER mentions death, dying, darkness, or anything morbid or unsettling
- Could make someone smile through tears

Return ONLY the poem text. No title, no attribution, no explanation.`;
}

/**
 * Build the pet "letter from them" prompt — first-person, in the pet's voice.
 */
function buildPetLetterPrompt({ petName, petType, breed, nicknames, personality, favoriteMemory, favoriteThing }) {
  return `Write a short letter FROM a beloved pet TO their family, in the pet's own voice. It will be printed beside their photo in a framed tribute.

About the pet writing this letter:
- Name: ${petName || 'their beloved companion'}
- Nicknames: ${nicknames || 'none provided'}
- Type: ${petType || 'pet'}
- Breed: ${breed || 'not specified'}
- What made them special: ${personality || 'not provided'}
- A favorite memory: ${favoriteMemory || 'not provided'}
- Their favorite toy or treat: ${favoriteThing || 'not provided'}

Write a 10-14 line first-person letter that:
- Is written FROM the pet TO their family (uses "I" and "you")
- Sounds like THIS pet: let their personality and quirks shape the voice (playful, dignified, mischievous, gentle)
- Opens with something true to their daily life together, then turns gently comforting
- Weaves in at least one specific detail shared above
- Conveys "I was so happy with you, I'm okay, and I'm still close by"
- NEVER mentions death, dying, darkness, or anything morbid or unsettling
- Could make someone smile through tears

Return ONLY the letter text. No title, no sign-off line like "Love, Max", no attribution, no explanation.`;
}

/**
 * Build the human memorial "Letter From Heaven" prompt.
 */
function buildHumanPrompt({ name, relationship, nickname, personality, favoriteMemory, favoriteSaying, legacy }) {
  return `Write a short letter from someone who has passed away, addressed to their loved ones. This is a "Letter From Heaven" – a first-person message from the deceased, as if they could write one last note to the people they love. It will be printed beside their photo in a framed tribute.

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
- NEVER mentions death, dying, darkness, or anything morbid or unsettling
- Does NOT use clichés like "pearly gates" or "streets of gold" unless the family referenced them
- Could make someone smile through tears

Return ONLY the letter text. No title, no "Love," sign-off, no attribution, no explanation.`;
}

/**
 * Strip any stray markdown formatting the model may have produced so it doesn't render on the print.
 */
function stripMarkdown(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

/**
 * Call one model and return the text, throwing on refusal or empty content.
 */
async function callModel(api, model, prompt) {
  const response = await api.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'high' },
    messages: [{ role: 'user', content: prompt }],
  });

  // Fable 5 safety classifiers can decline with stop_reason 'refusal' and an
  // empty content array. Its always-on thinking also means content[0] is a
  // thinking block — find the text block, never read content[0] directly.
  const textBlock = Array.isArray(response.content)
    ? response.content.find(b => b.type === 'text' && b.text)
    : null;

  if (response.stop_reason === 'refusal' || !textBlock) {
    const err = new Error(`Model ${model} declined or returned no text (stop_reason: ${response.stop_reason})`);
    err.refusal = true;
    throw err;
  }

  return textBlock.text.trim();
}

/**
 * Generate a poem/letter via the Anthropic API.
 *
 * Dispatch:
 *   category 'human'            → Letter From Heaven
 *   category 'pet' + format 'letter' → letter from the pet's voice
 *   else                        → pet poem
 *
 * Model chain: Fable 5 → Sonnet 4.6 → template stub. The generationId is
 * tagged with the model that actually produced the text (ai-fable / ai-sonnet)
 * so quality and fallback rates are observable in the session history.
 */
async function generate(details) {
  const api = getClient();
  const isHuman = details.category === 'human';
  const isPetLetter = !isHuman && details.format === 'letter';

  const stub = () => {
    if (isHuman) return generateHumanStub(details);
    if (isPetLetter) return generatePetLetterStub(details);
    return generateStub(details);
  };

  if (!api) return stub();

  const prompt = isHuman ? buildHumanPrompt(details)
    : isPetLetter ? buildPetLetterPrompt(details)
    : buildPrompt(details);

  for (const model of [MODEL, FALLBACK_MODEL]) {
    try {
      const text = await callModel(api, model, prompt);
      return {
        poem: stripMarkdown(text),
        generationId: `ai-${model === MODEL ? 'fable' : 'sonnet'}-${Date.now()}`,
        stubbed: false,
      };
    } catch (err) {
      console.error(`Anthropic API error (${model}):`, err.message);
      // try the next model in the chain
    }
  }

  return stub();
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
 * Template-based fallback letter in the pet's voice.
 */
function generatePetLetterStub({ petName, petType, favoriteMemory, favoriteThing }) {
  const name = petName || 'Me';
  const type = (petType || 'friend').toLowerCase();

  const memoryLine = favoriteMemory
    ? `\nRemember ${favoriteMemory.toLowerCase().startsWith('the ') || favoriteMemory.toLowerCase().startsWith('when ') ? favoriteMemory.charAt(0).toLowerCase() + favoriteMemory.slice(1) : 'the time ' + favoriteMemory.charAt(0).toLowerCase() + favoriteMemory.slice(1)}?\nThat was one of my favorite days too.`
    : '';

  const toyLine = favoriteThing
    ? `\nLook after my ${favoriteThing.toLowerCase()} for me. It was always my favorite.`
    : '';

  const poem = `Hello, my family.

It's me. I just wanted you to know
that being your ${type} was the best thing
I ever got to be.

Every walk, every nap in the sun,
every time you came through the door,
my whole world lit up.${memoryLine}${toyLine}

Don't be sad when you think of me.
Think of me the way I always was:
right beside you, happy,
exactly where I belonged.

I'm still there. I always will be.`;

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
