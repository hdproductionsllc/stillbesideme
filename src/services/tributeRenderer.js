/**
 * Tribute Renderer — shared core for proof and print-ready image generation.
 *
 * Provides: template loading, SVG text escaping, word-wrapping with linebreak
 * support, tribute panel SVG building, layout calculation, and order data
 * resolution. Both proofGenerator.js and printRenderer.js consume this module.
 */

const path = require('path');
const fs = require('fs');
const colorUtils = require('./colorUtils');

const TEMPLATES_DIR = path.join(__dirname, '..', 'data', 'templates');

// ─── Template Loading ────────────────────────────────────────────────

const templateCache = {};

function loadTemplate(templateId) {
  if (templateCache[templateId]) return templateCache[templateId];
  const filePath = path.join(TEMPLATES_DIR, `${templateId}.json`);
  if (!fs.existsSync(filePath)) return null;
  templateCache[templateId] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return templateCache[templateId];
}

// ─── SVG Utilities ───────────────────────────────────────────────────

function escSvg(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Word-wrap text, respecting explicit \n linebreaks.
 * Returns array of strings. Blank lines are represented as '' sentinels
 * so callers can insert vertical spacing.
 */
function wrapText(text, maxChars) {
  if (!text) return [];
  const results = [];
  const rawLines = text.split('\n');

  for (const rawLine of rawLines) {
    if (rawLine.trim() === '') {
      results.push(''); // blank-line sentinel
      continue;
    }
    const words = rawLine.split(/\s+/);
    let current = '';
    for (const word of words) {
      if (current.length + word.length + 1 > maxChars && current.length > 0) {
        results.push(current);
        current = word;
      } else {
        current = current ? current + ' ' + word : word;
      }
    }
    if (current) results.push(current);
  }
  return results;
}

// ─── Tribute SVG Builder ─────────────────────────────────────────────

/**
 * Build the tribute text panel as an SVG buffer.
 *
 * @param {object} opts
 * @param {number} opts.width    — Panel width in px
 * @param {number} opts.height   — Panel height in px
 * @param {object} opts.colors   — Tribute colors from styleVariant
 * @param {object} opts.tributeData — { name, nickname, birthDate, passDate, poemText, familyName, familyPrefix }
 * @param {string} opts.poemLabel — "Poem" or "Letter"
 * @returns {Buffer} SVG as a buffer for Sharp compositing
 */
function buildTributeSvg({ width, height, colors, tributeData, poemLabel }) {
  const { name, nickname, birthDate, passDate, poemText, familyName, familyPrefix } = tributeData;
  const padding = Math.round(width * 0.1);
  const innerW = width - padding * 2;

  // Font sizes relative to panel width
  const nameFontSize = Math.round(width * 0.065);
  const nicknameFontSize = Math.round(width * 0.03);
  const datesFontSize = Math.round(width * 0.028);
  const poemFontSize = Math.round(width * 0.028);
  const familyFontSize = Math.round(width * 0.026);
  const lineHeight = 1.55;

  // Content is built from y=0 and vertically centered afterwards via a
  // single <g> translate — keeps short poems from leaving dead space below.
  let y = 0;
  const elements = [];
  const maxContentH = height - Math.round(height * 0.12);

  // Name
  if (name) {
    y += nameFontSize;
    elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${nameFontSize}" fill="${escSvg(colors.name)}" font-weight="400">${escSvg(name)}</text>`);
    y += 10;
  }

  // Nickname
  if (nickname) {
    y += nicknameFontSize;
    elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${nicknameFontSize}" fill="${escSvg(colors.nickname)}" font-style="italic">"${escSvg(nickname)}"</text>`);
    y += 16;
  }

  // Dates
  const dates = [birthDate, passDate].filter(Boolean).join(' \u2014 ');
  if (dates) {
    y += datesFontSize;
    elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="sans-serif" font-size="${datesFontSize}" fill="${escSvg(colors.dates)}">${escSvg(dates)}</text>`);
    y += 20;
  }

  // Divider
  const dividerW = Math.round(innerW * 0.3);
  y += 10;
  elements.push(`<line x1="${(width - dividerW) / 2}" y1="${y}" x2="${(width + dividerW) / 2}" y2="${y}" stroke="${escSvg(colors.divider)}" stroke-width="2" />`);
  y += 30;

  // Poem text (line-break aware word wrapping)
  if (poemText) {
    const maxChars = Math.round(innerW / (poemFontSize * 0.5));
    const poemLines = wrapText(poemText, maxChars);
    const poemLineHeight = Math.round(poemFontSize * lineHeight);

    for (const line of poemLines) {
      if (y + poemLineHeight > maxContentH - 120) break; // leave room for family
      if (line === '') {
        y += Math.round(poemLineHeight * 0.6); // blank line spacing
        continue;
      }
      y += poemLineHeight;
      elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${poemFontSize}" fill="${escSvg(colors.poem)}" font-style="italic">${escSvg(line)}</text>`);
    }
    y += 16;
  }

  // Divider before family
  if (familyName) {
    const divW2 = Math.round(innerW * 0.15);
    elements.push(`<line x1="${(width - divW2) / 2}" y1="${y}" x2="${(width + divW2) / 2}" y2="${y}" stroke="${escSvg(colors.divider)}" stroke-width="1.5" />`);
    y += 24 + familyFontSize;

    const prefix = familyPrefix || 'Forever loved by';
    elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="sans-serif" font-size="${familyFontSize}" fill="${escSvg(colors.family)}">${escSvg(prefix)}</text>`);
    y += 8 + Math.round(familyFontSize * 1.15);
    elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${Math.round(familyFontSize * 1.15)}" fill="${escSvg(colors.family)}">${escSvg(familyName)}</text>`);
  }

  // Vertically center the content block (with a minimum top margin)
  const contentH = y;
  const offset = Math.max(Math.round(height * 0.05), Math.round((height - contentH) / 2));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="${escSvg(colors.background)}" />
  <g transform="translate(0, ${offset})">
  ${elements.join('\n  ')}
  </g>
