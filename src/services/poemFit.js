/**
 * How large will this poem print, and what would fix it?
 *
 * There is exactly one correct answer to that question and it belongs to the
 * renderer, because the renderer is what sets the type. The builder used to
 * work it out again in its own arithmetic, against a panel size that stopped
 * being true the day printed mats were switched off. The two answers drifted
 * by about two and a half times, and the practical result was that a poem
 * printing at 7.5pt raised no warning at all, because the threshold had been
 * tuned for a smaller matted panel that no longer exists.
 *
 * So: ask the renderer. Everything here runs the real layout and the real fit,
 * builds no images, touches no photos, and is cheap enough to call on a
 * keystroke.
 */

const {
  buildTributeSvg, loadTemplate, resolveColors, isLandscapeLayout,
  calculateLayout, POEM_MIN_PT,
} = require('./tributeRenderer');

const DPI = 300;

/** Inches of the piece from a SKU like "framed-11x14", smaller side first. */
function sizeInches(sku) {
  const m = String(sku || '').match(/(\d+)x(\d+)/);
  return m ? { a: Number(m[1]), b: Number(m[2]) } : null;
}

/**
 * Printed point size of the poem for one size + layout.
 * Returns null when the inputs cannot describe a real piece.
 */
function measure(sku, layout, tributeData, template) {
  const size = sizeInches(sku);
  if (!size || !tributeData || !tributeData.poemText) return null;

  const landscape = isLandscapeLayout(layout);
  const totalW = (landscape ? size.b : size.a) * DPI;
  const totalH = (landscape ? size.a : size.b) * DPI;

  // Full bleed is what ships: printedMat is false, so the tribute takes its
  // share of the whole sheet rather than a window inside a printed border.
  const panels = calculateLayout(layout, totalW, totalH, null);

  const report = {};
  buildTributeSvg({
    width: panels.tribute.width,
    height: panels.tribute.height,
    colors: resolveColors(template, {}),
    tributeData: { ...tributeData, layout },
    panelWidthIn: panels.tribute.width / DPI,
    report,
  });
  return report.poemPt === null || report.poemPt === undefined ? null : report;
}

/**
 * Assess an order-in-progress and, when the words come out too small, say what
 * would actually fix it. Only ever names a remedy the computation confirms, so
 * the builder can never suggest a change that would not help.
 *
 * `turn` is offered before `sizeUp` because it is free.
 */
function assess({ sku, layout, tributeData, templateId = 'pet-tribute', sellableSkus = [] }) {
  const template = loadTemplate(templateId);
  const here = measure(sku, layout, tributeData, template);
  if (!here) return null;

  const result = {
    points: Number(here.poemPt.toFixed(1)),
    floor: POEM_MIN_PT,
    belowFloor: here.poemPt < POEM_MIN_PT,
    authoredLines: here.authoredLines,
    setLines: here.setLines,
    turn: null,
    sizeUp: null,
  };
  if (!result.belowFloor) return result;

  // Same piece, same price: does another arrangement give the poem more room?
  // The two orientations hand the tribute opposite-shaped panels, and a long
  // poem wants the tall narrow one.
  let bestTurn = null;
  for (const other of Object.keys(template.layouts || {})) {
    if (other === layout) continue;
    const m = measure(sku, other, tributeData, template);
    if (!m) continue;
    if (m.poemPt >= POEM_MIN_PT && (!bestTurn || m.poemPt > bestTurn.points)) {
      bestTurn = { layout: other, points: Number(m.poemPt.toFixed(1)) };
    }
  }
  if (bestTurn) {
    result.turn = bestTurn;
    return result; // the free fix wins; do not also ask them to spend
  }

  // Smallest larger size, in the same product family, that genuinely clears
  // the floor. Never answer a framed order with "buy the unframed one".
  const family = String(sku).split('-')[0];
  const candidates = sellableSkus
    .filter((s) => s.startsWith(family + '-') && sizeInches(s))
    .sort((x, y) => {
      const a = sizeInches(x); const b = sizeInches(y);
      return (a.a * a.b) - (b.a * b.b);
    });
  const hereArea = sizeInches(sku).a * sizeInches(sku).b;
  for (const candidate of candidates) {
    const area = sizeInches(candidate).a * sizeInches(candidate).b;
    if (area <= hereArea) continue;
    for (const l of [layout, ...Object.keys(template.layouts || {})]) {
      const m = measure(candidate, l, tributeData, template);
      if (m && m.poemPt >= POEM_MIN_PT) {
        result.sizeUp = {
          sku: candidate,
          layout: l,
          points: Number(m.poemPt.toFixed(1)),
        };
        break;
      }
    }
    if (result.sizeUp) break;
  }

  return result;
}

/**
 * The largest number of lines that still prints at or above the floor, for a
 * given piece. This is what the poem generator should be told, so an AI-written
 * tribute lands legible by construction instead of being warned about after.
 */
function lineBudget(sku, layout, templateId = 'pet-tribute') {
  const template = loadTemplate(templateId);
  // 34 characters is the line length our poems are written to (see the craft
  // rules in src/data/poems.js). Measuring with a longer filler measures the
  // WRAPPING instead of the capacity: a 45-character line breaks in two inside
  // the narrow side-by-side panel, which made that layout look like it held
  // fewer lines than the stacked one when it actually holds more.
  const filler = 'the ball is still on the porch and'; // 34 chars
  let best = 0;
  for (let lines = 4; lines <= 60; lines += 1) {
    const poemText = Array.from({ length: lines }, () => filler).join('\n');
    const m = measure(sku, layout, { poemText, name: 'Name' }, template);
    if (!m || m.poemPt < POEM_MIN_PT) break;
    best = lines;
  }
  return best;
}

module.exports = { assess, measure, lineBudget, POEM_MIN_PT };
