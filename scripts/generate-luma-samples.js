/**
 * Generate print-ready test images for Luma Prints sample ordering.
 * Creates one image per style variant (classic-dark, warm-natural, soft-light)
 * at 11x14" @ 300 DPI = 3300x4200px, side-by-side layout.
 *
 * Usage: node scripts/generate-luma-samples.js
 * Output: output/luma-samples/sample-{style}.jpg
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const STOCK_DIR = path.join(ROOT, 'public', 'images', 'stock');
const OUT_DIR = path.join(ROOT, 'output', 'luma-samples');

// 11x14" @ 300 DPI, landscape (side-by-side layout)
const PRINT_W = 4200; // 14" wide
const PRINT_H = 3300; // 11" tall

// Use golden retriever as the test photo — best stock image
const TEST_PHOTO = path.join(STOCK_DIR, 'golden-retriever.jpg');

// Sample tribute content
const TRIBUTE = {
  name: 'Buddy',
  nickname: 'Mr. Wigglebutt',
  birthDate: '2012',
  passDate: '2025',
  poemText: `You were the golden thread that held our days together,\nthe warm weight at our feet when the world felt too heavy,\nthe joy that met us at the door before we even turned the key.\n\nYou knew our sadness before we spoke it,\nnuzzling close with those deep brown eyes\nthat said more than words ever could.\n\nEvery trail we walked, you led the way—\nnose to the wind, tail painting the air,\nteaching us what it meant to be fully alive.\n\nThe house is quieter now,\nbut your paw prints are everywhere—\non the couch, in the garden,\nacross every corner of our hearts.\n\nYou were never just a dog.\nYou were the best part of coming home.`,
  familyName: 'The Hamilton Family',
  familyPrefix: 'Beloved companion of',
};

// Style definitions (from pet-tribute.json)
const STYLES = {
  'classic-dark': {
    label: 'Classic Dark',
    mat: '#1a1a1a',
    tribute: {
      background: '#1a1a1a',
      name: '#FAF8F5',
      dates: '#9B9590',
      divider: '#C4A882',
      poem: '#C4A882',
      nickname: '#9B9590',
      family: '#9B9590',
    },
  },
  'warm-natural': {
    label: 'Warm Natural',
    mat: '#F5EDE0',
    tribute: {
      background: '#F5EDE0',
      name: '#2C2420',
      dates: '#6B5D52',
      divider: '#C4A882',
      poem: '#4A3F36',
      nickname: '#6B5D52',
      family: '#6B5D52',
    },
  },
  'soft-light': {
    label: 'Soft Light',
    mat: '#FFFFFF',
    tribute: {
      background: '#FFFFFF',
      name: '#3a3a3a',
      dates: '#8a8a8a',
      divider: '#c0b8a8',
      poem: '#5a5a5a',
      nickname: '#8a8a8a',
      family: '#8a8a8a',
    },
  },
};

function escSvg(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Build the tribute panel as an SVG string.
 */