</svg>`;

  return Buffer.from(svg);
}

// ─── Color Resolution ────────────────────────────────────────────────

/**
 * Resolve the full tribute color set for an order.
 *
 * Auto-color orders (fields.colors = { mat, bevel, text, tone }) get a
 * derived palette: text prints directly on the mat, the bevel color is
 * the accent (divider + poem), and secondary text is a text/mat blend.
 *
 * Legacy orders (and Letter From Heaven) fall through to styleVariants,
 * so in-flight orders render exactly as before.
 *
 * Returns a superset of the styleVariant.tribute shape, plus mat/bevel.
 */
function resolveColors(template, fields) {
  const c = fields && fields.colors;
  if (c && colorUtils.isHex(c.mat)) {
    const mat = c.mat;
    const bevel = colorUtils.isHex(c.bevel) ? c.bevel : '#C4A882';
    const tone = c.tone === 'light' ? 'light' : 'dark';
    const text = colorUtils.isHex(c.text)
      ? c.text
      : (tone === 'light' ? '#2C2420' : '#FAF8F5');
    const secondary = colorUtils.mix(text, mat, 0.45);

    return {
      background: mat,
      name: text,
      dates: secondary,
      divider: bevel,
      poem: bevel,
      nickname: secondary,
      family: secondary,
      mat,
      bevel,
      tone,
    };
  }

  // Legacy path: style variant lookup
  const style = (fields && fields.style) || template.defaultStyle || 'classic-dark';
  const styleVariant = template.styleVariants[style]
    || template.styleVariants['classic-dark']
    || Object.values(template.styleVariants)[0];
  return {
    ...styleVariant.tribute,
    mat: (styleVariant.mat && styleVariant.mat.color) || styleVariant.tribute.background,
    bevel: styleVariant.tribute.divider,
    tone: null,
  };
}

// ─── Printed Mat Geometry (UV-printed mat + bevel) ───────────────────

const DEFAULT_PRINT_SPEC = { matBorderIn: 1.5, gutterIn: 1.0, bevelWidthIn: 0.1 };
const PRINT_DPI = 300;

/**
 * Calculate photo/tribute openings inside a printed mat border.
 *
 * All measurements come from template.printSpec (inches) at 300 DPI,
 * scaled by dpiScale (1 for print files, <1 for display-size proofs).
 *
 * Landscape 11×14 at print scale: canvas 4200×3300, 1.5" border (450px),
 * 1" gutter (300px) → photo opening 450,450,1500×2400; tribute 2250,450,1500×2400.
 */
function calculateMatLayout(layout, totalW, totalH, printSpec, dpiScale = 1) {
  const spec = { ...DEFAULT_PRINT_SPEC, ...(printSpec || {}) };
  const border = Math.round(spec.matBorderIn * PRINT_DPI * dpiScale);
  const gutter = Math.round(spec.gutterIn * PRINT_DPI * dpiScale);
  const bevelWidth = Math.max(2, Math.round(spec.bevelWidthIn * PRINT_DPI * dpiScale));

  const innerW = totalW - border * 2;
  const innerH = totalH - border * 2;

  let photo, tribute;
  if (isLandscapeLayout(layout)) {
    const colW = Math.round((innerW - gutter) / 2);
    photo = { left: border, top: border, width: colW, height: innerH };
    tribute = { left: border + colW + gutter, top: border, width: innerW - colW - gutter, height: innerH };
  } else {
    const rowH = Math.round((innerH - gutter) / 2);
    photo = { left: border, top: border, width: innerW, height: rowH };
    tribute = { left: border, top: border + rowH + gutter, width: innerW, height: innerH - rowH - gutter };
  }

  return { photo, tribute, panel2: null, bevelWidth };
}

/**
 * Build a transparent full-canvas SVG with a bevel ring hugging the outer
 * edge of each opening. Composited LAST so it sits on top of the photo
 * and tribute panels.
 */
function buildMatOverlaySvg({ width, height, openings, bevelColor, bevelWidth }) {
  const rects = openings
    .filter(Boolean)
    .map(o =>
      `<rect x="${o.left - bevelWidth / 2}" y="${o.top - bevelWidth / 2}" ` +
      `width="${o.width + bevelWidth}" height="${o.height + bevelWidth}" ` +
      `fill="none" stroke="${escSvg(bevelColor)}" stroke-width="${bevelWidth}" />`
    )
    .join('\n  ');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  ${rects}
</svg>`;
  return Buffer.from(svg);
}

