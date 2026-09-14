/**
 * The second door: build a real order from a buyer's answers, without a
 * checkout.
 *
 * Every order used to be born the same way. A buyer filled in the customizer,
 * uploaded a photo, approved their own proof, and paid. The order row was a
 * side effect of that walk, and so was the approval.
 *
 * An Etsy buyer pays on Etsy. The sale is real and the money has landed, but
 * nothing here knows about it, and the answers they typed at Etsy checkout are
 * sitting in a marketplace inbox. This module is the only supported way to turn
 * those answers into an order.
 *
 * It is written to be called twice over its life:
 *
 *   today  — by the gated admin form, David typing what the buyer wrote
 *   later  — by the order.paid webhook, with the same fields read from the
 *            Etsy receipt
 *
 * which is why nothing here knows what a form is. It takes plain values and
 * returns an order id. When the webhook lands it calls this same function and
 * the rest of the pipeline cannot tell the difference, because there IS no
 * difference by then: the row looks exactly like a direct order that happens
 * to carry source='etsy'.
 *
 * What it deliberately does NOT do:
 *
 *   - write a poem. The order lands in `awaiting_review`, which is where the
 *     existing admin review page picks it up, writes or edits the poem, and
 *     regenerates the proof. That page is the brand's human gate and this
 *     path must not route around it.
 *   - approve anything. An order created here has no proof_approved_at, so
 *     fulfillmentSubmitter will refuse to print it until a human records the
 *     buyer's approval. That is the point.
 *   - take payment. The money is already collected by the marketplace.
 */

const { v4: uuidv4 } = require('uuid');
const path = require('path');

const imageProcessor = require('./imageProcessor');
const storage = require('./storage');
const { loadTemplate } = require('./tributeRenderer');

/** Sources that may be created through this door. 'direct' never comes here. */
const ALLOWED_SOURCES = ['etsy'];

/**
 * Print dimensions for a SKU, used to assess whether the buyer's photo is
 * good enough at the size they bought. Parsed from the SKU rather than kept
 * in a second table, so it cannot disagree with what is actually sold.
 */
