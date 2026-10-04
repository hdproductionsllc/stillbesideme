/**
 * What a SKU is: the one place that answers it.
 *
 * Products live on the template (never trust anything the client sends), and
 * there are two kinds of them:
 *
 *   printProducts — what anyone can buy, listed in the size chooser.
 *   partnerGift   — the free keepsake a partner practice gives a family. It is
 *                   deliberately NOT in printProducts: that list is what the
 *                   shop sells, what "from $X" is computed over, and what Etsy
 *                   and the legibility tools iterate. A $0 rung there would
 *                   leak into all of them. It is reachable only through a
 *                   partner link (see services/partners.js).
 *
 * checkout.js, adminReview.js, orderStatus.js and server.js each carried their
 * own copy of "is this a digital order"; they now ask here, so a gift keepsake
 * is a digital order everywhere at once.
 */

const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, '..', 'data', 'templates');
const templateCache = {};

/** Load a template by ID (cached after first read). */
function loadTemplate(templateId) {
  if (!templateId || !/^[a-z0-9-]+$/i.test(templateId)) return null;
  if (templateCache[templateId]) return templateCache[templateId];
  const filePath = path.join(TEMPLATES_DIR, `${templateId}.json`);
  if (!fs.existsSync(filePath)) return null;
  templateCache[templateId] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return templateCache[templateId];
}

/** The partner gift product for a template, or null if it offers none. */
function giftProduct(template) {
  return (template && template.partnerGift) || null;
}

/** Is this SKU the template's partner gift? */
function isGiftSku(template, sku) {
  const gift = giftProduct(template);
  return !!gift && gift.sku === sku;
}

/** Any product on the template, sellable or gift. */
function findProduct(template, sku) {
  if (!template || !sku) return null;
  const sellable = (template.printProducts || []).find(p => p.sku === sku);
  if (sellable) return sellable;
  return isGiftSku(template, sku) ? giftProduct(template) : null;
}

/** The product an order was placed for. */
function productForOrder(order) {
  return findProduct(loadTemplate(order && order.template_id), order && order.product_sku);
}

/** Digital orders are delivered as a download; nothing goes to a printer. */
function isDigitalOrder(order) {
  const product = productForOrder(order);
  return !!product && product.fulfillment === 'digital';
}

/**
 * A partner gift keepsake. Delivered at screen size, never as the print file,
 * and never carries the paid keepsake's upgrade credit.
 */
function isGiftOrder(order) {
  return isGiftSku(loadTemplate(order && order.template_id), order && order.product_sku);
}

module.exports = {
  loadTemplate,
  giftProduct,
  isGiftSku,
  findProduct,
  productForOrder,
  isDigitalOrder,
  isGiftOrder,
};
