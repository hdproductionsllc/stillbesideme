/**
 * Generate branded OG images for all pages using Sharp.
 * Run: node scripts/generate-og-images.js
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'images', 'og');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Brand palette from store.css
const COLORS = {
  bg: '#0f0d0b',
  surface: '#1a1714',
  warm: '#C4A882',
  warmFaded: 'rgba(196,168,130,0.35)',
  warmSubtle: 'rgba(196,168,130,0.12)',
  text: '#FAF8F5',
  muted: '#9B9590',
};

// Pages to generate OG images for
const pages = [
  { file: 'homepage', title: 'Still Beside Me', sub: 'Personalized memorial gifts \u2013 custom poems & letters, framed' },
  { file: 'memorial-gifts', title: 'Memorial Gifts', sub: 'A letter from heaven \u2013 in their voice, from your memories' },
  { file: 'pet-memorial-gifts', title: 'Pet Memorial Gifts', sub: 'A personalized poem for the pet who changed your life' },
  { file: 'sympathy-gifts', title: 'Sympathy Gifts', sub: 'The gift that stays on the wall for years' },
  { file: 'dog-memorial-gifts', title: 'Dog Memorial Gifts', sub: 'A personalized poem for the best dog ever' },
  { file: 'cat-memorial-gifts', title: 'Cat Memorial Gifts', sub: 'A personalized poem for the cat who chose you' },
  { file: 'loss-of-mother-gift', title: 'Loss of Mother', sub: 'A letter she would have written' },
  { file: 'loss-of-father-gift', title: 'Loss of Father', sub: 'A letter he would have written' },
  { file: 'loss-of-husband-gift', title: 'Loss of Husband', sub: 'A letter he would have written' },
  { file: 'loss-of-wife-gift', title: 'Loss of Wife', sub: 'A letter she would have written' },
  { file: 'loss-of-grandmother-gift', title: 'Loss of Grandmother', sub: 'A letter she would have written' },
  { file: 'loss-of-grandfather-gift', title: 'Loss of Grandfather', sub: 'A letter he would have written' },
  { file: 'loss-of-child-gift', title: 'Loss of Child', sub: 'A letter from the child who loved you' },
  { file: 'loss-of-brother-gift', title: 'Loss of Brother', sub: 'A letter he would have written' },
  { file: 'loss-of-sister-gift', title: 'Loss of Sister', sub: 'A letter she would have written' },
  { file: 'loss-of-best-friend-gift', title: 'Loss of Best Friend', sub: 'A letter they would have written' },
  { file: 'blog', title: 'Blog', sub: 'Grief, remembrance & memorial gift ideas' },
];

function createSVG(title, sub) {
  // 1200x630 OG image
  const w = 1200;
  const h = 630;

  // Decorative diamond shape
  const cx = w / 2;

  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${COLORS.bg}"/>
      <stop offset="100%" stop-color="${COLORS.surface}"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${w}" height="${h}" fill="url(#bg)"/>

  <!-- Subtle border -->
  <rect x="24" y="24" width="${w - 48}" height="${h - 48}" fill="none"
        stroke="${COLORS.warmSubtle}" stroke-width="1"/>
  <rect x="32" y="32" width="${w - 64}" height="${h - 64}" fill="none"
        stroke="${COLORS.warmSubtle}" stroke-width="1"/>

  <!-- Top decorative line -->
  <line x1="${cx - 60}" y1="170" x2="${cx + 60}" y2="170"
        stroke="${COLORS.warm}" stroke-width="1" opacity="0.5"/>

  <!-- Diamond ornament -->
  <polygon points="${cx},155 ${cx + 8},163 ${cx},171 ${cx - 8},163"
           fill="none" stroke="${COLORS.warm}" stroke-width="1" opacity="0.5"/>

  <!-- Brand name -->
  <text x="${cx}" y="140" text-anchor="middle"
        font-family="Georgia, 'Cormorant Garamond', serif"
        font-size="22" letter-spacing="6" fill="${COLORS.warm}">
    STILL BESIDE ME
  </text>

  <!-- Main title -->
  <text x="${cx}" y="${h / 2 - 10}" text-anchor="middle"
        font-family="Georgia, 'Cormorant Garamond', serif"
        font-size="56" font-weight="400" fill="${COLORS.text}">
    ${escapeXml(title)}
  </text>

  <!-- Subtitle -->
  <text x="${cx}" y="${h / 2 + 50}" text-anchor="middle"
        font-family="Georgia, 'Cormorant Garamond', serif"
        font-size="24" font-style="italic" fill="${COLORS.muted}">
    ${escapeXml(sub)}
  </text>

  <!-- Bottom decorative line -->
  <line x1="${cx - 60}" y1="${h - 170}" x2="${cx + 60}" y2="${h - 170}"
        stroke="${COLORS.warm}" stroke-width="1" opacity="0.5"/>

  <!-- Bottom tagline -->
  <text x="${cx}" y="${h - 140}" text-anchor="middle"
        font-family="'Source Sans Pro', system-ui, sans-serif"
        font-size="16" letter-spacing="1" fill="${COLORS.muted}" opacity="0.6">
    stillbesideme.com
  </text>
</svg>`;
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function generate() {
  console.log(`Generating ${pages.length} OG images...\n`);

  for (const page of pages) {
    const svg = createSVG(page.title, page.sub);
    const outPath = path.join(OUTPUT_DIR, `${page.file}.jpg`);

    await sharp(Buffer.from(svg))
      .jpeg({ quality: 90, mozjpeg: true })
      .toFile(outPath);

    const stats = fs.statSync(outPath);
    console.log(`  ${page.file}.jpg  (${Math.round(stats.size / 1024)}KB)`);
  }

  console.log(`\nDone. Images saved to public/images/og/`);
}

generate().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
