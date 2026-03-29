/**
 * Proof Generator — builds a proof image from order data using Sharp.
 *
 * Composites: customer photo + tribute text panel + optional second photo
 * (from shared tributeRenderer) with a "PROOF" watermark overlay.
 * Output is a JPEG saved to output/proofs/.
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const {
  resolveOrderData, buildTributeSvg, isLandscapeLayout, calculateLayout,
} = require('./tributeRenderer');

const OUTPUT_ROOT = process.env.OUTPUT_DIR || path.join(__dirname, '..', '..', 'output');
const PROOFS_DIR = path.join(OUTPUT_ROOT, 'proofs');

// Ensure proofs directory exists
if (!fs.existsSync(PROOFS_DIR)) {
  fs.mkdirSync(PROOFS_DIR, { recursive: true });
}

/**
 * Build a "PROOF" watermark overlay as SVG.
 */
function buildWatermarkSvg(width, height) {
  const fontSize = Math.round(Math.min(width, height) * 0.12);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <text x="${width / 2}" y="${height / 2}" text-anchor="middle" dominant-baseline="middle"
        font-family="sans-serif" font-size="${fontSize}" font-weight="700"
        fill="rgba(255,255,255,0.25)" letter-spacing="20"
        transform="rotate(-30, ${width / 2}, ${height / 2})">PROOF</text>
</svg>`;
  return Buffer.from(svg);
}

/**
 * Resize and crop a photo to fill a region.
 */
async function renderPhoto(photoPath, region, cropPosition, quality) {
  return sharp(photoPath)
    .resize(region.width, region.height, {
      fit: 'cover',
      position: cropPosition || 'centre',
    })
    .jpeg({ quality: quality || 90 })
    .toBuffer();
}

/**
 * Generate a proof image for an order.
 *
 * @param {object} order — Full order row from DB
 * @returns {{ proofPath: string, proofRelativeUrl: string }}
 */
async function generateProof(order) {
  const data = resolveOrderData(order);
  const { layout, tributeColors, tributeData, photoPath, poemLabel } = data;

  if (!fs.existsSync(photoPath)) throw new Error(`Photo not found: ${photoPath}`);

  // Proof dimensions (display-size, not print-size)
  const totalW = isLandscapeLayout(layout) ? 1600 : 1000;
  const totalH = isLandscapeLayout(layout) ? 1000 : 1600;

  const panels = calculateLayout(layout, totalW, totalH);

  // Build composite layers
  const layers = [];

  // Main photo
  const photoBuffer = await renderPhoto(
    photoPath, panels.photo, data.mainPhoto.crop?.position, 90,
  );
  layers.push({ input: photoBuffer, left: panels.photo.left, top: panels.photo.top });

  // Second photo (3-panel layouts)
  if (panels.panel2) {
    const p2Path = data.panel2Path && fs.existsSync(data.panel2Path)
      ? data.panel2Path
      : photoPath;
    const p2CropPos = data.panel2Photo?.crop?.position || 'centre';
    const panel2Buffer = await renderPhoto(p2Path, panels.panel2, p2CropPos, 90);
    layers.push({ input: panel2Buffer, left: panels.panel2.left, top: panels.panel2.top });
  }

  // Tribute panel SVG
  const tributeSvg = buildTributeSvg({
    width: panels.tribute.width,
    height: panels.tribute.height,
    colors: tributeColors,
    tributeData,
    poemLabel,
  });
  layers.push({ input: tributeSvg, left: panels.tribute.left, top: panels.tribute.top });

  // Watermark overlay
  const watermarkSvg = buildWatermarkSvg(totalW, totalH);
  layers.push({ input: watermarkSvg, left: 0, top: 0 });

  // Composite everything
  const background = tributeColors.background || '#1a1a1a';
  const proofBuffer = await sharp({
    create: { width: totalW, height: totalH, channels: 3, background },
  })
    .composite(layers)
    .jpeg({ quality: 85 })
    .toBuffer();

  // Save
  const proofFilename = `${order.id}.jpg`;
  const proofPath = path.join(PROOFS_DIR, proofFilename);
  fs.writeFileSync(proofPath, proofBuffer);

  const proofRelativeUrl = `/output/proofs/${proofFilename}`;
  console.log(`Proof generated: ${proofRelativeUrl} (${totalW}x${totalH})`);

  return { proofPath, proofRelativeUrl };
}

module.exports = { generateProof };