// ─── Photo Rendering ─────────────────────────────────────────────────

const sharp = require('sharp');

/**
 * Cover-fit a photo into a region, honoring smart-crop positions.
 *
 * crop positions from imageProcessor.analyzeCrop are percent strings
 * ("50% 50%") which sharp's `position` option does NOT accept — we
 * compute the extract region manually. Plain gravity strings
 * ('centre', 'north', …) pass straight through to sharp.
 *
 * @param {string} photoPath
 * @param {{width:number,height:number}} region
 * @param {string} [cropPosition]
 * @param {number} [jpegQuality] — when set, output is JPEG at this quality
 */
async function renderPhotoCover(photoPath, region, cropPosition, jpegQuality) {
  const finish = (pipeline) =>
    (jpegQuality ? pipeline.jpeg({ quality: jpegQuality }) : pipeline).toBuffer();

  const pctMatch = typeof cropPosition === 'string'
    && cropPosition.match(/^(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);

  if (!pctMatch) {
    return finish(sharp(photoPath).resize(region.width, region.height, {
      fit: 'cover',
      position: cropPosition || 'centre',
    }));
  }

  const px = Math.max(0, Math.min(1, parseFloat(pctMatch[1]) / 100));
  const py = Math.max(0, Math.min(1, parseFloat(pctMatch[2]) / 100));

  const meta = await sharp(photoPath).metadata();
  const scale = Math.max(region.width / meta.width, region.height / meta.height);
  const cropW = Math.min(meta.width, Math.round(region.width / scale));
  const cropH = Math.min(meta.height, Math.round(region.height / scale));
  const left = Math.max(0, Math.min(meta.width - cropW, Math.round((meta.width - cropW) * px)));
  const top = Math.max(0, Math.min(meta.height - cropH, Math.round((meta.height - cropH) * py)));

  return finish(
    sharp(photoPath)
      .extract({ left, top, width: cropW, height: cropH })
      .resize(region.width, region.height)
  );
}

// ─── Layout Definitions ──────────────────────────────────────────────

const LANDSCAPE_LAYOUTS = ['side-by-side', 'hero-left', 'photos-left'];

/**
 * Returns true if a layout renders in landscape orientation.
 */
function isLandscapeLayout(layout) {
  return LANDSCAPE_LAYOUTS.includes(layout);
}

// ─── Layout Calculation ──────────────────────────────────────────────

/**
 * Calculate panel positions for all 6 layouts.
 *
 * Returns named regions — each with { left, top, width, height }.
 * `panel2` is null for 2-panel layouts (side-by-side, stacked).
 *
 * @param {string} layout
 * @param {number} totalW
 * @param {number} totalH
 * @returns {{ photo: Region, tribute: Region, panel2: Region|null }}
 */
function calculateLayout(layout, totalW, totalH) {
  switch (layout) {

    // ── 2-panel layouts ──────────────────────────────────────────

    case 'side-by-side': {
      // columns [1, 1] — photo left, tribute right
      const colW = Math.round(totalW * 0.5);
      return {
        photo:   { left: 0,    top: 0, width: colW,            height: totalH },
        tribute: { left: colW, top: 0, width: totalW - colW,   height: totalH },
        panel2:  null,
      };
    }

    case 'stacked': {
      // rows [1, 1] — photo top, tribute bottom
      const rowH = Math.round(totalH * 0.5);
      return {
        photo:   { left: 0, top: 0,    width: totalW, height: rowH },
        tribute: { left: 0, top: rowH, width: totalW, height: totalH - rowH },
        panel2:  null,
      };
    }

    // ── 3-panel layouts ──────────────────────────────────────────

    case 'hero-left': {
      // columns [1.15, 1], rows [1, 1]
      // photo spans full left column; panel2 top-right, tribute bottom-right
      const leftW = Math.round(totalW * (1.15 / 2.15));
      const rightW = totalW - leftW;
      const topH = Math.round(totalH * 0.5);
      const bottomH = totalH - topH;
      return {
        photo:   { left: 0,     top: 0,    width: leftW,  height: totalH },
        panel2:  { left: leftW, top: 0,    width: rightW, height: topH },
        tribute: { left: leftW, top: topH, width: rightW, height: bottomH },
      };
    }

    case 'hero-top': {
      // columns [1, 1], rows [1.3, 1]
      // photo spans full top row; panel2 bottom-left, tribute bottom-right
      const topH = Math.round(totalH * (1.3 / 2.3));
      const bottomH = totalH - topH;
      const leftW = Math.round(totalW * 0.5);
      const rightW = totalW - leftW;
      return {
        photo:   { left: 0,     top: 0,    width: totalW, height: topH },
        panel2:  { left: 0,     top: topH, width: leftW,  height: bottomH },
        tribute: { left: leftW, top: topH, width: rightW, height: bottomH },
      };
    }

    case 'photos-left': {
      // columns [1, 1.15], rows [1, 1]
      // photo top-left, panel2 bottom-left; tribute spans full right column
      const leftW = Math.round(totalW * (1 / 2.15));
      const rightW = totalW - leftW;
      const topH = Math.round(totalH * 0.5);
      const bottomH = totalH - topH;
      return {
        photo:   { left: 0,     top: 0,    width: leftW,  height: topH },
        panel2:  { left: 0,     top: topH, width: leftW,  height: bottomH },
        tribute: { left: leftW, top: 0,    width: rightW, height: totalH },
      };
    }

    case 'tribute-top': {
      // columns [1, 1], rows [1, 1.3]
      // tribute spans full top row; photo bottom-left, panel2 bottom-right
      const topH = Math.round(totalH * (1 / 2.3));
      const bottomH = totalH - topH;
      const leftW = Math.round(totalW * 0.5);
      const rightW = totalW - leftW;
      return {
        photo:   { left: 0,     top: topH, width: leftW,  height: bottomH },
        panel2:  { left: leftW, top: topH, width: rightW, height: bottomH },
        tribute: { left: 0,     top: 0,    width: totalW, height: topH },
      };
    }

    default:
      // Fall back to side-by-side
      return calculateLayout('side-by-side', totalW, totalH);
  }
}

// ─── Order Data Resolution ───────────────────────────────────────────

const UPLOADS_ROOT = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');

/**
 * Parse all rendering data from an order row + its template.
 * Consolidates the scattered JSON parsing that was duplicated across generators.
 */
function resolveOrderData(order) {
  const template = loadTemplate(order.template_id);
  if (!template) throw new Error(`Template not found: ${order.template_id}`);

  const fields = order.fields_json ? JSON.parse(order.fields_json) : {};
  const photos = order.photos_json ? JSON.parse(order.photos_json) : {};
  const style = fields.style || template.defaultStyle || 'classic-dark';
  const layout = fields.layout || template.defaultLayout || 'side-by-side';
  const styleVariant = template.styleVariants[style] || template.styleVariants['classic-dark'];
  // Per-order colors (auto-matched mat/bevel) or legacy style variant colors
  const tributeColors = resolveColors(template, fields);
  // True when this order carries auto-matched colors → printed mat + bevel render path
  const hasPrintedMat = !!(fields.colors && colorUtils.isHex(fields.colors.mat));
  const mapping = template.tributeMapping || {};

  const tributeData = {
    name: fields[mapping.name] || '',
    nickname: fields[mapping.nickname] || '',
    birthDate: fields[mapping.birthDate] || '',
    passDate: fields[mapping.passDate] || '',
    poemText: order.poem_text || '',
    familyName: fields[mapping.familyName] || '',
    familyPrefix: mapping.familyPrefix || 'Forever loved by',
  };

  // Resolve main photo path
  const mainPhoto = photos.main || Object.values(photos)[0];
  if (!mainPhoto) throw new Error('No photo found for order');

  const photoPath = path.join(UPLOADS_ROOT, mainPhoto.originalPath || mainPhoto.relativePath || '');

  // Resolve second photo (for 3-panel layouts)
  const panel2Photo = photos.panel2 || null;
  const panel2Path = panel2Photo
    ? path.join(UPLOADS_ROOT, panel2Photo.originalPath || panel2Photo.relativePath || '')
    : null;

  return {
    template,
    fields,
    photos,
    style,
    layout,
    styleVariant,
    tributeColors,
    hasPrintedMat,
    printSpec: template.printSpec || null,
    tributeData,
    mainPhoto,
    photoPath,
    panel2Photo,
    panel2Path,
    poemLabel: template.poemLabel || 'Poem',
  };
}

module.exports = {
  loadTemplate,
  escSvg,
  wrapText,
  buildTributeSvg,
  isLandscapeLayout,
  calculateLayout,
  calculateMatLayout,
  buildMatOverlaySvg,
  resolveColors,
  renderPhotoCover,
  resolveOrderData,
};