function buildTributeSvg(width, height, colors) {
  const padding = Math.round(width * 0.1);
  const innerW = width - padding * 2;

  const nameFontSize = Math.round(width * 0.065);
  const nicknameFontSize = Math.round(width * 0.03);
  const datesFontSize = Math.round(width * 0.028);
  const poemFontSize = Math.round(width * 0.028);
  const familyFontSize = Math.round(width * 0.026);
  const lineHeight = 1.55;

  let y = Math.round(height * 0.1);
  const els = [];

  // Name
  els.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${nameFontSize}" fill="${escSvg(colors.name)}" font-weight="400">${escSvg(TRIBUTE.name)}</text>`);
  y += nameFontSize + 10;

  // Nickname
  els.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${nicknameFontSize}" fill="${escSvg(colors.nickname)}" font-style="italic">"${escSvg(TRIBUTE.nickname)}"</text>`);
  y += nicknameFontSize + 16;

  // Dates
  const dates = `${TRIBUTE.birthDate} — ${TRIBUTE.passDate}`;
  els.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="sans-serif" font-size="${datesFontSize}" fill="${escSvg(colors.dates)}">${escSvg(dates)}</text>`);
  y += datesFontSize + 20;

  // Divider
  const divW = Math.round(innerW * 0.3);
  els.push(`<line x1="${(width - divW) / 2}" y1="${y}" x2="${(width + divW) / 2}" y2="${y}" stroke="${escSvg(colors.divider)}" stroke-width="2" />`);
  y += 30;

  // Poem (line by line, respecting \n)
  const poemLineHeight = Math.round(poemFontSize * lineHeight);
  const maxChars = Math.round(innerW / (poemFontSize * 0.5));
  const rawLines = TRIBUTE.poemText.split('\n');

  for (const rawLine of rawLines) {
    if (rawLine.trim() === '') {
      y += Math.round(poemLineHeight * 0.6); // blank line spacing
      continue;
    }
    // Word-wrap each line
    const words = rawLine.split(/\s+/);
    let current = '';
    for (const word of words) {
      if (current.length + word.length + 1 > maxChars && current.length > 0) {
        if (y + poemLineHeight > height - 120) break;
        els.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${poemFontSize}" fill="${escSvg(colors.poem)}" font-style="italic">${escSvg(current)}</text>`);
        y += poemLineHeight;
        current = word;
      } else {
        current = current ? current + ' ' + word : word;
      }
    }
    if (current) {
      if (y + poemLineHeight <= height - 120) {
        els.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${poemFontSize}" fill="${escSvg(colors.poem)}" font-style="italic">${escSvg(current)}</text>`);
        y += poemLineHeight;
      }
    }
  }

  y += 16;

  // Divider before family
  const divW2 = Math.round(innerW * 0.15);
  els.push(`<line x1="${(width - divW2) / 2}" y1="${y}" x2="${(width + divW2) / 2}" y2="${y}" stroke="${escSvg(colors.divider)}" stroke-width="1.5" />`);
  y += 24;

  // Family prefix
  els.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="sans-serif" font-size="${familyFontSize}" fill="${escSvg(colors.family)}">${escSvg(TRIBUTE.familyPrefix)}</text>`);
  y += familyFontSize + 8;

  // Family name
  els.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${Math.round(familyFontSize * 1.15)}" fill="${escSvg(colors.family)}">${escSvg(TRIBUTE.familyName)}</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="${escSvg(colors.background)}" />
  ${els.join('\n  ')}
</svg>`;
}

async function generateSample(styleKey, styleDef) {
  console.log(`Generating ${styleDef.label}...`);

  // Side-by-side: photo left (50%), tribute right (50%)
  const photoW = Math.round(PRINT_W * 0.5);
  const photoH = PRINT_H;
  const tributeW = PRINT_W - photoW;
  const tributeH = PRINT_H;

  // Resize and crop the stock photo to fill the left panel
  const photoBuffer = await sharp(TEST_PHOTO)
    .resize(photoW, photoH, { fit: 'cover', position: 'centre' })
    .toBuffer();

  // Build tribute SVG
  const tributeSvg = buildTributeSvg(tributeW, tributeH, styleDef.tribute);
  const tributeBuffer = Buffer.from(tributeSvg);

  // Composite onto background
  const result = await sharp({
    create: {
      width: PRINT_W,
      height: PRINT_H,
      channels: 3,
      background: styleDef.mat,
    },
  })
    .composite([
      { input: photoBuffer, left: 0, top: 0 },
      { input: tributeBuffer, left: photoW, top: 0 },
    ])
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toFile(path.join(OUT_DIR, `sample-${styleKey}.jpg`));

  console.log(`  -> sample-${styleKey}.jpg (${PRINT_W}x${PRINT_H}, ${Math.round(result.size / 1024)}KB)`);
}

async function main() {
  // Ensure output dir
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`\nGenerating Luma Prints test images...`);
  console.log(`Photo: golden-retriever.jpg`);
  console.log(`Size: 11x14" @ 300 DPI (${PRINT_W}x${PRINT_H}px)`);
  console.log(`Layout: Side by Side\n`);

  for (const [key, style] of Object.entries(STYLES)) {
    await generateSample(key, style);
  }

  console.log(`\nDone! Files saved to: output/luma-samples/`);
  console.log(`\nNext steps:`);
  console.log(`  1. Open dashboard.lumaprints.com`);
  console.log(`  2. Place a manual order for each style:`);
  console.log(`     - sample-classic-dark.jpg  -> Black frame, Smooth Black mat`);
  console.log(`     - sample-warm-natural.jpg  -> Oak frame, Cream mat`);
  console.log(`     - sample-soft-light.jpg    -> White frame, White mat`);
  console.log(`  3. Select: 11x14", 1" mat, Semi-Glossy paper, Acrylic glazing`);
  console.log(`  4. Ship to yourself`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
