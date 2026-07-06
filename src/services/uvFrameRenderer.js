/**
 * UV Frame Renderer — generates the frame inscription print file.
 *
 * The base product carries exactly ONE UV element on the frame: the pet's
 * name and years. One font, one size, one placement (src/data/uv-frame-spec.json).
 *
 * The inscription text is derived strictly from order.fields_json. It is
 * never typed by hand at any point between checkout and the E1 printer —
 * one misspelled name on a memorial is a refund, an apology, and a bad
 * review all at once.
 *
 * Output: output/uv-frame/{orderId}.png (300 DPI, sized to the E1 jig)
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const spec = require('../data/uv-frame-spec.json');

const OUTPUT_ROOT = process.env.OUTPUT_DIR || path.join(__dirname, '..', '..', 'output');
const UV_DIR = path.join(OUTPUT_ROOT, 'uv-frame');

if (!fs.existsSync(UV_DIR)) {
  fs.mkdirSync(UV_DIR, { recursive: true });
}

function escSvg(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function yearOf(dateStr) {
  const m = String(dateStr || '').match(/\d{4}/);
  return m ? m[0] : '';
}

/**
 * The single source of truth for what the frame says, e.g. "Banjo · 2014 - 2026".
 * Also used by the proof email so the customer confirms spelling at approval.
 * Returns '' when the order has no pet name (non-pet templates) — no UV element.
 */
function frameInscription(fields) {
  const name = (fields.petName || '').trim();
  if (!name) return '';
  const born = yearOf(fields.birthDate);
  const passed = yearOf(fields.passDate);
  const years = born && passed ? `${born} - ${passed}` : (passed || born);
  return years ? `${name} · ${years}` : name;
}

/**
 * Generate the UV inscription PNG for an order.
 *
 * @param {object} order — Full order row from database
 * @returns {{ uvPath, uvRelativeUrl, inscription } | null} null when the
 *   order has no inscription (non-pet template) — callers skip silently.
 */
async function generateUvFile(order) {
  const fields = order.fields_json ? JSON.parse(order.fields_json) : {};
  const inscription = frameInscription(fields);
  if (!inscription) return null;

  const { canvas, text, placement } = spec;
  const width = Math.round(canvas.widthIn * canvas.dpi);
  const height = Math.round(canvas.heightIn * canvas.dpi);

  // Fit-to-width: shrink the font for unusually long names rather than
  // clipping. 0.58 is a safe average glyph-width ratio for Georgia.
  let fontSize = Math.round(text.fontSizeIn * canvas.dpi);
  const maxTextWidth = width * 0.92;
  const estimate = (size) => inscription.length * size * 0.58 + (inscription.length - 1) * text.letterSpacingPx;
  while (fontSize > 20 && estimate(fontSize) > maxTextWidth) {
    fontSize -= 2;
  }

  const x = placement.align === 'center' ? width / 2 : 0;
  const anchor = placement.align === 'center' ? 'middle' : 'start';
  const y = placement.verticalCenter ? height / 2 : fontSize;

  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="central"
        font-family="${escSvg(text.fontFamily)}" font-size="${fontSize}"
        letter-spacing="${text.letterSpacingPx}" fill="${escSvg(text.color)}">${escSvg(inscription)}</text>
</svg>`);

  const transparent = canvas.background === 'transparent';
  const background = transparent
    ? { r: 0, g: 0, b: 0, alpha: 0 }
    : canvas.background;

  const buffer = await sharp({
    create: { width, height, channels: 4, background },
  })
    .composite([{ input: svg, left: 0, top: 0 }])
    .png()
    .toBuffer();

  const filename = `${order.id}.png`;
  const uvPath = path.join(UV_DIR, filename);
  fs.writeFileSync(uvPath, buffer);

  const uvRelativeUrl = `/output/uv-frame/${filename}`;
  console.log(`UV inscription generated: ${uvRelativeUrl} ("${inscription}", ${width}x${height})`);

  return { uvPath, uvRelativeUrl, inscription };
}

module.exports = { generateUvFile, frameInscription };
