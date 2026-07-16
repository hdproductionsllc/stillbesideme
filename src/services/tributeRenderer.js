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

// Sharp rasterizes our SVGs through fontconfig. Point it at the vendored
// Cormorant Garamond files so print/proof text renders in the exact typeface
// the customizer preview shows — on any host. (Railway's containers ship no
// Georgia, so the old stack silently fell back to a generic serif.)
// Must be set before Sharp's first render; every render path requires this
// module first, so this is the one reliable place.
if (!process.env.FONTCONFIG_PATH) {
  process.env.FONTCONFIG_PATH = path.join(__dirname, '..', 'assets', 'fonts');
}

const TEMPLATES_DIR = path.join(__dirname, '..', 'data', 'templates');

// Every renderer writes its output under the same root — on Railway this is the
// mounted volume (OUTPUT_DIR=/data/output), so all artifacts persist together.
const OUTPUT_ROOT = process.env.OUTPUT_DIR || path.join(__dirname, '..', '..', 'output');

// The typeface the customizer preview uses — vendored in src/assets/fonts.
const FONT_SERIF = "'Cormorant Garamond', Georgia, serif";

// The light "paper insert" palette the customizer preview shows for
// colorMode:"auto" templates (mirrors preview.js setColors — keep in sync).
// Cream paper, deep near-espresso ink for strong readability, warm gold accent.
// (The ink was lightened toward brown before; darkened here so the text reads
// crisply against the cream, and the secondary lines aren't washed out.)
const PAPER_INK = '#14100C';
const PAPER_BG = '#FAF7F2';
const PAPER_PALETTE = Object.freeze({
  background: PAPER_BG,
  name: PAPER_INK,
  dates: colorUtils.mix(PAPER_INK, PAPER_BG, 0.08),
  divider: '#B8975E',
  poem: PAPER_INK,
  nickname: colorUtils.mix(PAPER_INK, PAPER_BG, 0.1),
  family: colorUtils.mix(PAPER_INK, PAPER_BG, 0.18),
  mat: PAPER_BG,
  bevel: '#B8975E',
  tone: 'light',
});

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
 * Greedy pack: fill each line up to `limit` (measured in characters).
 */