function printSizeFor(sku) {
  const m = typeof sku === 'string' ? sku.match(/(\d+)x(\d+)/) : null;
  if (!m) return { width: 11, height: 14 };
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * Resolve the frame the buyer chose against what the template actually sells,
 * exactly as checkout does. A marketplace variation label is buyer-facing text
 * from another system; it must never become a frame id we do not stock.
 */
function resolveFrame(template, sku, requested) {
  const isFramed = typeof sku === 'string' && sku.startsWith('framed-');
  if (!isFramed || !template.frameOptions || !Array.isArray(template.frameOptions.groups)) {
    return null;
  }
  const sizeMatch = sku.match(/(\d+)x(\d+)/);
  const shortSideIn = sizeMatch ? Math.min(Number(sizeMatch[1]), Number(sizeMatch[2])) : 0;

  const wanted = String(requested || '').trim().toLowerCase();
  for (const group of template.frameOptions.groups) {
    if (group.minShortSideIn && shortSideIn < group.minShortSideIn) continue;
    const match = (group.choices || []).find(
      c => c.id === wanted || String(c.label || '').toLowerCase() === wanted
    );
    if (match) return match.id;
  }
  return template.frameOptions.default || null;
}

/** Clamp buyer text to the length its field declares, same as checkout. */
function clampFields(template, fields) {
  const byId = {};
  (template.memoryFields || []).forEach(f => { byId[f.id] = f; });

  const out = {};
  for (const [key, raw] of Object.entries(fields || {})) {
    if (raw == null) continue;
    const value = String(raw).trim();
    if (!value) continue;
    const def = byId[key];
    const max = def && def.maxLength ? def.maxLength : 1024;
    out[key] = value.slice(0, max);
  }
  return out;
}

/**
 * Store one buyer photo through the same pipeline an uploaded photo takes:
 * HEIC conversion, resize, quality assessment against the print size, crop
 * suggestion, palette. Downstream, an Etsy photo and a website photo are
 * indistinguishable, which is the only way the renderer can stay ignorant of
 * where an order came from.
 */
async function storePhoto(buffer, originalName, sku) {
  const { width, height } = printSizeFor(sku);
  const result = await imageProcessor.processUpload(buffer, originalName, width, height);

  const storedName = result.convertedFromHeic
    ? originalName.replace(/\.hei[cf]$/i, '.jpg')
    : originalName;

  const stored = storage.storeFile(result.processedBuffer, storedName);
  const thumb = storage.storeThumbnail(result.thumbnailBuffer, stored.filename);

  return {
    originalPath: stored.relativePath,
    thumbnailPath: thumb.relativePath,
    originalUrl: storage.toUrl(stored.relativePath),
    thumbnailUrl: storage.toUrl(thumb.relativePath),
    dimensions: result.dimensions,
    quality: result.quality,
    crop: result.crop,
    palette: result.palette,
    uploadedAt: new Date().toISOString(),
  };
}

/**
 * Create an order from a marketplace sale.
 *
 * @param {object} db
 * @param {object} input
 * @param {string} input.source           'etsy'
 * @param {string|number} [input.etsyReceiptId]  marketplace order number
 * @param {string} input.sku              e.g. 'framed-11x14'
 * @param {string} [input.templateId]     defaults to 'pet-tribute'
 * @param {string} [input.frameChoice]    frame id or its buyer-facing label
 * @param {object} input.fields           petName, petType, birthDate, passDate,
 *                                        personality, favoriteMemory, ...
 * @param {Array}  input.photos           [{ buffer, originalName }]
 * @param {string} [input.ownPoem]        the buyer's own words, if they sent any
 * @param {object} [input.shipping]       { name, line1, city, state, zip, country }
 * @param {number} [input.totalCents]     what the marketplace collected
 * @param {string} [input.notes]          anything the shop wants on the record
 *
 * @returns {Promise<{orderId, proofToken, adminToken, photoQuality}>}
 */
async function createFromMarketplace(db, input) {
  const source = String(input.source || '').toLowerCase();
  if (!ALLOWED_SOURCES.includes(source)) {
    throw new Error(`Unsupported intake source "${input.source}"`);
  }

  const templateId = input.templateId || 'pet-tribute';
  const template = loadTemplate(templateId);
  if (!template) throw new Error(`Unknown template "${templateId}"`);

  const sku = String(input.sku || '').trim();
  const product = (template.printProducts || []).find(p => p.sku === sku);
  if (!product) throw new Error(`Unknown product "${sku}" for template ${templateId}`);

  if (!input.fields || !String(input.fields.petName || '').trim()) {
    throw new Error('A pet name is required — it is printed on the piece');
  }
  if (!Array.isArray(input.photos) || !input.photos.length) {
    throw new Error('At least one photo is required — there is nothing to print without it');
  }

  // One tribute per marketplace sale, whatever happens upstream. A
  // double-submitted form today, or a retried webhook later, lands here.
  const receiptId = input.etsyReceiptId ? String(input.etsyReceiptId).trim() : null;
  if (receiptId) {
    const existing = db.get('SELECT id FROM orders WHERE etsy_receipt_id = ?', [receiptId]);
    if (existing) {
      const err = new Error(`Etsy order ${receiptId} is already in the system`);
      err.code = 'DUPLICATE_RECEIPT';
      err.orderId = existing.id;
      throw err;
    }
  }

  // Photos first: if the image pipeline rejects one, no half-built order row
  // is left behind for somebody to find later and wonder about.
  const photos = {};
  for (let i = 0; i < input.photos.length; i++) {
    const p = input.photos[i];
    const slot = i === 0 ? 'main' : `photo${i + 1}`;
    photos[slot] = await storePhoto(p.buffer, p.originalName || `photo-${i + 1}.jpg`, sku);
  }

  const fields = clampFields(template, input.fields);
  const frameChoice = resolveFrame(template, sku, input.frameChoice);

  const fieldsJson = JSON.stringify({
    ...fields,
    style: input.style || template.defaultStyle,
    layout: input.layout || template.defaultLayout,
    orderType: 'self',
    poemFirst: false,
    ...(frameChoice ? { frameChoice } : {}),
  });

  const orderId = uuidv4();
  const proofToken = uuidv4();
  const adminToken = uuidv4();

  // Tokens are minted here rather than at payment, because for a marketplace
  // order there is no payment event of ours to hang them on. The admin token
  // is what opens the review page; the proof token stays unused unless we ever
  // decide to send an Etsy buyer a link.
  db.run(
    `INSERT INTO orders (
       id, source, etsy_receipt_id, status, template_id, product_sku,
       fields_json, photos_json, poem_text, total_cents,
       shipping_json, proof_token, admin_token, fulfillment_provider, admin_notes
     ) VALUES (?, ?, ?, 'awaiting_review', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orderId,
      source,
      receiptId,
      templateId,
      sku,
      fieldsJson,
      JSON.stringify(photos),
      input.ownPoem ? String(input.ownPoem).trim() : null,
      Number.isFinite(input.totalCents) ? input.totalCents : product.price,
      input.shipping ? JSON.stringify(input.shipping) : null,
      proofToken,
      adminToken,
      'luma',
      input.notes ? String(input.notes).trim() : null,
    ]
  );

  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [orderId, 'marketplace_order_ingested', JSON.stringify({
      source,
      etsyReceiptId: receiptId,
      sku,
      frameChoice,
      photoCount: Object.keys(photos).length,
      buyerSuppliedPoem: !!input.ownPoem,
      ingestedAt: new Date().toISOString(),
    })]
  );

  return {
    orderId,
    proofToken,
    adminToken,
    photoQuality: photos.main ? photos.main.quality : null,
  };
}

module.exports = { createFromMarketplace, printSizeFor, resolveFrame };
