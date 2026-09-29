/**
 * The poem writer: which model it asks, and what it refuses to show anyone.
 *
 * The poem is the product, and the customer reads it in the designer before
 * any person at the shop has seen it. So three things are proven here, with
 * no network and no API credit spent:
 *
 *   1. The request is one Claude Sonnet 5.5 accepts, and the fallback's is one
 *      Haiku 4.5 accepts (it rejects the effort setting).
 *   2. findProblem catches a model handing over its working instead of the
 *      poem, using the real output that did exactly that in the Sept 2026
 *      blind test, and leaves real poems alone.
 *   3. A rejected poem is written again once, then passed down the chain; an
 *      outage or a refusal goes down the chain at once; and whatever happens
 *      the customer gets something to read.
 *
 *   node tests/poem-generator.test.js
 */

const assert = require('assert');
const poemGenerator = require('../src/services/poemGenerator');

const { findProblem, requestParams, generate, MODEL, FALLBACK_MODEL } = poemGenerator;

// What Claude Sonnet 5.5 really returned for one customer in the blind test.
const STARTED_OVER = `Mabel, Supervisor, keeper of the hours,
you sat on the keys until the bowl was full,
and every gray-striped morning the screen agreed
that nothing mattered more than your small rule.

At half past five the window held your shape,
a patient shadow watching for the car.
The whole street learned the time by how you waited.
The whole house learned how near a heart can are.

Wait, let me set that right.

Mabel, Supervisor, keeper of the hours,
you sat on the keys until the bowl was full,
and every gray-striped morning the screen agreed
that nothing mattered more than your soft rule.

At half past five the window held your shape,
a patient shadow watching for the car.
Each night you rose and fell on one warm chest,
a slow tide keeping time with who we are.

Somewhere a bouquet crinkles in its paper,
and you come pouncing, bossy, glad, and near.
The house still keeps the shape of your attention.
Good work, Mabes. We are all still here.`;

// Two poems from the same test that were fine, the second one long.
const GOOD = `Biscuit met the door with a shoe in his mouth,
carried like a gift, never chewed,
one loafer or sneaker held high and proud
as if to say, look who I found for you.

Everyone who came was the best news he'd heard.
Mister B had no other kind of welcome.

Now the lake keeps its long gold evening,
and somewhere a dog stays in the shallows
until the very last light,
too happy to be called in,
an orange ball bobbing soft beside him.
Bisky, we still leave the door open for you.`;

const GOOD_AND_LONG = `Thirteen years of orange fur
folded into one small bed,
Ollie keeping watch each night
above a boy's sleeping head.

He grew from six to nineteen,
came home to a bed still warm,
still shaped like the cat who chose him
before he knew what love was for.

One ornament, then another,
Ollie's eyes on us the whole time,
daring the tree to mean more
than a cat who wanted to play.

Somewhere a hair tie waits
on the floor for a paw
that knew exactly how to be loved,
and exactly who to love back.`;

const linesOf = (n) => Array.from({ length: n }, (_, i) => `Line number ${i + 1} of the poem`).join('\n');

/** A stand-in for the Anthropic client that answers from a script, in order. */
function scriptedApi(script) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        const next = script.shift();
        if (!next) throw new Error('the test script ran out of answers');
        if (next.throws) throw new Error(next.throws);
        if (next.refusal) {
          return { stop_reason: 'refusal', stop_details: { category: next.refusal }, content: [], usage: {} };
        }
        return {
          stop_reason: 'end_turn',
          // Thinking comes first and is empty, as it is on the real model.
          content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: next.text }],
          usage: { input_tokens: 400, output_tokens: 200 },
        };
      },
    },
  };
}

