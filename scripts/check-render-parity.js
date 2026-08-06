/**
 * Render parity check — run this before shipping anything that touches the
 * artwork. `npm run check-render`
 *
 * WHAT IT IS FOR
 * The customer approves the PROOF and we print the PRINT FILE. They come from
 * the same renderer at very different pixel sizes (~1000px against 300 DPI), and
 * twice now that has silently produced two different pictures: once as the poem
 * shrinking to ~17% of the name in portrait, and once as a long poem setting 14
 * lines on the proof and 28 on the print. Both shipped because nothing checked.
 *
 * So this draws the tribute panel 48 ways — every layout, four poem lengths,
 * portrait and landscape — at BOTH sizes, and fails if the two ever disagree on
 * the line breaks or the font size. It needs no test framework and no network:
 * it calls the real renderer and reads back the SVG it produces.
 *
 * Exit code 0 = clean, 1 = a difference the customer would see.
 */
const path = require('path');
const tr = require(path.join(__dirname, '..', 'src', 'services', 'tributeRenderer.js'));

const COLORS = {
  background: '#f5f0e6', name: '#2b2b2b', dates: '#5a5a5a', divider: '#8a7a5a',
  poem: '#3a3a3a', nickname: '#5a5a5a', family: '#5a5a5a',
};

// Short through pathological. The long ones matter most: that is where the
// renderer has to shrink to fit, and shrinking is where the two scales drifted.
const POEMS = {
  short: 'You were the quiet in every room.\nNow the rooms are loud.',
  typical: 'You met me at the door each day,\nas if I had been gone for years.\n'
    + "You never once asked where I'd been,\nyou only ever asked me to stay.\n\n"
    + 'Now the door swings on a quiet hall,\nand still I look for you.',
  long: 'There is a shape in the morning light\nwhere your body used to lie,\n'
    + 'and I have not yet learned the trick\nof walking past without a sigh.\n\n'
    + 'You carried joy the way a river\ncarries light across a stone,\n'
    + 'effortless and never asking\nwhether it was seen or known.\n\n'
    + 'So I will keep the door ajar\nand leave the hallway light on low,\n'
    + 'in case the quiet in the morning\nis just you, moving soft and slow.',
  extreme: Array.from({ length: 14 }, (_, i) =>
    `Line ${i + 1}: the long slow business of remembering you in the ordinary hours,`).join('\n'),
};

const CHROME = ['Roger', '2011 – 2026', '“Rodge”', 'Forever loved by the Hamilton family'];

const data = (poemText) => ({
  name: 'Roger', nickname: 'Rodge', birthDate: '2011', passDate: '2026',
  poemText, familyName: 'the Hamilton family', familyPrefix: 'Forever loved by',
});

// Read the drawn poem back out of the SVG. Chrome (name/dates/nickname/family)
// is excluded by content, not by font size — the dates can share the poem's size.
function readPoem(svgBuf) {
  const svg = svgBuf.toString();
  const texts = [...svg.matchAll(/<text[^>]*font-size="(\d+)"[^>]*>([^<]*)<\/text>/g)]
    .map((m) => ({ size: Number(m[1]), text: m[2] }))
    .filter((t) => !CHROME.some((c) => t.text.trim() === c.trim()));
  if (!texts.length) return { size: 0, lines: [] };
  const counts = {};
  for (const t of texts) counts[t.size] = (counts[t.size] || 0) + 1;
  const size = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
  return { size, lines: texts.filter((t) => t.size === size).map((t) => t.text) };
}

function render(layout, totalW, totalH, poemText) {
  const p = tr.calculateLayout(layout, totalW, totalH, null).tribute;
  return readPoem(tr.buildTributeSvg({
    width: p.width, height: p.height, colors: COLORS, tributeData: data(poemText), poemLabel: null,
  }));
}

const LAYOUTS = ['side-by-side', 'stacked', 'hero-left', 'hero-top', 'photos-left', 'tribute-top'];
// Proof sizes are proofGenerator's; print sizes are 11x14 at 300 DPI.
const CASES = [
  { name: 'portrait 11x14', proof: [1000, 1273], print: [3300, 4200] },
  { name: 'landscape 14x11', proof: [1600, 1257], print: [4200, 3300] },
];

const failures = [];
let checked = 0;
for (const c of CASES) {
  for (const layout of LAYOUTS) {
    for (const [label, poem] of Object.entries(POEMS)) {
      checked++;
      const proof = render(layout, c.proof[0], c.proof[1], poem);
      const print = render(layout, c.print[0], c.print[1], poem);
      const where = `${c.name} / ${layout} / ${label} poem`;
      if (JSON.stringify(proof.lines) !== JSON.stringify(print.lines)) {
        failures.push(`${where}\n     proof sets ${proof.lines.length} lines, print sets ${print.lines.length}`
          + `\n     proof: ${JSON.stringify(proof.lines.slice(0, 2))}`
          + `\n     print: ${JSON.stringify(print.lines.slice(0, 2))}`);
      } else if (proof.size !== print.size) {
        failures.push(`${where}\n     same line breaks but different size: proof ${proof.size}, print ${print.size}`);
      }
    }
  }
}

if (failures.length) {
  console.error(`\nRender parity FAILED — the proof and the print are different pictures.\n`);
  for (const f of failures) console.error(`  x ${f}\n`);
  console.error(`${failures.length} of ${checked} cases differ. The customer approves the proof,`);
  console.error(`so anything listed above would print differently from what they agreed to.\n`);
  process.exit(1);
}
console.log(`Render parity OK — proof and print identical across all ${checked} cases.`);
