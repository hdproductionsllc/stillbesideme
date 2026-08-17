/**
 * What size will the poem actually be, in points, on paper?
 *
 * The tribute renderer lays every piece out in a canonical 1000-unit box and
 * scales it, which is what makes the proof and the print the same picture. The
 * cost is that a font size inside the renderer has no physical meaning: the
 * same setting is ~15pt on an 8x10 and ~45pt on a 20x30. For a long time nothing
 * in the system could state the printed size, so nothing could protect it, and a
 * legibility warning was tuned against numbers that no longer applied once
 * printed mats were switched off and every panel got roughly 2.5x bigger.
 *
 * This runs the REAL renderer across every size, layout and poem length we
 * expect to see, and prints what comes off the press. Nothing here
 * re-implements the fitting.
 *
 *   node scripts/check-poem-legibility.js          # table
 *   node scripts/check-poem-legibility.js --strict # non-zero exit below floor
 */

const path = require('path');

process.env.UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'output', 'mockups');
process.env.OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, '..', 'output', 'mockups-work');

const {
  buildTributeSvg, loadTemplate, resolveColors, isLandscapeLayout,
  calculateLayout, POEM_MIN_PT,
} = require('../src/services/tributeRenderer');

const DPI = 300;
const SIZES = ['8x10', '11x14', '16x20', '20x30'];
const LAYOUTS = ['side-by-side', 'stacked'];

// Real library poems, so the lengths are the ones customers actually get
// rather than lengths invented to make the table look reassuring.
const POEMS = {
  'short (5 lines)': `The bowl is still in the corner.
I have not moved it.

Hands remember longer
than the rest of us do.`,

  'typical (9 lines)': `You knew the truck three streets away
and met it at the gate every single time.

One tennis ball, gone flat and grey,
was the finest thing you ever owned.
You carried it to bed like treasure.

Good boy on the long trail,
good boy at the door.
The ball's still on the porch.`,

  'long (18 lines)': `You knew the truck three streets away
and met it at the gate every single time,
tail going like it had its own weather.

One tennis ball, gone flat and grey,
was the finest thing you ever owned.
You carried it to bed like treasure
and left it where we would step on it.

Good boy on the long trail.
Good boy at the door.
Good boy in the small hours
when the house was dark and you checked on us.

Fourteen years is a long time
to be met at the door,
and no time at all.

The ball's still on the porch.
We couldn't bring ourselves to move it.`,
};

/** Printed point size of the poem for one size + layout + text. */
function measure(sizeLabel, layout, poemText, template) {
  const [a, b] = sizeLabel.split('x').map(Number);
  const landscape = isLandscapeLayout(layout);
  const totalW = (landscape ? b : a) * DPI;
  const totalH = (landscape ? a : b) * DPI;

  // Full-bleed is the shipped configuration: printedMat is false on the
  // template, so the tribute gets its share of the whole sheet, not a window
  // inside a printed border.
  const panels = calculateLayout(layout, totalW, totalH, null);

  const report = {};
  buildTributeSvg({
    width: panels.tribute.width,
    height: panels.tribute.height,
    colors: resolveColors(template, {}),
    tributeData: {
      name: 'Rusty',
      nickname: 'Rus',
      birthDate: '2009',
      passDate: '2022',
      familyName: 'the Delgado family',
      poemText,
      layout,
    },
    panelWidthIn: panels.tribute.width / DPI,
    report,
  });
  return report;
}

/**
 * The builder warns the customer, the renderer sets the type. When those two
 * disagree about what "too small" means, the warning goes quiet and the piece
 * ships anyway — which is exactly what happened when printed mats were turned
 * off and only one of the two numbers was updated. Assert they still agree.
 */
function checkThresholdDrift() {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'customizer.js'), 'utf8');
  const m = src.match(/POEM_COMFORT_PT\s*=\s*([\d.]+)/);
  if (!m) return `could not find POEM_COMFORT_PT in customizer.js`;
  const builder = Number(m[1]);
  if (builder !== POEM_MIN_PT) {
    return `builder warns below ${builder}pt but the renderer's floor is ${POEM_MIN_PT}pt — `
      + `orders between the two print too small and say nothing`;
  }
  return null;
}

const strict = process.argv.includes('--strict');
const template = loadTemplate('pet-tribute');
let worst = Infinity;
let below = 0;

console.log(`\nPrinted poem size. Floor is ${POEM_MIN_PT}pt.\n`);
for (const [label, poem] of Object.entries(POEMS)) {
  console.log(`  ${label}`);
  console.log(`    size     ${LAYOUTS.map((l) => l.padEnd(20)).join('')}`);
  for (const size of SIZES) {
    const cells = LAYOUTS.map((layout) => {
      const r = measure(size, layout, poem, template);
      if (r.poemPt === null || r.poemPt === undefined) return 'n/a'.padEnd(20);
      worst = Math.min(worst, r.poemPt);
      const short = r.poemPt < POEM_MIN_PT;
      if (short) below++;
      return ((r.poemPt.toFixed(1) + 'pt').padEnd(9) + (short ? 'TOO SMALL' : '')).padEnd(20);
    });
    console.log(`    ${size.padEnd(9)}${cells.join('')}`);
  }
  console.log('');
}

console.log(`  Smallest anywhere: ${worst.toFixed(1)}pt. ${below} case(s) below the ${POEM_MIN_PT}pt floor.`);

const drift = checkThresholdDrift();
console.log(drift
  ? `  THRESHOLD DRIFT: ${drift}\n`
  : `  Builder warns at the same ${POEM_MIN_PT}pt the renderer floors at.\n`);

// The floor is deliberately not a clamp: a tribute is never truncated and the
// customer may insist. So a case printing below it is not a build failure by
// itself — the failure is the builder failing to SAY so. Drift is fatal.
if (drift) {
  console.error('FAIL: the builder and the renderer disagree about what is too small.');
  process.exit(1);
}
if (strict && below > 0) {
  console.error(`FAIL (--strict): ${below} case(s) print below ${POEM_MIN_PT}pt.`);
  process.exit(1);
}
