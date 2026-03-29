/**
 * Print-Ready Renderer — generates full-resolution composites for fulfillment.
 *
 * After a customer approves their proof, this module renders the final
 * print-ready image (photo + tribute panel + optional second photo) at 300 DPI
 * with no watermark. The resulting JPEG is what gets sent to Luma Prints.
 *
 * Output: output/print-ready/{orderId}.jpg
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const {
  resolveOrderData, buildTributeSvg, isLandscapeLayout, calculateLayout,
} = require('./tributeRenderer');

const OUTPUT_ROOT = process.env.OUTPUT_DIR || path.join(__dirname, '..', '..', 'output');
const PRINT_DIR = path.join(OUTPUT_ROOT, 'print-ready');

// Ensure output directory exists
if (!fs.existsSync(PRINT_DIR)) {
  fs.mkdirSync(PRINT_DIR, { recursive: true });
}

const DPI = 300;

/**
 * Calculate print pixel dimensions from SKU and layout.
 *
 * SKU convention: "framed-11x14" lists smaller dimension first.
 * Landscape layouts (side-by-side, hero-left, photos-left) are wider than tall.
 * Portrait layouts (stacked, hero-top, tribute-top) are taller than wide.
 */
function calculatePrintDimensions(sku, layout) {
  const match = sku.match(/(\d+)x(\d+)/);
  if (!match) throw new Error(`Cannot parse size from SKU: ${sku}`);

  const dim1 = Number(match[1]) * DPI; // smaller dimension in pixels
  const dim2 = Number(match[2]) * DPI; // larger dimension in pixels

  return isLandscapeLayout(layout)
    ? { width: dim2, height: dim1 }  // e.g. 4200x3300 for 11x14 landscape
    : { width: dim1, height: dim2 }; // e.g. 3300x4200 for 11x14 portrait
}

/**
 * Resize and crop a photo to fill a region.
 */
async function renderPhoto(photoPath, region, cropPosition) {
  return sharp(photoPath)
    .resize(region.width, region.height, {
      fit: 'cover',
      position: cropPosition || 'centre',
    })
    .toBuffer();
}

/**
 * Generate a print-ready JPEG for an order.
 *
 * @param {object} order — Full order row from database
 * @returns {{ printPath: string, printRelativeUrl: string }}
 */
async function generatePrintFile(order) {
  const data = resolveOrderData(order);
  const { layout, tributeColors, tributeData, photoPath, poemLabel } = data;

  if (!fs.existsSync(photoPath)) {
    throw new Error(`Photo not found: ${photoPath}`);
  }

  // Calculate dimensions at 300 DPI
  const { width: totalW, height: totalH } = calculatePrintDimensions(order.product_sku, layout);
  const panels = calculateLayout(layout, totalW, totalH);

  // Build composite layers
  const layers = [];

  // Main photo
  const photoBuffer = await renderPhoto(
    photoPath, panels.photo, data.mainPhoto.crop?.position,
  );
  layers.push({ input: photoBuffer, left: panels.photo.left, top: panels.photo.top });

  // Second photo (3-panel layouts)
  if (panels.panel2) {
    const p2Path = data.panel2Path && fs.existsSync(data.panel2Path)
      ? data.panel2Path
      : photoPath; // fall back to main photo if no second photo uploaded
    const p2CropPos = data.panel2Photo?.crop?.position || 'centre';
    const panel2Buffer = await renderPhoto(p2Path, panels.panel2, p2CropPos);
    layers.push({ input: panel2Buffer, left: panels.panel2.left, top: panels.panel2.top });
  }

  // Tribute text panel
  const tributeSvg = buildTributeSvg({
    width: panels.tribute.width,
    height: panels.tribute.height,
    colors: tributeColors,
    tributeData,
    poemLabel,
  });
  layers.push({ input: tributeSvg, left: panels.tribute.left, top: panels.tribute.top });

  // Composite all layers onto background (no watermark)
  const background = tributeColors.background || '#1a1a1a';
  const printBuffer = await sharp({
    create: { width: totalW, height: totalH, channels: 3, background },
  })
    .composite(layers)
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();

  // Save to disk
  const filename = `${order.id}.jpg`;
  const printPath = path.join(PRINT_DIR, filename);
  fs.writeFileSync(printPath, printBuffer);

  const printRelativeUrl = `/output/print-ready/${filename}`;
  const sizeMB = (printBuffer.length / (1024 * 1024)).toFixed(1);

  console.log(`Print-ready generated: ${printRelativeUrl} (${totalW}x${totalH}, ${sizeMB}MB)`);

  return { printPath, printRelativeUrl };
}

module.exports = { generatePrintFile, calculatePrintDimensions };
