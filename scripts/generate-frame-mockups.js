/**
 * Generate framed wall mockups of finished tributes for marketing / proof.
 *
 * Renders the REAL product image the way the builder shows it — full-bleed
 * photo + poem on light paper, NO printed mat, NO gutter — then wraps it in the
 * actual shipped frame texture (9-slice black / oak / espresso) hung on a wall.
 *
 * Usage:
 *   node scripts/generate-frame-mockups.js --sample   # one photo, for sign-off
 *   node scripts/generate-frame-mockups.js            # full batch
 * Output: output/wall-mockups/{name}-{frame}.jpg
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PHOTOS_DIR = path.join(ROOT, 'output', 'mockups'); // David's real pet photos live here

// Point the renderer at David's photos + a working dir BEFORE requiring it.
process.env.UPLOADS_DIR = PHOTOS_DIR;
process.env.OUTPUT_DIR = path.join(ROOT, 'output', 'mockups-work');

const sharp = require('sharp');
const { generatePrintFile } = require('../src/services/printRenderer');

const OUT_DIR = path.join(ROOT, 'output', 'wall-mockups');
const FRAMES_DIR = path.join(ROOT, 'public', 'images', 'frames');

// ── Solid-color frames (slim 0.875" gallery profile) ────────────────
// Clean solid moldings — no wood-grain texture (grain reads fake). A gentle
// diagonal bevel gives depth: lighter top-left catching light, darker bottom-
// right in shadow, with a thin dark rabbet line where the print recesses.
const FRAMES = {
  black: { color: '#1a1a1a', hi: '#3a3a3a', lo: '#000000', faceIn: 0.875 },
  brown: { color: '#4a3626', hi: '#6b4f38', lo: '#241a12', faceIn: 0.875 },
};

const WALLS = ['#EDEAE4', '#E4E1D9'];
const PAPER = '#FAF7F2';

/**
 * Build an order that renders full-bleed on light paper (the current design):
 * colorMode 'auto' with NO `colors.mat`, so the renderer uses the paper palette
 * and the plain side-by-side / stacked layout — no printed mat, no bevel rings.
 */
function buildOrder(t) {
  return {
    id: `mock-${t.id}`,
    template_id: 'pet-tribute',
    product_sku: 'framed-11x14',
    poem_text: t.poemText,
    fields_json: JSON.stringify({
      petName: t.petName,
      petNicknames: t.petNicknames || '',
      birthDate: t.birthDate,
      passDate: t.passDate,
      familyName: t.familyName,
      layout: t.layout,
    }),
    // 'attention' = sharp's saliency crop: it locks the cover-crop onto the
    // most salient region (the pet's face/eyes) so a tall photo panel never
    // slices the face off. Per-photo percent overrides win when set.
    photos_json: JSON.stringify({ main: { originalPath: t.photo, crop: { position: t.crop || 'attention' } } }),
  };
}

/**
 * Wrap a finished print in the real 9-slice frame texture, on a wall.
 */