function greedyPack(words, limit) {
  const lines = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? cur + ' ' + word : word;
    if (cur && test.length > limit) {
      lines.push(cur);
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Balance one authored line into the FEWEST lines that fit `limit`, with the
 * break near the middle so no line is left a lone orphan word (the same idea
 * as CSS `text-wrap: balance`). Balancing keeps the minimum line count, so it
 * never makes the block taller.
 *
 * NOTE: mirrors greedyPack/balanceLine in public/js/preview.js (the canvas
 * preview path). Keep the two algorithms in sync.
 */
function balanceLine(words, limit) {
  if (words.join(' ').length <= limit) return [words.join(' ')];

  const need = greedyPack(words, limit).length;

  let lo = 0;
  for (const w of words) lo = Math.max(lo, w.length);
  let hi = limit;

  // Smallest width that still packs into `need` lines → balanced lines.
  for (let iter = 0; iter < 24 && hi - lo > 0.5; iter++) {
    const mid = (lo + hi) / 2;
    if (greedyPack(words, mid).length <= need) hi = mid;
    else lo = mid;
  }
  return greedyPack(words, hi);
}

/**
 * Word-wrap text, respecting explicit \n linebreaks. Over-wide authored lines
 * are balanced (no orphan words). Blank lines become '' sentinels so callers
 * can insert vertical spacing.
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
    for (const line of balanceLine(words, maxChars)) results.push(line);
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
  const poemFontSize = Math.round(width * 0.032);
  const familyFontSize = Math.round(width * 0.026);
  const lineHeight = 1.55;

  // Footer rhythm — proportional to width so the proof (small) and the 300 DPI
  // print render the SAME relative spacing. Fixed-pixel gaps here made the
  // nickname crowd the poem at print scale and diverge between the two sizes.
  // These are used in BOTH the reserve calc and the draw, so they can't drift.
  const poemToFooterGap = Math.round(width * 0.05);   // poem's last line → footer divider
  const footerLineGap = Math.round(width * 0.024);    // divider → first footer line
  const dividerStroke = Math.max(1, Math.round(width * 0.0016));

  // Content is built from y=0 and vertically centered afterwards via a
  // single <g> translate — keeps short poems from leaving dead space below.
  let y = 0;
  const elements = [];
  const maxContentH = height - Math.round(height * 0.12);

  // Header mirrors the preview: name, dates, divider. The nickname lives in
  // the footer (with the family line), exactly where the preview draws it.

  // Header spacing is proportional to the name size (mirrors the preview's
  // nameSize*1.2 / dateSize*1.6 rhythm) \u2014 a fixed pixel gap here crowded the
  // dates against the name at print scale, where the name is ~136px tall.

  // Name
  if (name) {
    y += nameFontSize;
    elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="${FONT_SERIF}" font-size="${nameFontSize}" fill="${escSvg(colors.name)}" font-weight="500">${escSvg(name)}</text>`);
    y += Math.round(nameFontSize * 0.34); // clears the name's descenders + breathing room
  }

  // Dates
  const dates = [birthDate, passDate].filter(Boolean).join(' \u2013 ');
  if (dates) {
    y += datesFontSize;
    elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="${FONT_SERIF}" font-size="${datesFontSize}" fill="${escSvg(colors.dates)}" font-weight="300">${escSvg(dates)}</text>`);
    y += Math.round(datesFontSize * 0.7);
  }

  // Divider
  const dividerW = Math.round(innerW * 0.3);
  y += Math.round(datesFontSize * 0.35);
  elements.push(`<line x1="${(width - dividerW) / 2}" y1="${y}" x2="${(width + dividerW) / 2}" y2="${y}" stroke="${escSvg(colors.divider)}" stroke-width="${dividerStroke}" />`);
  y += Math.round(nameFontSize * 0.32);

  // Poem text (line-break aware, balanced word wrapping).
  //
  // The poem is fit to the space that is actually left BELOW the header and
  // ABOVE the family block, then every line is drawn — the tribute is never
  // truncated (the old code dropped whatever lines ran past the bottom, which
  // clipped longer letters in portrait). We hold the poem at full size when it
  // fits and shrink the font only as far as needed, down to a legible floor.
  if (poemText) {
    // Height the footer block below the poem will consume (so we reserve it):
    // divider, optional nickname line, optional family line.
    const familyReserve = (nickname || familyName)
      ? poemToFooterGap
        + (nickname ? footerLineGap + nicknameFontSize : 0)
        + (familyName ? (nickname ? Math.round(nicknameFontSize * 0.9) : footerLineGap) + familyFontSize : 0)
        + Math.round(familyFontSize * 0.4)
      : 0;
    const poemAvailH = maxContentH - y - familyReserve;

    // Measure the wrapped poem at a candidate font size.
    const measurePoem = (fontSize) => {
      const maxChars = Math.max(8, Math.round(innerW / (fontSize * 0.5)));
      const lines = wrapText(poemText, maxChars);
      const lh = Math.round(fontSize * lineHeight);
      let total = 0;
      for (const line of lines) total += line === '' ? Math.round(lh * 0.6) : lh;
      return { lines, lh, total };
    };

    // Largest font (down to a floor) whose full text fits the available space.
    // The floor must be low enough that the poem can ALWAYS shrink to fit — in
    // portrait the tribute panel is wide-but-short, and a floor of ~0.017·w was
    // too high, so a medium+ poem overflowed and the frame clipped the footer
    // (nickname/family). At ~0.009·w the full tribute always fits; landscape
    // panels are tall so they never reach this floor and keep their larger size.
    const floorFont = Math.max(8, Math.round(width * 0.009));
    let fit = measurePoem(poemFontSize);
    let poemSize = poemFontSize;
    for (let fs = poemFontSize; fs >= floorFont; fs -= 1) {
      const m = measurePoem(fs);
      fit = m;
      poemSize = fs;
      if (m.total <= poemAvailH) break;
    }

    for (const line of fit.lines) {
      if (line === '') {
        y += Math.round(fit.lh * 0.6); // blank line spacing
        continue;
      }
      y += fit.lh;
      elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="${FONT_SERIF}" font-size="${poemSize}" fill="${escSvg(colors.poem)}" font-weight="500">${escSvg(line)}</text>`);
    }
    y += poemToFooterGap;
  }

  // Footer mirrors the preview: divider, then the nickname in quotes, then
  // the family line as a single italic sentence ("Beloved companion of the
  // Smith family") — not the old stacked prefix/name pair.
  if (nickname || familyName) {
    const divW2 = Math.round(innerW * 0.15);
    elements.push(`<line x1="${(width - divW2) / 2}" y1="${y}" x2="${(width + divW2) / 2}" y2="${y}" stroke="${escSvg(colors.divider)}" stroke-width="${dividerStroke}" />`);

    if (nickname) {
      y += footerLineGap + nicknameFontSize;
      elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="${FONT_SERIF}" font-size="${nicknameFontSize}" fill="${escSvg(colors.nickname)}" font-style="italic" font-weight="400">“${escSvg(nickname)}”</text>`);
    }

    if (familyName) {
      y += (nickname ? Math.round(nicknameFontSize * 0.9) : footerLineGap) + familyFontSize;
      const prefix = familyPrefix || 'Forever loved by';
      elements.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="${FONT_SERIF}" font-size="${familyFontSize}" fill="${escSvg(colors.family)}" font-style="italic" font-weight="300">${escSvg(`${prefix} ${familyName}`)}</text>`);
    }
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

  // Auto-color templates (pet-tribute) print the same light "paper insert"
  // the customizer preview shows: cream paper, dark ink, warm gold accent.
  // The preview is the product truth — the customer designs on this palette,
  // so the proof and print must come out of it too. (Before this branch,
  // these orders fell through to the legacy dark classic-dark variant and
  // shipped the inverse of what was designed.)
  if (template.colorMode === 'auto') {
    return { ...PAPER_PALETTE };
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
 * @param {{zoom:number,panX:number,panY:number}} [crop] — the customer's
 *   zoom/pan from the customizer preview; when present it wins over
 *   cropPosition so the print shows exactly what they framed on screen
 */
async function renderPhotoCover(photoPath, region, cropPosition, jpegQuality, crop) {
  const finish = (pipeline) =>
    (jpegQuality ? pipeline.jpeg({ quality: jpegQuality }) : pipeline).toBuffer();

  // Customer crop path — replicates preview.js drawCoverImage exactly:
  // cover-fit the region's aspect, zoom tightens that window, pan (0..1,
  // 0.5 = centered) positions it. Values were sanitized at checkout, but
  // clamp again — this math must never produce an out-of-bounds extract.
  if (crop && Number.isFinite(Number(crop.zoom))) {
    const zoom = Math.min(3, Math.max(1, Number(crop.zoom)));
    const panX = Math.min(1, Math.max(0, Number.isFinite(Number(crop.panX)) ? Number(crop.panX) : 0.5));
    const panY = Math.min(1, Math.max(0, Number.isFinite(Number(crop.panY)) ? Number(crop.panY) : 0.5));

    const meta = await sharp(photoPath).metadata();
    // Browsers auto-orient EXIF-rotated photos before the customer pans
    // them; mirror that (rotate() below) so the pan lands on the same pixels.
    const exifSwapped = (meta.orientation || 1) >= 5;
    const imgW = exifSwapped ? meta.height : meta.width;
    const imgH = exifSwapped ? meta.width : meta.height;

    const scale = Math.max(region.width / imgW, region.height / imgH);
    const cropW = Math.max(1, Math.min(imgW, Math.round(region.width / scale / zoom)));
    const cropH = Math.max(1, Math.min(imgH, Math.round(region.height / scale / zoom)));
    const left = Math.max(0, Math.min(imgW - cropW, Math.round((imgW - cropW) * panX)));
    const top = Math.max(0, Math.min(imgH - cropH, Math.round((imgH - cropH) * panY)));

    return finish(
      sharp(photoPath)
        .rotate() // apply EXIF orientation, matching the browser
        .extract({ left, top, width: cropW, height: cropH })
        .resize(region.width, region.height)
    );
  }

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
 * @param {{columns?:number[], rows?:number[]}} [ratios] — the customer's
 *   divider-drag fr values from the customizer preview. Each layout falls
 *   back to its default proportions when absent (legacy orders unchanged).
 * @returns {{ photo: Region, tribute: Region, panel2: Region|null }}
 */
function calculateLayout(layout, totalW, totalH, ratios) {
  // First-track fraction from a 2-track fr array (e.g. [1.15, 1] → 0.535),
  // clamped to the divider-drag bounds so a bad payload can't crush a panel.
  const frac = (tracks, fallback) => {
    if (!Array.isArray(tracks) || tracks.length !== 2) return fallback;
    const a = Number(tracks[0]);
    const b = Number(tracks[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return fallback;
    return Math.min(0.8, Math.max(0.2, a / (a + b)));
  };
  const cols = ratios && ratios.columns;
  const rows = ratios && ratios.rows;

  switch (layout) {

    // ── 2-panel layouts ──────────────────────────────────────────

    case 'side-by-side': {
      // columns [1, 1] — photo left, tribute right
      const colW = Math.round(totalW * frac(cols, 0.5));
      return {
        photo:   { left: 0,    top: 0, width: colW,            height: totalH },
        tribute: { left: colW, top: 0, width: totalW - colW,   height: totalH },
        panel2:  null,
      };
    }

    case 'stacked': {
      // rows [1, 1] — photo top, tribute bottom
      const rowH = Math.round(totalH * frac(rows, 0.5));
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
      const leftW = Math.round(totalW * frac(cols, 1.15 / 2.15));
      const rightW = totalW - leftW;
      const topH = Math.round(totalH * frac(rows, 0.5));
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
      const topH = Math.round(totalH * frac(rows, 1.3 / 2.3));
      const bottomH = totalH - topH;
      const leftW = Math.round(totalW * frac(cols, 0.5));
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
      const leftW = Math.round(totalW * frac(cols, 1 / 2.15));
      const rightW = totalW - leftW;
      const topH = Math.round(totalH * frac(rows, 0.5));
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
      const topH = Math.round(totalH * frac(rows, 1 / 2.3));
      const bottomH = totalH - topH;
      const leftW = Math.round(totalW * frac(cols, 0.5));
      const rightW = totalW - leftW;
      return {
        photo:   { left: 0,     top: topH, width: leftW,  height: bottomH },
        panel2:  { left: leftW, top: topH, width: rightW, height: bottomH },
        tribute: { left: 0,     top: 0,    width: totalW, height: topH },
      };
    }

    default:
      // Fall back to side-by-side
      return calculateLayout('side-by-side', totalW, totalH, ratios);
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
  // Poem position: when true the poem sits before the photo (left/above).
  const poemFirst = !!fields.poemFirst;
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
    poemFirst,
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
    // Customer preview adjustments (sanitized at checkout; both null on
    // legacy orders): divider-drag panel ratios + per-slot photo zoom/pan.
    customRatios: fields.customRatios || null,
    photoCrops: fields.photoCrops || null,
  };
}

// ─── Output Emission ─────────────────────────────────────────────────

/**
 * Write a rendered buffer under OUTPUT_ROOT and return its public URL.
 *
 * `/output` is served as unauthenticated static (server.js) because Luma's
 * servers must fetch print files and printouts anonymously. Anything emitted
 * here is public to anyone holding the URL — which is why the URLs are keyed
 * by unguessable order ids, and why nothing secret is ever rendered into one.
 *
 * @param {string} subdir — directory under OUTPUT_ROOT (created if absent)
 * @param {string} filename
 * @param {Buffer} buffer
 * @returns {{ absPath: string, relativeUrl: string }}
 */
function emitToOutput(subdir, filename, buffer) {
  const dir = path.join(OUTPUT_ROOT, subdir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const absPath = path.join(dir, filename);
  fs.writeFileSync(absPath, buffer);

  return { absPath, relativeUrl: `/output/${subdir}/${filename}` };
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
  emitToOutput,
  OUTPUT_ROOT,
  FONT_SERIF,
  PAPER_PALETTE,
};