(async () => {
  // Keep the run quiet; the log lines are not what is under test.
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};

  // ── 1. The requests ──────────────────────────────────────────────────
  assert.strictEqual(MODEL, 'claude-sonnet-5-5');
  const primary = requestParams(MODEL, 'write');
  assert.deepStrictEqual(primary.output_config, { effort: 'medium' }, 'the setting the blind test was judged at');
  assert.ok(primary.max_tokens >= 4096, 'room for thinking as well as the poem');
  for (const refused of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice']) {
    assert.ok(!(refused in primary), `${refused} is not sent to Sonnet 5.5`);
  }
  assert.strictEqual(primary.messages[primary.messages.length - 1].role, 'user', 'no assistant prefill');
  assert.ok(!('output_config' in requestParams(FALLBACK_MODEL, 'write')), 'Haiku 4.5 rejects effort');

  // ── 2. What is refused, and what is not ──────────────────────────────
  assert.ok(findProblem(STARTED_OVER, 'poem'), 'the real started-over poem is refused');
  assert.ok(
    /started over/.test(findProblem(STARTED_OVER.split('\n').slice(0, 16).join('\n'), 'poem')),
    'a restart is caught by its repeated opening even when the text is short enough'
  );
  assert.ok(/revising/.test(findProblem('A line.\nWait, let me set that right.\nAnother line.', 'poem')));
  assert.ok(findProblem("Here is the poem you asked for:\nA line.\nAnother.", 'poem'));
  assert.ok(findProblem('', 'poem'));

  assert.strictEqual(findProblem(GOOD, 'poem'), null);
  assert.strictEqual(findProblem(GOOD_AND_LONG, 'poem'), null, 'a poem that runs long is still a poem');
  assert.strictEqual(findProblem(linesOf(18), 'poem'), null, 'the layout is proven to 18 lines');
  assert.ok(findProblem(linesOf(19), 'poem'));
  assert.strictEqual(findProblem(linesOf(21), 'letter'), null, 'letters are asked for longer');
  assert.ok(findProblem(linesOf(22), 'letter'));
  assert.strictEqual(
    findProblem('Good boy, Duke.\nYou met every door like good news.\nGood boy, Duke.', 'poem'), null,
    'closing on the opening line is a poem, not a restart'
  );
  assert.strictEqual(
    findProblem('Hello, my family.\nLet me tell you about the porch.\nWait for me by the window.', 'letter'), null,
    'ordinary words are not mistaken for revision talk'
  );

  // ── 3. The chain ─────────────────────────────────────────────────────
  const pet = { petName: 'Mabel', petType: 'Cat' };

  let api = scriptedApi([{ text: GOOD }]);
  let out = await generate(pet, api);
  assert.strictEqual(out.poem, GOOD);
  assert.strictEqual(out.stubbed, false);
  assert.ok(out.generationId.startsWith('ai-sonnet-'));
  assert.strictEqual(api.calls.length, 1, 'a good poem costs one request');
  assert.strictEqual(api.calls[0].model, MODEL);

  api = scriptedApi([{ text: STARTED_OVER }, { text: GOOD }]);
  out = await generate(pet, api);
  assert.strictEqual(out.poem, GOOD, 'the customer never sees the rejected one');
  assert.deepStrictEqual(api.calls.map(c => c.model), [MODEL, MODEL], 'written again by the same model');
  assert.ok(out.generationId.startsWith('ai-sonnet-'));

  api = scriptedApi([{ text: STARTED_OVER }, { text: STARTED_OVER }, { text: GOOD }]);
  out = await generate(pet, api);
  assert.strictEqual(out.poem, GOOD);
  assert.deepStrictEqual(api.calls.map(c => c.model), [MODEL, MODEL, FALLBACK_MODEL], 'two failures, then the fallback');
  assert.ok(out.generationId.startsWith('ai-haiku-'));

  api = scriptedApi([{ throws: '529 overloaded' }, { text: GOOD }]);
  out = await generate(pet, api);
  assert.deepStrictEqual(api.calls.map(c => c.model), [MODEL, FALLBACK_MODEL], 'an outage is not asked twice');
  assert.strictEqual(out.poem, GOOD);

  api = scriptedApi([{ refusal: 'general_harms' }, { text: GOOD }]);
  out = await generate(pet, api);
  assert.deepStrictEqual(api.calls.map(c => c.model), [MODEL, FALLBACK_MODEL], 'a refusal is not asked twice');
  assert.strictEqual(out.poem, GOOD);

  api = scriptedApi([{ text: STARTED_OVER }, { text: STARTED_OVER }, { text: STARTED_OVER }, { text: STARTED_OVER }]);
  out = await generate(pet, api);
  assert.strictEqual(api.calls.length, 4, 'two tries on each model and no more');
  assert.strictEqual(out.stubbed, true, 'and the customer still gets something to read');
  assert.ok(out.poem.includes('Mabel'));

  // A letter is judged against the letter's length, not the poem's.
  api = scriptedApi([{ text: linesOf(20) }]);
  out = await generate({ petName: 'Mabel', format: 'letter' }, api);
  assert.strictEqual(api.calls.length, 1);
  assert.strictEqual(out.stubbed, false);

  // No key configured: the template, and no request at all.
  out = await generate(pet, null);
  assert.strictEqual(out.stubbed, true);

  Object.assign(console, quiet);
  console.log('poem-generator: all assertions passed');
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