async function frameOnWall(printBuffer, frameKey, wallColor, sizeIn) {
  const frame = FRAMES[frameKey];
  const meta = await sharp(printBuffer).metadata();

  // Downscale the 300-DPI print to display size (long edge ~1500px).
  const longEdge = Math.max(meta.width, meta.height);
  const scale = 1500 / longEdge;
  const artW = Math.round(meta.width * scale);
  const artH = Math.round(meta.height * scale);

  // Thin cream lip = the recessed paper edge (mat-board rabbet), plus a soft
  // inset shadow on top/left so the print reads as sitting behind the molding.
  const lip = Math.max(3, Math.round(longEdge * scale * 0.006));
  const artLit = await sharp({
    create: { width: artW + lip * 2, height: artH + lip * 2, channels: 3, background: PAPER },
  })
    .composite([
      { input: await sharp(printBuffer).resize(artW, artH).toBuffer(), left: lip, top: lip },
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${artW + lip * 2}" height="${artH + lip * 2}">
            <rect x="0.5" y="0.5" width="${artW + lip * 2 - 1}" height="${artH + lip * 2 - 1}"
                  fill="none" stroke="rgba(0,0,0,0.18)" stroke-width="1.5"/>
          </svg>`
        ),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();

  const aW = artW + lip * 2;
  const aH = artH + lip * 2;

  // Frame face width in px: the real face inches as a share of the outer piece,
  // solved for fw against the framed width (fw = pct·(aW+2fw)). Portrait's
  // narrower print makes the same molding read chunkier — exactly as it ships.
  const artInW = aW >= aH ? Math.max(...sizeIn) : Math.min(...sizeIn);
  const facePctOuter = frame.faceIn / (artInW + 2 * frame.faceIn);
  const fw = Math.round((facePctOuter / (1 - 2 * facePctOuter)) * aW);

  // ── Clean solid molding with a diagonal bevel (no grain) ──
  const framedW = aW + fw * 2;
  const framedH = aH + fw * 2;
  // Mitred bevel: four trapezoid facets around the opening, each shaded by the
  // light direction (top lightest, bottom darkest) so the molding reads solid
  // and three-dimensional without any texture. A thin dark line rims the print.
  const molding = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${framedW}" height="${framedH}">
      <defs>
        <linearGradient id="face" x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stop-color="${frame.hi}"/>
          <stop offset="0.45" stop-color="${frame.color}"/>
          <stop offset="1" stop-color="${frame.lo}"/>
        </linearGradient>
      </defs>
      <rect width="${framedW}" height="${framedH}" fill="url(#face)"/>
      <polygon points="0,0 ${framedW},0 ${framedW - fw},${fw} ${fw},${fw}" fill="${frame.hi}" fill-opacity="0.5"/>
      <polygon points="0,0 ${fw},${fw} ${fw},${framedH - fw} 0,${framedH}" fill="${frame.hi}" fill-opacity="0.22"/>
      <polygon points="${framedW},0 ${framedW},${framedH} ${framedW - fw},${framedH - fw} ${framedW - fw},${fw}" fill="${frame.lo}" fill-opacity="0.5"/>
      <polygon points="0,${framedH} ${framedW},${framedH} ${framedW - fw},${framedH - fw} ${fw},${framedH - fw}" fill="${frame.lo}" fill-opacity="0.7"/>
      <rect x="${fw - 2}" y="${fw - 2}" width="${aW + 4}" height="${aH + 4}" fill="none" stroke="${frame.lo}" stroke-width="2.5"/>
    </svg>`
  );
  const framed = await sharp(molding)
    .composite([{ input: artLit, left: fw, top: fw }])
    .png()
    .toBuffer();

  // ── Wall + soft drop shadow ──
  const margin = Math.round(Math.max(framedW, framedH) * 0.2);
  const canvasW = framedW + margin * 2;
  const canvasH = framedH + margin * 2;
  const shadowPad = Math.round(fw * 2.4);

  const shadow = await sharp({
    create: { width: framedW + shadowPad * 2, height: framedH + shadowPad * 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${framedW + shadowPad * 2}" height="${framedH + shadowPad * 2}">
            <rect x="${shadowPad}" y="${shadowPad}" width="${framedW}" height="${framedH}" rx="4" fill="rgba(0,0,0,0.32)"/>
          </svg>`
        ),
        left: 0,
        top: 0,
      },
    ])
    .blur(26)
    .png()
    .toBuffer();

  const wallSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">
      <defs>
        <radialGradient id="w" cx="50%" cy="36%" r="82%">
          <stop offset="0" stop-color="${wallColor}"/>
          <stop offset="1" stop-color="${shade(wallColor, -14)}"/>
        </radialGradient>
      </defs>
      <rect width="${canvasW}" height="${canvasH}" fill="url(#w)"/>
    </svg>`
  );

  return sharp(wallSvg)
    .composite([
      { input: shadow, left: margin - shadowPad + Math.round(fw * 0.25), top: margin - shadowPad + Math.round(fw * 0.5) },
      { input: framed, left: margin, top: margin },
    ])
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, v));
  return '#' + ((c((n >> 16) + amt) << 16) | (c(((n >> 8) & 0xff) + amt) << 8) | c((n & 0xff) + amt)).toString(16).padStart(6, '0');
}

// ── Sample content (for the sign-off render) ─────────────────────────
const SAMPLE = {
  id: 'sample', photo: 'DSCF1811.JPG', layout: 'side-by-side',
  petName: 'Willow', petNicknames: 'Wills', birthDate: '2011', passDate: '2024',
  familyName: 'the Bennett family',
  poemText: `You watched the world from the windowsill,\nunhurried, certain, ours.\n\nA soft weight at the end of the day,\na quiet that asked for nothing\nbut a hand within reach.\n\nThe sill is empty now,\nbut the light still falls there—\nand so do our thoughts of you.`,
};

// ── Full batch: David's real photos + fitting layouts + sample tributes ──
// Layout picked to suit each photo: side-by-side (tall photo cell) for
// front-facing / upright subjects, stacked (wide photo on top) for subjects
// lying or walking sideways. crop keeps the subject in frame.
const TRIBUTES = [
  { id: 'simba', photo: 'DSCF7814 (1).JPG', layout: 'side-by-side',
    petName: 'Simba', petNicknames: 'Si', birthDate: '2010', passDate: '2023', familyName: 'the Whitfield family',
    poemText: `You held the whole yard in one steady gaze,\nunbothered, unhurried, sure.\n\nKing of the warm stone and the tall grass,\nyou came when you wished\nand stayed when it mattered most.\n\nThe grass still bends where you sat.\nWe still look for you there.` },
  { id: 'rusty', photo: 'P1250758.JPG', layout: 'side-by-side',
    petName: 'Rusty', petNicknames: 'Rus', birthDate: '2009', passDate: '2022', familyName: 'the Delgado family',
    poemText: `You knew the truck three streets away\nand met it at the gate every single time.\n\nOne tennis ball, gone flat and grey,\nwas the finest thing you ever owned—\nyou carried it to bed like treasure.\n\nGood boy on the long trail, good boy at the door.\nThe ball's still on the porch.\nWe couldn't bring ourselves to move it.` },
  { id: 'biscuit', photo: 'DSCF0098.jpg', layout: 'side-by-side',
    petName: 'Biscuit', petNicknames: 'Bisky', birthDate: '2013', passDate: '2025', familyName: 'the Callahan family',
    poemText: `All paws and hope and headlong joy,\nyou ran at the world like it owed you a game.\n\nYou chewed our shoes and stole our hearts\nand taught us how to greet a morning.\n\nSlow down now, sweet one.\nWe will catch up to you.` },
  { id: 'pixie', photo: 'DSCF1644.JPG', layout: 'stacked', crop: '50% 40%',
    petName: 'Pixie', petNicknames: 'Pix', birthDate: '2011', passDate: '2024', familyName: 'the Romano family',
    poemText: `You had one chair—the blue one by the window—\nand you guarded it like it held the sun.\n\nEvery night at ten you found my pillow,\nkneaded it twice, and sighed us both to sleep.\n\nYou never asked for more than that:\na warm knee, a slow hand, the ten o'clock hush.\n\nThe blue chair is still yours.\nWe just sit beside it now.` },
  { id: 'pippin', photo: 'DSCF5706.jpg', layout: 'side-by-side',
    petName: 'Pippin', petNicknames: 'Pip', birthDate: '2014', passDate: '2024', familyName: 'the Novak family',
    poemText: `Curious to your whiskers,\nyou investigated every shadow,\ntested every lap, trusted every hand.\n\nThe world was a question\nand you were determined to answer it.\n\nWe are still learning\nhow to be brave the way you were.` },
  { id: 'ziggy', photo: 'IMG_7240.JPG', layout: 'side-by-side',
    petName: 'Ziggy', petNicknames: 'Zig', birthDate: '2010', passDate: '2023', familyName: 'the Hayes family',
    poemText: `You ruled the lemon tree by the fence,\nhalf wild, half ours, up before the birds.\n\nYou'd vanish for the whole gold afternoon\nand turn up at the door at six on the dot,\nleaves in your fur, entirely pleased with yourself.\n\nWherever you've climbed to now,\nwe know there's a warm branch, a low sun,\nand dinner, right on time.` },
  { id: 'boots', photo: 'DSCF9182.jpg', layout: 'side-by-side',
    petName: 'Boots', petNicknames: 'Bootsie', birthDate: '2008', passDate: '2022', familyName: 'the Marsh family',
    poemText: `You walked the yard like you owned the deed,\nchin up, tail high, unhurried.\n\nYou met us at the gate each evening\nas if our coming home\nwas the finest thing that could happen.\n\nIt was. It still is.\nWe just miss you at the gate.` },
  { id: 'mittens', photo: 'DSCF5516.jpg', layout: 'stacked', crop: '48% 42%',
    petName: 'Mittens', petNicknames: 'Mitts', birthDate: '2007', passDate: '2021', familyName: 'the Ellison family',
    poemText: `Fourteen warm years, curled in the sun,\na soft gold comma at the end of our days.\n\nYou taught us the art of resting,\nof taking the good light while it lasts,\nof staying close to the ones you love.\n\nRest easy now, old friend.\nYou earned every quiet hour.` },
  { id: 'tigger', photo: 'DSCF5286.jpg', layout: 'stacked', crop: '50% 45%',
    petName: 'Tigger', petNicknames: 'Tig', birthDate: '2012', passDate: '2024', familyName: 'the Barnes family',
    poemText: `Watchful, elegant, entirely in charge,\nyou surveyed your kingdom from the high shelf\nand found it, on the whole, acceptable.\n\nYou let us love you on your terms,\nwhich made every purr a small victory.\n\nThe high shelf is empty now.\nThe kingdom is not the same.` },
  { id: 'domino', photo: '20160819_140105.jpg', layout: 'stacked', crop: '55% 50%',
    petName: 'Marbles', petNicknames: 'Marb', birthDate: '2011', passDate: '2023', familyName: 'the Foster family',
    poemText: `You slept on my side of the bed,\nhead on the pillow like you paid the mortgage,\nand woke me at six with a paw to the cheek.\n\nOn the hard days you found me first,\npressed your head to mine\nand stayed until the world went quiet.\n\nI still wake at six.\nI still reach across the pillow.` },
  { id: 'ghost', photo: 'IMG_1673.JPG', layout: 'stacked', crop: '58% 48%',
    petName: 'Ghost', petNicknames: 'Ghosty', birthDate: '2013', passDate: '2025', familyName: 'the Park family',
    poemText: `Quiet as snowfall, soft as dusk,\nyou appeared where you were needed\nand vanished when the moment passed.\n\nYou chose the good chair, the warm knee,\nthe exact center of every photograph.\n\nYou are still here, somehow—\na small white warmth in the corner of the eye.` },
  { id: 'callie', photo: 'IMG_0243.jpeg', layout: 'stacked', crop: '50% 42%',
    petName: 'Callie', petNicknames: 'Cal', birthDate: '2010', passDate: '2024', familyName: 'the Nguyen family',
    poemText: `You grew up beside the children,\npatient through every game and costume,\nguardian of the small and the sleepy.\n\nYou were the softest place to fall\nand the first to forgive a stumble.\n\nThe house is bigger without you,\nand so much quieter than we'd like.` },
];

async function renderOne(t, frameKeys, wall, sizeIn) {
  const { printPath } = await generatePrintFile(buildOrder(t));
  const buf = fs.readFileSync(printPath);
  const files = [];
  for (const frameKey of frameKeys) {
    const out = await frameOnWall(buf, frameKey, wall, sizeIn);
    const file = path.join(OUT_DIR, `${t.id}-${frameKey}.jpg`);
    fs.writeFileSync(file, out);
    console.log(`  ✓ ${t.petName.padEnd(11)} ${frameKey.padEnd(6)} ${t.layout.padEnd(12)} → ${path.basename(file)} (${Math.round(out.length / 1024)}KB)`);
    files.push(file);
  }
  return files;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (process.argv.includes('--sample')) {
    console.log('\nRendering ONE corrected sample for sign-off...\n');
    await renderOne(SAMPLE, ['black', 'brown'], WALLS[0], [11, 14]);
    console.log('\nReview output/wall-mockups/sample-*.jpg\n');
    return;
  }

  // --only=id1,id2 re-renders just those tributes (keeping each one's original
  // index so its wall tone matches the rest of the batch). No flag = full batch.
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const onlyIds = onlyArg ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()) : null;

  const targets = TRIBUTES.map((t, i) => ({ t, i })).filter(({ t }) => !onlyIds || onlyIds.includes(t.id));
  console.log(`\nRendering ${targets.length} tribute(s) × black + brown frames...\n`);
  for (const { t, i } of targets) {
    await renderOne(t, ['black', 'brown'], WALLS[i % WALLS.length], [11, 14]);
  }
  console.log(`\nDone — ${targets.length * 2} wall mockups in output/wall-mockups/\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
