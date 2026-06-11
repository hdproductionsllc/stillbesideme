/**
 * Image Processor – HEIC conversion, thumbnails, quality assessment, smart crop.
 *
 * Quality tiers use warm language because these are memorial photos.
 * We NEVER reject a photo.
 */

const sharp = require('sharp');
const path = require('path');
const colorUtils = require('./colorUtils');

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
 * 4-tier quality assessment – warm messages, NEVER reject.
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
    message: 'This photo is quite small and may appear soft when printed at this size. It will still be meaningful – would you like to try a smaller print size for better quality?',
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

// ── Palette Extraction (for auto-matched mat & bevel colors) ──────────

const BRAND_GOLD = '#C4A882';

/**
 * Extract a 5-swatch color palette from an image buffer.
 * Downscales to ≤64px and runs median-cut quantization (no extra deps).
 *
 * @returns {Array<{ hex: string, population: number, h: number, s: number, l: number }>}
 *          sorted by population (most dominant first)
 */
async function extractPalette(buffer) {
  const { data, info } = await sharp(buffer)
    .resize(64, 64, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Collect pixels as [r, g, b]
  const pixels = [];
  for (let i = 0; i < data.length; i += info.channels) {
    pixels.push([data[i], data[i + 1], data[i + 2]]);
  }

  // Median-cut: split the box with the largest channel range until we have 5
  const boxes = [pixels];
  while (boxes.length < 5) {
    // Pick the box with the most pixels that can still be split
    boxes.sort((a, b) => b.length - a.length);
    const box = boxes.shift();
    if (!box || box.length < 2) {
      if (box) boxes.push(box);
      break;
    }

    // Find channel with greatest range
    let bestChannel = 0;
    let bestRange = -1;
    for (let ch = 0; ch < 3; ch++) {
      let min = 255, max = 0;
      for (const p of box) {
        if (p[ch] < min) min = p[ch];
        if (p[ch] > max) max = p[ch];
      }
      if (max - min > bestRange) {
        bestRange = max - min;
        bestChannel = ch;
      }
    }

    box.sort((a, b) => a[bestChannel] - b[bestChannel]);
    const mid = Math.floor(box.length / 2);
    boxes.push(box.slice(0, mid), box.slice(mid));
  }

  // Average each box into a swatch
  const swatches = boxes
    .filter(box => box.length > 0)
    .map(box => {
      let r = 0, g = 0, b = 0;
      for (const p of box) { r += p[0]; g += p[1]; b += p[2]; }
      const n = box.length;
      const hex = colorUtils.rgbToHex({ r: r / n, g: g / n, b: b / n });
      const { h, s, l } = colorUtils.hexToHsl(hex);
      return { hex, population: n, h, s, l };
    })
    .sort((a, b) => b.population - a.population);

  return swatches;
}

/**
 * Derive print colors (mat, bevel, text, tone) from a palette.
 *
 * - tone: dark mat by default; light only for bright/high-key photos
 * - mat: dominant swatch, heavily desaturated, lightness clamped
 * - bevel: most saturated swatch, boosted; brand gold for monochrome photos
 * - text: cream on dark / charcoal on light, contrast-checked against the mat
 */
function deriveAutoColors(swatches) {
  if (!swatches || swatches.length === 0) {
    return { mat: '#1a1a1a', bevel: BRAND_GOLD, text: '#FAF8F5', tone: 'dark' };
  }

  const totalPop = swatches.reduce((sum, s) => sum + s.population, 0);
  const avgLum = swatches.reduce(
    (sum, s) => sum + colorUtils.luminance(s.hex) * s.population, 0
  ) / totalPop;
  const tone = avgLum > 0.55 ? 'light' : 'dark';

  // Mat: dominant swatch, desaturated, clamped to a deep or pale tint
  const dominant = swatches[0];
  const matL = tone === 'dark'
    ? Math.max(0.10, Math.min(0.16, dominant.l * 0.35))
    : Math.max(0.90, Math.min(0.95, 0.85 + dominant.l * 0.1));
  const mat = colorUtils.hslToHex({ h: dominant.h, s: dominant.s * 0.3, l: matL });

  // Bevel: most saturated swatch with real color; brand gold fallback for B&W.
  // Saturation is clamped to a muted band (~the brand gold's s≈0.36) so the
  // accent reads elegant on a memorial piece, never neon.
  const vivid = [...swatches].sort((a, b) => b.s - a.s)[0];
  const bevel = (vivid && vivid.s >= 0.25)
    ? colorUtils.hslToHex({
        h: vivid.h,
        s: Math.max(0.3, Math.min(0.45, vivid.s)),
        l: Math.max(0.5, Math.min(0.65, vivid.l)),
      })
    : BRAND_GOLD;

  // Text: warm cream or charcoal, gently tinted toward the bevel hue
  let text = tone === 'dark'
    ? colorUtils.mix('#FAF8F5', bevel, 0.08)
    : colorUtils.mix('#2C2420', bevel, 0.08);
  if (colorUtils.contrast(text, mat) < 4.5) {
    text = tone === 'dark' ? '#FAF8F5' : '#2C2420';
  }

  return { mat, bevel, text, tone };
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

  // Color palette → auto-matched mat/bevel colors.
  // Never fail an upload over color extraction — fall back to defaults.
  let palette = null;
  try {
    const swatches = await extractPalette(processedBuffer);
    palette = {
      swatches: swatches.map(s => ({ hex: s.hex, population: s.population })),
      auto: deriveAutoColors(swatches)
    };
  } catch (err) {
    console.error('Palette extraction failed (using defaults):', err.message);
    palette = {
      swatches: [],
      auto: { mat: '#1a1a1a', bevel: BRAND_GOLD, text: '#FAF8F5', tone: 'dark' }
    };
  }

  return {
    processedBuffer,
    thumbnailBuffer,
    dimensions,
    quality,
    crop,
    palette,
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
  extractPalette,
  deriveAutoColors,
  processUpload
};
