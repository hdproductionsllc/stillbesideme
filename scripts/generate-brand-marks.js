/**
 * Brand marks for header / social avatars, rendered in the brand serif.
 *   - wordmark-light.png : "Still Beside Me" (cream) + gold diamond divider, for dark backgrounds
 *   - wordmark-dark.png  : same in espresso ink, for light backgrounds
 *   - lockup-light.png   : gold-framed "S" monogram + wordmark (horizontal header lockup)
 * Run: node scripts/generate-brand-marks.js
 */
const sharp = require('sharp');
const path = require('path');
if (!process.env.FONTCONFIG_PATH) {
  process.env.FONTCONFIG_PATH = path.join(__dirname, '..', 'src', 'assets', 'fonts');
}
const OUT = path.join(__dirname, '..', 'public', 'images', 'brand');
const WARM = '#C4A882';

function wordmarkSVG(ink, muted) {
  const w = 720, h = 200, cx = w / 2;
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <text x="${cx}" y="70" text-anchor="middle" font-family="'Cormorant Garamond', Georgia, serif"
          font-size="26" letter-spacing="7" fill="${WARM}">STILL BESIDE ME</text>
    <text x="${cx}" y="140" text-anchor="middle" font-family="'Cormorant Garamond', Georgia, serif"
          font-size="72" font-weight="500" fill="${ink}">Still Beside Me</text>
    <line x1="${cx-70}" y1="168" x2="${cx-14}" y2="168" stroke="${WARM}" stroke-width="1" opacity="0.7"/>
    <polygon points="${cx},160 ${cx+8},168 ${cx},176 ${cx-8},168" fill="none" stroke="${WARM}" stroke-width="1" opacity="0.8"/>
    <line x1="${cx+14}" y1="168" x2="${cx+70}" y2="168" stroke="${WARM}" stroke-width="1" opacity="0.7"/>
  </svg>`;
}

async function main() {
  await sharp(Buffer.from(wordmarkSVG('#FAF8F5', '#9B9590'))).png()
    .toFile(path.join(OUT, 'wordmark-light.png'));
  await sharp(Buffer.from(wordmarkSVG('#241E19', '#6B5D52'))).png()
    .toFile(path.join(OUT, 'wordmark-dark.png'));

  // Horizontal lockup: monogram + single-line wordmark on transparent
  const W = 760, H = 200;
  const mono = await sharp(path.join(__dirname, '..', 'public', 'favicon-192x192.png'))
    .resize(128, 128).toBuffer();
  const wordSVG = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <text x="176" y="118" font-family="'Cormorant Garamond', Georgia, serif"
            font-size="66" font-weight="500" fill="#FAF8F5">Still Beside Me</text>
    </svg>`;
  await sharp({ create: { width: W, height: H, channels: 4, background: { r:0,g:0,b:0,alpha:0 } } })
    .composite([{ input: mono, left: 24, top: 36 }, { input: Buffer.from(wordSVG), left: 0, top: 0 }])
    .png().toFile(path.join(OUT, 'lockup-light.png'));

  console.log('Wrote wordmark-light.png, wordmark-dark.png, lockup-light.png to public/images/brand/');
}
main().catch(e => { console.error(e); process.exit(1); });
