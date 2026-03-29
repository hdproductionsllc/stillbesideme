/**
 * Tribute Renderer — shared core for proof and print-ready image generation.
 *
 * Provides: template loading, SVG text escaping, word-wrapping with linebreak
 * support, tribute panel SVG building, layout calculation, and order data
 * resolution. Both proofGenerator.js and printRenderer.js consume this module.
 */

const path = require('path');
const fs = require('fs');

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

  let y = Math.round(height * 0.1);
  const elements = [];

  // Name
  if (name) {
    elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${nameFontSize}" fill="${escSvg(colors.name)}" font-weight="400">${escSvg(name)}</text>`);
    y += nameFontSize + 10;
  }

  // Nickname
  if (nickname) {
    elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${nicknameFontSize}" fill="${escSvg(colors.nickname)}" font-style="italic">"${escSvg(nickname)}"</text>`);
    y += nicknameFontSize + 16;
  }

  // Dates
  const dates = [birthDate, passDate].filter(Boolean).join(' \u2014 ');
  if (dates) {
    elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="sans-serif" font-size="${datesFontSize}" fill="${escSvg(colors.dates)}">${escSvg(dates)}</text>`);
    y += datesFontSize + 20;
  }

  // Divider
  const dividerW = Math.round(innerW * 0.3);
  elements.push(`<line x1="${(width - dividerW) / 2}" y1="${y}" x2="${(width + dividerW) / 2}" y2="${y}" stroke="${escSvg(colors.divider)}" stroke-width="2" />`);
  y += 30;

  // Poem text (line-break aware word wrapping)
  if (poemText) {
    const maxChars = Math.round(innerW / (poemFontSize * 0.5));
    const poemLines = wrapText(poemText, maxChars);
    const poemLineHeight = Math.round(poemFontSize * lineHeight);

    for (const line of poemLines) {
      if (y + poemLineHeight > height - 120) break; // leave room for family
      if (line === '') {
        y += Math.round(poemLineHeight * 0.6); // blank line spacing
        continue;
      }
      elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${poemFontSize}" fill="${escSvg(colors.poem)}" font-style="italic">${escSvg(line)}</text>`);
      y += poemLineHeight;
    }
    y += 16;
  }

  // Divider before family
  if (familyName) {
    const divW2 = Math.round(innerW * 0.15);
    elements.push(`<line x1="${(width - divW2) / 2}" y1="${y}" x2="${(width + divW2) / 2}" y2="${y}" stroke="${escSvg(colors.divider)}" stroke-width="1.5" />`);
    y += 24;

    const prefix = familyPrefix || 'Forever loved by';
    elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="sans-serif" font-size="${familyFontSize}" fill="${escSvg(colors.family)}">${escSvg(prefix)}</text>`);
    y += familyFontSize + 8;
    elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${Math.round(familyFontSize * 1.15)}" fill="${escSvg(colors.family)}">${escSvg(familyName)}</text>`);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="${escSvg(colors.background)}" />
  ${elements.join('\n  ')}
</svg>`;

  return Buffer.from(svg);
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
  const tributeColors = styleVariant.tribute;
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
  resolveOrderData,
};
