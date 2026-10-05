/**
 * The unframed print must reach Luma in a shape Luma accepts.
 *
 * Luma refuses any image whose aspect ratio is more than 1% off the size it
 * expects. On fine art paper, its "bleed" options are WHITE BORDERS: 0.25in on
 * each side turns an 11x14 order into a 10.5x13.5 image area (7:9), and our
 * 11x14 file was refused with a 406. That stopped the first real print-only
 * order (2A47ADF9, Oct 5 2026).
 *
 * So: the print-only order uses "No Bleed", and the file we render for every
 * print-only size has exactly the ordered size's proportions, in both layouts.
 *
 *   node tests/luma-print-only.test.js
 */

const assert = require('assert');
const { LUMA_CONFIG } = require('../src/services/lumaOrderApi');
const { calculatePrintDimensions } = require('../src/services/printRenderer');
const template = require('../src/data/templates/pet-tribute.json');

const NO_BLEED = 39;
const BORDER_BLEEDS = [36, 37, 38]; // 0.25in, 0.50in, 1.00in white borders

assert.ok(LUMA_CONFIG.printOnly.options.includes(NO_BLEED), 'print-only must order No Bleed');
for (const id of BORDER_BLEEDS) {
  assert.ok(!LUMA_CONFIG.printOnly.options.includes(id), `print-only must not order bleed option ${id}`);
}

const printOnly = template.printProducts.filter(p => p.sku.startsWith('print-'));
assert.ok(printOnly.length > 0, 'the template sells at least one print-only size');
for (const { sku } of printOnly) {
  const [, a, b] = sku.match(/(\d+)x(\d+)/).map(Number);
  for (const layout of ['side-by-side', 'stacked']) {
    const { width, height } = calculatePrintDimensions(sku, layout);
    const fileRatio = Math.min(width, height) / Math.max(width, height);
    const orderRatio = Math.min(a, b) / Math.max(a, b);
    assert.ok(Math.abs(fileRatio - orderRatio) / orderRatio < 0.01,
      `${sku} ${layout}: file ${width}x${height} is not the ordered ${a}x${b}`);
  }
}

console.log('luma-print-only: all assertions passed');
