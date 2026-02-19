/**
 * Image Processor — HEIC conversion, thumbnails, quality assessment, smart crop.
 *
 * Quality tiers use warm language because these are memorial photos.
 * We NEVER reject a photo.
 */

const sharp = require('sharp');
const path = require('path');

// Lazy-load heic-convert only when needed (heavy module)
let heicConvert = null;

/** Convert HEIC/HEIF buffer to JPEG buffer */
async function convertHeic(inputBuffer) {
  if (!heicConvert) {
    heicConvert = require('heic-convert');
  }
  const outputBuffer = await heicConvert({
    buffer: inputBuffer,
    format: 'JPEG',
    quality: 0.95
  });
  return Buffer.from(outputBuffer);
}

/** Check if a file is HEIC format */
function isHeic(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ext === '.heic' || ext === '.heif';
}

/** Generate a display-quality thumbnail (800px wide, JPEG 85%) */
async function createThumbnail(inputBuffer) {
  return sharp(inputBuffer)
    .resize(800, null, { withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** Get image dimensions from buffer */
async function getDimensions(buffer) {
  const meta = await sharp(buffer).metadata();
  return {
    width: meta.width,
    height: meta.height,
    format: meta.format,
    channels: meta.channels,
    density: meta.density || null
  };
}

/**
 * 4-tier quality assessment — warm messages, NEVER reject.
 *
 * @param {number} imageWidth - Image pixel width
 * @param {number} imageHeight - Image pixel height
 * @param {number} printWidthIn - Target print width in inches
 * @param {number} printHeightIn - Target print height in inches
 */
function assessQuality(imageWidth, imageHeight, printWidthIn = 16, printHeightIn = 20) {
  const dpiH = imageWidth / printWidthIn;
  const dpiV = imageHeight / printHeightIn;
  const effectiveDpi = Math.min(dpiH, dpiV);

  if (effectiveDpi >= 200) {
    return {
      tier: 'excellent',
      dpi: Math.round(effectiveDpi),
      message: 'This photo will look beautiful',
      icon: '✓'
    };
  }
  if (effectiveDpi >= 150) {
    return {
      tier: 'good',
      dpi: Math.round(effectiveDpi),
      message: 'This photo will print well',
      icon: '✓'
    };
  }
  if (effectiveDpi >= 100) {
    return {
      tier: 'usable',
      dpi: Math.round(effectiveDpi),
      message: "This photo is a bit small but we'll make it look its best. A higher resolution version would help for the sharpest print.",
      icon: '!'
    };
  }
  return {
    tier: 'low',
    dpi: Math.round(effectiveDpi),
    message: 'This photo is quite small and may appear soft when printed at this size. It will still be meaningful — would you like to try a smaller print size for better quality?',
    icon: '!'
  };
}

/**
 * Entropy-based smart crop analysis.
 * Finds the region of highest detail/interest to center the crop on.
 * Returns position as percentage offsets (0-100) for CSS-like positioning.
 */
async function analyzeCrop(buffer) {
  const meta = await sharp(buffer).metadata();
  const { width, height } = meta;

  // Downscale for fast entropy analysis
  const analysisWidth = Math.min(width, 400);
  const scale = analysisWidth / width;
  const analysisHeight = Math.round(height * scale);

  const { data, info } = await sharp(buffer)
    .resize(analysisWidth, analysisHeight, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Divide into a grid and measure entropy per cell
  const gridCols = 5;
  const gridRows = 5;
  const cellW = Math.floor(info.width / gridCols);
  const cellH = Math.floor(info.height / gridRows);

  let maxEntropy = -1;
  let bestCol = Math.floor(gridCols / 2);
  let bestRow = Math.floor(gridRows / 2);

  for (let row = 0; row < gridRows; row++) {
    for (let col = 0; col < gridCols; col++) {
      const histogram = new Uint32Array(256);
      let pixelCount = 0;

      for (let y = row * cellH; y < (row + 1) * cellH && y < info.height; y++) {
        for (let x = col * cellW; x < (col + 1) * cellW && x < info.width; x++) {
          const idx = y * info.width + x;
          histogram[data[idx]]++;
          pixelCount++;
        }
      }

      // Shannon entropy
      let entropy = 0;
      for (let i = 0; i < 256; i++) {
        if (histogram[i] > 0) {
          const p = histogram[i] / pixelCount;
          entropy -= p * Math.log2(p);
        }
      }

      if (entropy > maxEntropy) {
        maxEntropy = entropy;
        bestCol = col;
        bestRow = row;
      }
    }
  }

  // Convert grid cell to percentage position
  const posX = Math.round(((bestCol + 0.5) / gridCols) * 100);
  const posY = Math.round(((bestRow + 0.5) / gridRows) * 100);

  return {
    positionX: posX,
    positionY: posY,
    position: `${posX}% ${posY}%`
  };
}

/**
 * Full upload pipeline: HEIC convert → get dimensions → thumbnail → quality → crop.
 */
async function processUpload(buffer, originalName, printWidthIn = 16, printHeightIn = 20) {
  // HEIC conversion if needed
  let processedBuffer = buffer;
  let convertedFromHeic = false;

  if (isHeic(originalName)) {
    processedBuffer = await convertHeic(buffer);
    convertedFromHeic = true;
  }

  // Get dimensions
  const dimensions = await getDimensions(processedBuffer);

  // Generate thumbnail
  const thumbnailBuffer = await createThumbnail(processedBuffer);

  // Quality assessment
  const quality = assessQuality(
    dimensions.width, dimensions.height,
    printWidthIn, printHeightIn
  );

  // Smart crop analysis
  const crop = await analyzeCrop(processedBuffer);

  return {
    processedBuffer,
    thumbnailBuffer,
    dimensions,
    quality,
    crop,
    convertedFromHeic
  };
}

module.exports = {
  convertHeic,
  isHeic,
  createThumbnail,
  getDimensions,
  assessQuality,
  analyzeCrop,
  processUpload
};
