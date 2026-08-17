/**
 * Proof Generator — builds a proof image from order data using Sharp.
 *
 * Composites: customer photo + tribute text panel + optional second photo
 * (from shared tributeRenderer) with a "PROOF" watermark overlay.
 * Output is a JPEG saved to output/proofs/.
 */

const sharp = require('sharp');
const fs = require('fs');

const {
  resolveOrderData, buildTributeSvg, isLandscapeLayout, calculateLayout,
  calculateMatLayout, buildMatOverlaySvg, renderPhotoCover, emitToOutput,
} = require('./tributeRenderer');
const { calculatePrintDimensions } = require('./printRenderer');

const PROOFS_SUBDIR = 'proofs';

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

// Photo cover-fit is shared via tributeRenderer.renderPhotoCover —
// it honors percent smart-crop positions that sharp's `position` rejects,
// and the customer's zoom/pan from the customizer preview when present.
const renderPhoto = (photoPath, region, cropPosition, quality, crop) =>
  renderPhotoCover(photoPath, region, cropPosition, quality || 90, crop);

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

  // Proof dimensions (display-size, not print-size).
  // Printed-mat proofs use the true print aspect ratio so the proof is an
  // exact scaled-down preview of the final file.
  let totalW, totalH, panels;
  // Hoisted: the proof is a display-size render, so its pixels mean nothing
  // physical on their own. Keeping the print dimensions in scope lets us hand
  // the tribute renderer the panel's real printed width, so the proof reports
  // the same point size the press will set.
  const printDimsForScale = calculatePrintDimensions(order.product_sku, layout);
  if (data.hasPrintedMat) {
    const printDims = printDimsForScale;
    totalW = isLandscapeLayout(layout) ? 1600 : 1000;
    totalH = Math.round(totalW * (printDims.height / printDims.width));
    const dpiScale = totalW / printDims.width;
    panels = calculateMatLayout(layout, totalW, totalH, data.printSpec, dpiScale);
  } else {
    // Use the TRUE print aspect ratio (not a generic 1600x1000) so the proof
    // is an exact scaled-down preview of the printed file — same composition,
    // same panel proportions, same footer spacing. A hardcoded ratio made the
    // emailed proof (1.6) disagree with the 14/11 print the customer receives.
    const printDims = printDimsForScale;
    totalW = isLandscapeLayout(layout) ? 1600 : 1000;
    totalH = Math.round(totalW * (printDims.height / printDims.width));
    panels = calculateLayout(layout, totalW, totalH, data.customRatios);
  }

  // Poem position: swap photo/tribute regions to match the customer's preview.
  if (data.poemFirst) {
    const swap = panels.photo;
    panels.photo = panels.tribute;
    panels.tribute = swap;
  }

  // Build composite layers
  const layers = [];

  // Main photo
  const photoBuffer = await renderPhoto(
    photoPath, panels.photo, data.mainPhoto.crop?.position, 90, data.photoCrops?.photo,
  );
  layers.push({ input: photoBuffer, left: panels.photo.left, top: panels.photo.top });

  // Second photo (3-panel layouts)
  if (panels.panel2) {
    const p2Path = data.panel2Path && fs.existsSync(data.panel2Path)
      ? data.panel2Path
      : photoPath;
    const p2CropPos = data.panel2Photo?.crop?.position || 'centre';
    const panel2Buffer = await renderPhoto(p2Path, panels.panel2, p2CropPos, 90, data.photoCrops?.panel2);
    layers.push({ input: panel2Buffer, left: panels.panel2.left, top: panels.panel2.top });
  }

  // Tribute panel SVG
  const poemFit = {};
  const tributeSvg = buildTributeSvg({
    width: panels.tribute.width,
    height: panels.tribute.height,
    colors: tributeColors,
    tributeData,
    poemLabel,
    // Proof pixels are display-size, so convert through the print's own scale.
    panelWidthIn: (panels.tribute.width / totalW) * (printDimsForScale.width / 300),
    report: poemFit,
  });
  layers.push({ input: tributeSvg, left: panels.tribute.left, top: panels.tribute.top });

  // Bevel ring around openings (printed mat orders only)
  if (data.hasPrintedMat) {
    const matOverlay = buildMatOverlaySvg({
      width: totalW,
      height: totalH,
      openings: [panels.photo, panels.tribute],
      bevelColor: tributeColors.bevel,
      bevelWidth: panels.bevelWidth,
    });
    layers.push({ input: matOverlay, left: 0, top: 0 });
  }

  // Watermark overlay
  const watermarkSvg = buildWatermarkSvg(totalW, totalH);
  layers.push({ input: watermarkSvg, left: 0, top: 0 });

  // Composite everything
  const background = (data.hasPrintedMat && tributeColors.mat) || tributeColors.background || '#1a1a1a';
  const proofBuffer = await sharp({
    create: { width: totalW, height: totalH, channels: 3, background },
  })
    .composite(layers)
    .jpeg({ quality: 85 })
    .toBuffer();

  // Save
  const { absPath: proofPath, relativeUrl: proofRelativeUrl } =
    emitToOutput(PROOFS_SUBDIR, `${order.id}.jpg`, proofBuffer);
  console.log(`Proof generated: ${proofRelativeUrl} (${totalW}x${totalH})`);

  return { proofPath, proofRelativeUrl };
}

module.exports = { generateProof };
