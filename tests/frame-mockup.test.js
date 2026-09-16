/**
 * The frame drawn around a customer's proof must be the frame they are buying.
 *
 * This exists because the status page drew a black moulding roughly three times
 * too wide, and the width changed with the browser window: about 6% of the
 * artwork on a phone, 21% on a wide desktop. The declared value, 5.5%, was the
 * right number applied to the wrong box. A percentage padding resolves against
 * the CONTAINING BLOCK, never against the element carrying it, so the band was
 * sized from the status card rather than from the frame, and grew whenever the
 * card did.
 *
 * Nothing caught it because a proportion cannot be wrong in a way that throws.
 * It just quietly shows the customer a chunkier product than the one arriving.
 *
 * The real moulding is 0.875in of timber on a 14in-wide print, a fixed 6.25% of
 * the artwork at every screen size. The band therefore lives on .proof-moulding,
 * whose containing block IS .proof-framed.
 *
 *   node tests/frame-mockup.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * Both brands run this page, but they keep it in different places: one serves
 * public/ directly, the other builds public/ from site/. Read the SOURCE, never
 * the build artifact — in the built brand the suite runs before the site is
 * generated, so the artifact on disk is stale or absent.
 */
function readFirst(candidates, label) {
  for (const rel of candidates) {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) return { rel, text: fs.readFileSync(p, 'utf8') };
  }
  throw new Error(`could not find the ${label} source. Looked in: ${candidates.join(', ')}`);
}

const css = readFirst(
  ['site/pages/order-status.head.html', 'public/order-status.html'],
  'status page stylesheet'
);
const markup = readFirst(
  ['site/pages/order-status.html', 'public/order-status.html'],
  'status page markup'
);

// 0.875in of moulding against a 14in print.
const REAL_BAND_OF_ARTWORK = 0.875 / 14;
// band = p*W, artwork = W - 2p, so p/(W-2p) = 0.0625 gives p = 5.5556% of W.
const EXPECTED_PADDING = (REAL_BAND_OF_ARTWORK / (1 + 2 * REAL_BAND_OF_ARTWORK)) * 100;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

function ruleBody(text, selector) {
  const re = new RegExp(`(^|[\\s,])${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm');
  const m = text.match(re);
  return m ? m[2] : null;
}

console.log(`\nFrame mockup (css: ${css.rel}, markup: ${markup.rel}):`);

check('.proof-framed carries no percentage padding', () => {
  const body = ruleBody(css.text, '.proof-framed');
  assert.ok(body !== null, '.proof-framed rule is missing');
  const pad = body.match(/padding\s*:\s*([^;]+);/);
  if (pad && pad[1].includes('%')) {
    assert.fail(
      `padding: ${pad[1].trim()} on .proof-framed resolves against the status card, `
      + 'not the frame, so the moulding grows with the viewport. Put it on .proof-moulding.'
    );
  }
});

check('.proof-moulding sizes the band from the frame itself', () => {
  const body = ruleBody(css.text, '.proof-moulding');
  assert.ok(body !== null, '.proof-moulding rule is missing');
  const pad = body.match(/padding\s*:\s*([\d.]+)%/);
  assert.ok(pad, `.proof-moulding needs a percentage padding, got: ${body.trim()}`);
  const actual = parseFloat(pad[1]);
  assert.ok(
    Math.abs(actual - EXPECTED_PADDING) < 0.05,
    `padding is ${actual}%, which draws a ${(actual / (100 - 2 * actual) * 100).toFixed(2)}% `
    + `band around the artwork. The frame is 0.875in on a 14in print, so it must be `
    + `${REAL_BAND_OF_ARTWORK * 100}% of the artwork, i.e. padding ${EXPECTED_PADDING.toFixed(3)}%.`
  );
});

check('.proof-moulding is a block, so its padding applies on all four sides', () => {
  const body = ruleBody(css.text, '.proof-moulding');
  assert.ok(/display\s*:\s*block/.test(body), `.proof-moulding must be display:block, got: ${body.trim()}`);
});

check('no breakpoint redefines the band at some screen size', () => {
  // The whole failure was a frame that changed width with the viewport. A
  // media query resizing the moulding would reintroduce exactly that, and the
  // measurements above would still pass at the width they happened to run at.
  const blocks = css.text.match(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/gs) || [];
  const offenders = blocks
    .filter(b => /\.proof-(framed|moulding)\s*\{[^}]*padding/.test(b))
    .map(b => b.slice(0, b.indexOf('{')).trim());
  assert.deepStrictEqual(
    offenders, [],
    `these breakpoints change the frame's padding, so the moulding is not one `
    + `fixed proportion any more: ${offenders.join(' / ')}`
  );
});

check('the proof image is wrapped in the moulding', () => {
  assert.ok(
    /class=\\?"proof-moulding\\?"/.test(markup.text),
    'the rendered markup never opens a .proof-moulding element, so the rule cannot apply'
  );
  assert.ok(
    /proofImg \+ '<\/span><\/div>'/.test(markup.text),
    'the proof image is not closed inside the .proof-moulding wrapper'
  );
});

console.log(
  failures === 0
    ? '\nFrame mockup matches the frame being shipped.\n'
    : `\n${failures} frame mockup check(s) failed.\n`
);
process.exit(failures === 0 ? 0 : 1);
