/**
 * Proof Generator – builds a proof image from order data using Sharp.
 *
 * Composites: customer photo + tribute text panel (rendered as SVG) with a
 * "PROOF" watermark overlay. Output is a JPEG saved to output/proofs/.
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const UPLOADS_ROOT = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
const OUTPUT_ROOT = process.env.OUTPUT_DIR || path.join(__dirname, '..', '..', 'output');
const PROOFS_DIR = path.join(OUTPUT_ROOT, 'proofs');
const TEMPLATES_DIR = path.join(__dirname, '..', 'data', 'templates');

// Ensure proofs directory exists
if (!fs.existsSync(PROOFS_DIR)) {
  fs.mkdirSync(PROOFS_DIR, { recursive: true });
}

/** Load template JSON (cached). */
const templateCache = {};
function loadTemplate(templateId) {
  if (templateCache[templateId]) return templateCache[templateId];
  const filePath = path.join(TEMPLATES_DIR, `${templateId}.json`);
  if (!fs.existsSync(filePath)) return null;
  templateCache[templateId] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return templateCache[templateId];
}

/** Escape text for safe embedding in SVG markup. */
function escSvg(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Word-wrap text to fit within a max character width.
 * Returns array of lines.
 */
function wrapText(text, maxChars) {
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';

  for (const word of words) {
    if (current.length + word.length + 1 > maxChars && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Build the tribute panel as an SVG buffer.
 *
 * @param {object} opts
 * @param {number} opts.width - Panel width in px
 * @param {number} opts.height - Panel height in px
 * @param {object} opts.colors - tribute colors from styleVariant
 * @param {object} opts.tributeData - { name, nickname, birthDate, passDate, poemText, familyName, familyPrefix }
 * @param {string} opts.poemLabel - "Poem" or "Letter"
 * @returns {Buffer} SVG as a buffer for Sharp compositing
 */
function buildTributeSvg({ width, height, colors, tributeData, poemLabel }) {
  const { name, nickname, birthDate, passDate, poemText, familyName, familyPrefix } = tributeData;
  const padding = Math.round(width * 0.1);
  const innerW = width - padding * 2;

  // Font sizes relative to panel width
  const nameFontSize = Math.round(width * 0.07);
  const datesFontSize = Math.round(width * 0.032);
  const poemFontSize = Math.round(width * 0.033);
  const familyFontSize = Math.round(width * 0.03);
  const lineHeight = 1.5;

  let y = Math.round(height * 0.12); // start position
  const elements = [];

  // Name
  if (name) {
    elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Georgia, serif" font-size="${nameFontSize}" fill="${escSvg(colors.name)}" font-weight="400">${escSvg(name)}</text>`);
    y += nameFontSize + 8;
  }

  // Nickname
  if (nickname) {
    elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Georgia, serif" font-size="${datesFontSize}" fill="${escSvg(colors.nickname)}" font-style="italic">"${escSvg(nickname)}"</text>`);
    y += datesFontSize + 12;
  }

  // Dates
  const dates = [birthDate, passDate].filter(Boolean).join(' — ');
  if (dates) {
    elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="sans-serif" font-size="${datesFontSize}" fill="${escSvg(colors.dates)}">${escSvg(dates)}</text>`);
    y += datesFontSize + 16;
  }

  // Divider
  const dividerW = Math.round(innerW * 0.3);
  elements.push(`<line x1="${(width - dividerW) / 2}" y1="${y}" x2="${(width + dividerW) / 2}" y2="${y}" stroke="${escSvg(colors.divider)}" stroke-width="1.5" />`);
  y += 24;

  // Poem text (word-wrapped)
  if (poemText) {
    const maxChars = Math.round(innerW / (poemFontSize * 0.52));
    const poemLines = wrapText(poemText, maxChars);
    const poemLineHeight = Math.round(poemFontSize * lineHeight);

    for (const line of poemLines) {
      if (y + poemLineHeight > height - 80) break; // leave room for family line
      elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Georgia, serif" font-size="${poemFontSize}" fill="${escSvg(colors.poem)}" font-style="italic">${escSvg(line)}</text>`);
      y += poemLineHeight;
    }
    y += 16;
  }

  // Divider before family
  if (familyName) {
    const divW2 = Math.round(innerW * 0.15);
    elements.push(`<line x1="${(width - divW2) / 2}" y1="${y}" x2="${(width + divW2) / 2}" y2="${y}" stroke="${escSvg(colors.divider)}" stroke-width="1" />`);
    y += 20;

    // Family prefix + name
    const prefix = familyPrefix || 'Forever loved by';
    elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="sans-serif" font-size="${familyFontSize}" fill="${escSvg(colors.family)}">${escSvg(prefix)}</text>`);
    y += familyFontSize + 6;
    elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Georgia, serif" font-size="${Math.round(familyFontSize * 1.15)}" fill="${escSvg(colors.family)}">${escSvg(familyName)}</text>`);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="${escSvg(colors.background)}" />
  ${elements.join('\n  ')}
</svg>`;

  return Buffer.from(svg);
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
 * Generate a proof image for an order.
 *
 * @param {object} order - Full order row from DB
 * @returns {{ proofPath: string, proofRelativeUrl: string }} saved file paths
 */
async function generateProof(order) {
  const template = loadTemplate(order.template_id);
  if (!template) throw new Error(`Template not found: ${order.template_id}`);

  const fields = order.fields_json ? JSON.parse(order.fields_json) : {};
  const photos = order.photos_json ? JSON.parse(order.photos_json) : {};
  const style = fields.style || template.defaultStyle || 'classic-dark';
  const layout = fields.layout || template.defaultLayout || 'side-by-side';
  const styleVariant = template.styleVariants[style] || template.styleVariants['classic-dark'];
  const tributeColors = styleVariant.tribute;
  const mapping = template.tributeMapping || {};

  // Resolve tribute data from fields using template mapping
  const tributeData = {
    name: fields[mapping.name] || '',
    nickname: fields[mapping.nickname] || '',
    birthDate: fields[mapping.birthDate] || '',
    passDate: fields[mapping.passDate] || '',
    poemText: order.poem_text || '',
    familyName: fields[mapping.familyName] || '',
    familyPrefix: mapping.familyPrefix || 'Forever loved by',
  };

  // Determine layout dimensions (proof-size, not print-size)
  const isLandscape = ['side-by-side'].includes(layout);
  const totalW = isLandscape ? 1600 : 1000;
  const totalH = isLandscape ? 1000 : 1600;

  // Panel dimensions
  let photoW, photoH, tributeW, tributeH, photoLeft, photoTop, tributeLeft, tributeTop;

  if (isLandscape) {
    // Side-by-side: photo left, tribute right
    photoW = Math.round(totalW * 0.5);
    photoH = totalH;
    tributeW = totalW - photoW;
    tributeH = totalH;
    photoLeft = 0;
    photoTop = 0;
    tributeLeft = photoW;
    tributeTop = 0;
  } else {
    // Stacked: photo top, tribute bottom
    photoW = totalW;
    photoH = Math.round(totalH * 0.5);
    tributeW = totalW;
    tributeH = totalH - photoH;
    photoLeft = 0;
    photoTop = 0;
    tributeLeft = 0;
    tributeTop = photoH;
  }

  // Load and crop the main customer photo
  const mainPhoto = photos.main || Object.values(photos)[0];
  if (!mainPhoto) throw new Error('No photo found for proof generation');

  const photoPath = path.join(UPLOADS_ROOT, mainPhoto.originalPath || mainPhoto.relativePath || '');
  if (!fs.existsSync(photoPath)) throw new Error(`Photo not found: ${photoPath}`);

  const photoBuffer = await sharp(photoPath)
    .resize(photoW, photoH, { fit: 'cover', position: mainPhoto.crop?.position || 'centre' })
    .jpeg({ quality: 90 })
    .toBuffer();

  // Build tribute SVG
  const tributeSvg = buildTributeSvg({
    width: tributeW,
    height: tributeH,
    colors: tributeColors,
    tributeData,
    poemLabel: template.poemLabel || 'Poem',
  });

  // Build watermark
  const watermarkSvg = buildWatermarkSvg(totalW, totalH);

  // Composite everything
  const background = tributeColors.background || '#1a1a1a';
  const proofBuffer = await sharp({
    create: { width: totalW, height: totalH, channels: 3, background },
  })
    .composite([
      { input: photoBuffer, left: photoLeft, top: photoTop },
      { input: tributeSvg, left: tributeLeft, top: tributeTop },
      { input: watermarkSvg, left: 0, top: 0 },
    ])
    .jpeg({ quality: 85 })
    .toBuffer();

  // Save to output/proofs/
  const proofFilename = `${order.id}.jpg`;
  const proofPath = path.join(PROOFS_DIR, proofFilename);
  fs.writeFileSync(proofPath, proofBuffer);

  const proofRelativeUrl = `/output/proofs/${proofFilename}`;

  console.log(`Proof generated: ${proofRelativeUrl} (${totalW}x${totalH})`);

  return { proofPath, proofRelativeUrl };
}

module.exports = { generateProof };
