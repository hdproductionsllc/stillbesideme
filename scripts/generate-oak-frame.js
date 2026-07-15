/**
 * Generate a realistic fine-grain natural-wood (oak) frame texture as a
 * 400x400 RGBA 9-slice border-image (matches border-image-slice:46 in
 * preview.js / store.css). The molding occupies the outer 46px band with a
 * beveled cross-section and fine, wavy oak grain running along each rail;
 * corners miter at 45 degrees. Center is transparent (discarded by the slice).
 *
 * Run: node scripts/generate-oak-frame.js  ->  public/images/frames/oak.png
 */
const sharp = require('sharp');
const path = require('path');

const SIZE = 400;
const BAND = 46;              // must equal border-image-slice
const OUT = path.join(__dirname, '..', 'public', 'images', 'frames', 'oak.png');

// ── deterministic value noise (no Math.random → reproducible builds) ──
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260715);
const GRID = 512;
const noiseTable = Array.from({ length: GRID }, () => rand());
function smooth(t) { return t * t * (3 - 2 * t); }
// 1-D value noise along a rail's length
function noise1(x) {
  const i = Math.floor(x), f = x - i;
  const a = noiseTable[((i % GRID) + GRID) % GRID];
  const b = noiseTable[(((i + 1) % GRID) + GRID) % GRID];
  return a + (b - a) * smooth(f);
}
function fbm(x) { // fractal sum for organic wobble
  return 0.6 * noise1(x) + 0.3 * noise1(x * 2.3 + 11) + 0.1 * noise1(x * 4.7 + 31);
}

// ── oak palette (honey/natural) ──
const DARK = [150, 116, 78];   // early-wood grain lines
const BASE = [201, 170, 128];  // #C9AA80 field
const LITE = [227, 202, 162];  // late-wood highlight
function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function mul(c, k) { return [c[0] * k, c[1] * k, c[2] * k]; }

// Beveled cross-section brightness across the 46px face (d: 0 outer .. 1 inner)
function bevel(d) {
  if (d < 0.06) return 0.72 + d / 0.06 * 0.20;          // outer edge shadow → up
  if (d < 0.30) return 0.92 + (d - 0.06) / 0.24 * 0.16;  // rising face, catches light
  if (d < 0.66) return 1.08 - (d - 0.30) / 0.36 * 0.10;  // gentle crown falloff
  if (d < 0.90) return 0.98 - (d - 0.66) / 0.24 * 0.20;  // inner bevel down
  return 0.78 - (d - 0.90) / 0.10 * 0.20;                // inner sight-edge shadow
}

// Fine oak grain darkness at (along px, across 0..1). Many thin, wavy lines.
function grain(along, across) {
  const wob = (fbm(along * 0.045) - 0.5) * 0.10          // slow drift of the whole grain
            + (fbm(along * 0.20 + 7) - 0.5) * 0.03;       // finer wobble
  const p = across + wob;
  // ~16 fine lines across the face + a second octave for irregularity
  let s = Math.sin(p * Math.PI * 2 * 16) * 0.5 + 0.5;
  s = Math.pow(s, 2.2);                                   // thin the dark lines
  const s2 = Math.sin((p + 0.13) * Math.PI * 2 * 33) * 0.5 + 0.5;
  s = s * 0.78 + Math.pow(s2, 3) * 0.22;
  // occasional stronger cathedral streak
  const streak = fbm(along * 0.012 + across * 3 + 50);
  if (streak > 0.72) s = Math.min(1, s + (streak - 0.72) * 1.4);
  // long-axis tone variation (planks are never one flat color)
  const tone = (fbm(along * 0.02 + 3) - 0.5) * 0.5 + 0.5;
  const field = lerp(BASE, LITE, tone * 0.6);
  return lerp(field, DARK, s * 0.85);                     // s→1 = dark grain line
}

const data = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dT = y, dB = SIZE - 1 - y, dL = x, dR = SIZE - 1 - x;
    const dmin = Math.min(dT, dB, dL, dR);
    const idx = (y * SIZE + x) * 4;
    if (dmin >= BAND) { data[idx + 3] = 0; continue; } // transparent hole

    // Which rail owns this pixel (argmin → clean 45° miter at corners)
    let along;
    if (dmin === dT) along = x;
    else if (dmin === dB) along = x + 1000;   // offset so rails don't share grain phase
    else if (dmin === dL) along = y + 2000;
    else along = y + 3000;

    const across = dmin / BAND;               // 0 outer .. 1 inner
    let c = grain(along, across);
    c = mul(c, bevel(across));

    data[idx] = Math.max(0, Math.min(255, Math.round(c[0])));
    data[idx + 1] = Math.max(0, Math.min(255, Math.round(c[1])));
    data[idx + 2] = Math.max(0, Math.min(255, Math.round(c[2])));
    data[idx + 3] = 255;
  }
}

sharp(data, { raw: { width: SIZE, height: SIZE, channels: 4 } })
  .png()
  .toFile(OUT)
  .then(() => console.log('Wrote', OUT))
  .catch((e) => { console.error(e); process.exit(1); });
