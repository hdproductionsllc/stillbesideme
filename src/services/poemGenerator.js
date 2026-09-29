/**
 * poemGenerator.js – AI memorial poem/letter generation via Anthropic Claude API.
 *
 * Primary model: Claude Sonnet 5.5 (claude-sonnet-5-5). Chosen by a blind
 * side-by-side against Sonnet 5 on these prompts (Sept 2026): the owner
 * preferred its poem in 4 pairs of 5, at the same price and speed, about a
 * third of a cent per poem. Falls back to Haiku 4.5 on a refusal/error
 * (cheapest, still capable), and finally to a template-based stub when no API
 * key is configured, so the customizer never breaks regardless of environment.
 *
 * Every poem is checked before anyone sees it (findProblem below). The same
 * test caught Sonnet 5.5 writing half a poem, then "Wait, let me set that
 * right.", then the poem again, all in the text a customer reads. A poem that
 * fails the check is written again once, then handed to the fallback model.
 *
 * Supports pet tributes (poem OR first-person "letter from them" format)
 * and human memorials (Letter From Heaven).
 *
 * API notes (verified against the Claude API reference):
 * - Do NOT pass temperature/top_p/top_k on Sonnet 5.5 (non-default values = 400)
 * - Thinking cannot be switched off on Sonnet 5.5 (`disabled` = 400); depth is
 *   set by `effort`. 'medium' is the setting the blind test was judged at, so
 *   changing it means judging the poems again
 * - A model may return stop_reason 'refusal' with empty content — must check
 *   before reading content[0]
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-5-5';
const FALLBACK_MODEL = 'claude-haiku-4-5';
// Sonnet 5.5 thinks before it writes and the thinking shares this budget with
// the poem. At 1024 (on Sonnet 5) the thinking alone used it up and every
// request came back with stop_reason 'max_tokens' and no text, which pushed
// production onto the template stub. A poem is a few hundred tokens; this
// cap is only a ceiling.
const MAX_TOKENS = 8192;

// The most lines each prompt below asks for.
const ASKED_MAX_LINES = { poem: 12, letter: 14 };
// A poem may run a little long and still be a poem, and the print layout is
// proven out to 18 lines (scripts/check-poem-legibility.js). Past half as long
// again it is no longer a long poem, it is two drafts.
const LENGTH_TOLERANCE = 1.5;
// Tries per model before moving down the chain: the poem, and one rewrite.
const TRIES_PER_MODEL = 2;

// A model talking about its writing instead of writing. Kept narrow on
// purpose: "Let me tell you about the porch" is a fine line in a letter.
const REVISION_TALK = new RegExp([
  "\\blet me (?:set|fix|redo|rewrite|revise|correct|try) (?:that|this|it)\\b",
  "\\bhere(?:'s| is) (?:the|a|my|your) (?:poem|letter|revised|final)\\b",
  "\\b(?:revised|corrected|final) (?:version|draft)\\b",
].join('|'), 'i');

const SYSTEM_PROMPT = `You are a master elegist who writes brief, luminous memorial verse and letters. Your work is printed beside their photo in a framed archival print that will hang on a family's wall for decades, so every word must earn its place.

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
 * What is wrong with this text as something to print, or null if nothing is.
 *
 * Three signs that the model handed over its working instead of the poem:
 * it runs far past the length asked for, its opening line comes round again
 * before the end (it started over), or it talks about revising itself. None
 * of them judges whether the poem is good. That stays with the customer and
 * the review gate.
 *
 * @param {string} text
 * @param {'poem'|'letter'} format
 * @returns {string|null}
 */
function findProblem(text, format) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return 'empty';

  const ceiling = Math.round((ASKED_MAX_LINES[format] || ASKED_MAX_LINES.poem) * LENGTH_TOLERANCE);
  if (lines.length > ceiling) return `${lines.length} lines, the most allowed is ${ceiling}`;

  // Closing on the opening line is a device poets use. Meeting it again with
  // more poem still to come is a second draft.
  const again = lines.indexOf(lines[0], 1);
  if (again !== -1 && again !== lines.length - 1) return 'the opening line comes round again, so it started over';

  if (REVISION_TALK.test(text)) return 'it talks about revising itself';
  return null;
}

/**
 * The request for one model. Pure, so it can be inspected in tests.
 *
 * output_config.effort is a Sonnet feature. Haiku 4.5 rejects it with a 400
 * ("This model does not support the effort parameter"), which is how the
 * fallback used to fail in lockstep with the primary and land on the stub.
 */
function requestParams(model, prompt) {
  const params = {
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  };
  if (model === MODEL) {
    // A short poem doesn't need deep reasoning; medium effort keeps it quick
    // and inexpensive while still polished.
    params.output_config = { effort: 'medium' };
  }
  return params;
}

/**
 * Call one model and return the text, throwing on refusal or empty content.
 */
async function callModel(api, model, prompt) {
  const response = await api.messages.create(requestParams(model, prompt));

  // One line per call so the Railway log shows fallback rate and thinking cost.
  // A refusal names its category, so a pattern of them can be seen and acted on.
  const usage = response.usage || {};
  const category = response.stop_details && response.stop_details.category;
  console.log(
    `Poem generation (${model}): stop=${response.stop_reason}${category ? ` category=${category}` : ''} `
    + `input=${usage.input_tokens} output=${usage.output_tokens}`
  );

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
 * Model chain: Sonnet 5.5 → Haiku 4.5 → template stub. A poem that fails
 * findProblem is written again by the same model once before the chain moves
 * on; an error or a refusal moves on at once, since asking again would only
 * make the customer wait for the same answer. The generationId is tagged with
 * the model that actually produced the text (ai-sonnet / ai-haiku) so quality
 * and fallback rates are observable in the session history.
 *
 * @param {object} details  the customer's answers
 * @param {object} [api]    an Anthropic client; tests pass their own
 */
async function generate(details, api = getClient()) {
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

  const format = isHuman || isPetLetter ? 'letter' : 'poem';

  for (const model of [MODEL, FALLBACK_MODEL]) {
    for (let attempt = 1; attempt <= TRIES_PER_MODEL; attempt++) {
      let poem;
      try {
        poem = stripMarkdown(await callModel(api, model, prompt));
      } catch (err) {
        console.error(`Anthropic API error (${model}):`, err.message);
        break; // try the next model in the chain
      }

      const problem = findProblem(poem, format);
      if (!problem) {
        return {
          poem,
          generationId: `ai-${model === MODEL ? 'sonnet' : 'haiku'}-${Date.now()}`,
          stubbed: false,
        };
      }
      console.warn(`Poem rejected (${model}, try ${attempt} of ${TRIES_PER_MODEL}): ${problem}`);
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

module.exports = { generate, findProblem, requestParams, MODEL, FALLBACK_MODEL };
