/**
 * Generate branded favicons using Sharp.
 * Run: node scripts/generate-favicons.js
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = path.join(__dirname, '..', 'public');

// Brand palette
const COLORS = {
  bg: '#0f0d0b',
  warm: '#C4A882',
};

function createFaviconSVG(size) {
  const pad = Math.round(size * 0.12);
  const cx = size / 2;
  const cy = size / 2;
  const r = (size / 2) - pad;

  // Diamond shape (brand element from OG images)
  const dSize = Math.round(r * 0.7);
  return `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" rx="${Math.round(size * 0.15)}" fill="${COLORS.bg}"/>
  <polygon points="${cx},${cy - dSize} ${cx + dSize},${cy} ${cx},${cy + dSize} ${cx - dSize},${cy}"
           fill="none" stroke="${COLORS.warm}" stroke-width="${Math.max(2, Math.round(size * 0.06))}"/>
  <text x="${cx}" y="${cy + Math.round(size * 0.08)}" text-anchor="middle"
        font-family="Georgia, serif" font-size="${Math.round(size * 0.3)}"
        letter-spacing="${Math.round(size * 0.02)}" fill="${COLORS.warm}">
    S
  </text>
</svg>`;
}

async function generate() {
  const sizes = [
    { name: 'favicon.ico', size: 32, format: 'png' },      // Will be saved as PNG (browsers handle it)
    { name: 'favicon-32x32.png', size: 32, format: 'png' },
    { name: 'favicon-16x16.png', size: 16, format: 'png' },
    { name: 'apple-touch-icon.png', size: 180, format: 'png' },
    { name: 'favicon-192x192.png', size: 192, format: 'png' },
  ];

  console.log('Generating favicons...\n');

  for (const item of sizes) {
    const svg = createFaviconSVG(item.size);
    const outPath = path.join(OUTPUT_DIR, item.name);

    await sharp(Buffer.from(svg))
      .png()
      .toFile(outPath);

    const stats = fs.statSync(outPath);
    console.log(`  ${item.name}  (${stats.size} bytes)`);
  }

  console.log('\nDone. Favicons saved to public/');
}

generate().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
