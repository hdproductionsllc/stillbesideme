/**
 * Admin Review Routes — the human gate between payment and the customer
 * proof email.
 *
 * BRAND RULE: every proof passes David/Rebecca's review before the customer
 * sees it. The approve action below is the ONLY caller of sendProofEmail.
 * Never add an automatic path around this page.
 *
 * Uses the same tokenized model as adminOrder.js (admin_token, generated at
 * payment, deliberately separate from the customer-facing proof_token).
 *
 * GET  /api/admin/review/:token/data     — Order + answers + poem + proof
 * POST /api/admin/review/:token/poem     — Save edited poem, regenerate proof
 * POST /api/admin/review/:token/approve  — Send the proof email to the customer
 *
 * Handles both fresh orders (awaiting_review) and customer change requests
 * (change_requested) — same page, same actions.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const emailService = require('../services/emailService');

const REVIEWABLE_STATUSES = ['awaiting_review', 'change_requested'];

const TEMPLATES_DIR = path.join(__dirname, '..', 'data', 'templates');
const templateCache = {};

/** Load a template by ID (cached after first read) — mirrors checkout.js. */
function loadTemplate(templateId) {
  if (templateCache[templateId]) return templateCache[templateId];
  const filePath = path.join(TEMPLATES_DIR, `${templateId}.json`);
  if (!fs.existsSync(filePath)) return null;
  templateCache[templateId] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return templateCache[templateId];
}

/**
 * Is this order a Digital Keepsake? The fulfillment type lives on the SKU's
 * template entry (never trust anything else). Digital orders skip the customer
 * proof round entirely — the customer already approved every word in the
 * customizer, so "approve" delivers the finished file instead of a proof.
 */
function isDigitalOrder(order) {
  const template = loadTemplate(order.template_id);
  if (!template || !Array.isArray(template.printProducts)) return false;
  const product = template.printProducts.find(p => p.sku === order.product_sku);
  return !!product && product.fulfillment === 'digital';
}

function findOrderByAdminToken(db, token) {
  if (!token || token.length < 8) return null;
  return db.get('SELECT * FROM orders WHERE admin_token = ?', [token]);
}

// Human labels for the Luma order-item options placeOrder() sends on every
// framed order (LUMA_CONFIG.sharedOptions). Keyed by Luma option id so a
// config change surfaces as "Luma option <id>" instead of a silently wrong
// label.
const LUMA_OPTION_LABELS = {
  64: 'No mat from Luma — the mat is printed into the artwork (full bleed)',
  74: 'Archival Matte Fine Art Paper',
  146: 'Acrylic glass glazing',
  83: 'Hanging wire installed',
  95: 'Kraft paper backing',
  148: 'Dry mounted to foam core',
  36: '0.25in bleed',
};

/**
 * What fulfillment will actually receive for this order — resolved with the
 * SAME code paths lumaOrderApi.placeOrder() uses (frame subcategory, print
 * orientation), so the review page shows the truth, not a guess.
 */
function buildFulfillmentPreview(order, fields) {
  const sku = order.product_sku || '';
  let shipping = null;
  try { shipping = order.shipping_json ? JSON.parse(order.shipping_json) : null; } catch (e) { /* ignore */ }

  if (isDigitalOrder(order)) {
    return {
      type: 'digital',
      summary: 'Digital Keepsake — nothing goes to a print vendor. Approving delivers the download link.',
    };
  }

  const lumaApi = require('../services/lumaOrderApi');
  const { isLandscapeLayout } = require('../services/tributeRenderer');

  // Print dimensions exactly as placeOrder() will send them.
  const m = sku.match(/(\d+)x(\d+)/);
  const landscape = isLandscapeLayout((fields && fields.layout) || 'side-by-side');
  let width = null, height = null;
  if (m) {
    const short = Math.min(Number(m[1]), Number(m[2]));
    const long = Math.max(Number(m[1]), Number(m[2]));
    width = landscape ? long : short;
    height = landscape ? short : long;
  }

  const base = {
    orientation: landscape ? 'Landscape' : 'Portrait',
    width,
    height,
    colors: (fields && fields.colors) || null,
    giftNote: !!(fields && fields.giftNote),
    shipping,
    printFileReady: !!order.print_file_url,
  };

  if (sku.startsWith('print-')) {
    return {
      ...base,
      type: 'print-only',
      summary: 'Unframed print — same archival matte paper, shipped bare for their own frame.',
      lumaSubcategoryId: lumaApi.LUMA_CONFIG.printOnly.subcategoryId,
      options: lumaApi.LUMA_CONFIG.printOnly.options.map(id => LUMA_OPTION_LABELS[id] || `Luma option ${id}`),
    };
  }

  // Framed: the frame the customer chose (falls back to the template default,
  // exactly like placeOrder). Frame color/profile is baked into the Luma
  // subcategory.
  const frameId = (fields && (fields.frameChoice || fields.frame)) || null;
  let frameLabel = null;
  let frameDefaulted = false;
  const tmpl = loadTemplate(order.template_id);
  const fo = tmpl && tmpl.frameOptions;
  if (fo && Array.isArray(fo.groups)) {
    const all = fo.groups.reduce((acc, g) => acc.concat(g.choices || []), []);
    const chosen = all.find(c => c.id === frameId);
    const fallback = all.find(c => c.id === fo.default) || all[0];
    frameDefaulted = !chosen;
    const effective = chosen || fallback;
    if (effective) frameLabel = effective.label || effective.id;
  }

  return {
    ...base,
    type: 'framed',
    frameId,
    frameLabel,
    frameDefaulted,
    lumaSubcategoryId: lumaApi.resolveFrameSubcategory(order.template_id, frameId),
    options: lumaApi.LUMA_CONFIG.sharedOptions.map(id => LUMA_OPTION_LABELS[id] || `Luma option ${id}`),
  };
}

/**
 * GET /api/admin/review/:token/data
 */
router.get('/review/:token/data', (req, res) => {
  const db = req.app.locals.db;
  const order = findOrderByAdminToken(db, req.params.token);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const fields = order.fields_json ? JSON.parse(order.fields_json) : {};

  let fulfillment = null;
  try {
    fulfillment = buildFulfillmentPreview(order, fields);
  } catch (err) {
    // The preview is informational — a resolution error must never block review.
    console.error(`Fulfillment preview failed for order ${order.id}:`, err.message);
  }

  res.json({
    orderId: order.id,
    shortId: order.id.substring(0, 8).toUpperCase(),
    status: order.status,
    reviewable: REVIEWABLE_STATUSES.includes(order.status),
    templateId: order.template_id,
    sku: order.product_sku,
    totalCents: order.total_cents,
    email: order.email,
    poemText: order.poem_text || '',
    proofUrl: order.proof_url,
    fields,
    fulfillment,
    changeRequestNotes: order.change_request_notes || null,
    reviewedAt: order.reviewed_at || null,
    createdAt: order.created_at,
  });
});

/**
 * POST /api/admin/review/:token/poem
 * Body: { poemText } — saves the edit and regenerates the proof image.
 */
router.post('/review/:token/poem', async (req, res) => {
  const db = req.app.locals.db;
  const order = findOrderByAdminToken(db, req.params.token);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  if (!REVIEWABLE_STATUSES.includes(order.status)) {
    return res.status(400).json({ error: `Order is ${order.status.replace(/_/g, ' ')} — the poem can no longer be edited here` });
  }

  const poemText = (req.body.poemText || '').trim();
  if (!poemText) {
    return res.status(400).json({ error: 'Poem text cannot be empty' });
  }

  db.run(
    `UPDATE orders SET poem_text = ?, updated_at = datetime('now') WHERE id = ?`,
    [poemText, order.id]
  );

  // Regenerate the proof so the review (and later the customer) sees the edit
  try {
    const proofGenerator = require('../services/proofGenerator');
    const updatedOrder = db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
    const { proofRelativeUrl } = await proofGenerator.generateProof(updatedOrder);
    db.run('UPDATE orders SET proof_url = ?, updated_at = datetime(\'now\') WHERE id = ?', [proofRelativeUrl, order.id]);

    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [order.id, 'poem_edited', JSON.stringify({ proofUrl: proofRelativeUrl })]
    );

    res.json({ success: true, message: 'Poem saved — proof regenerated.', proofUrl: proofRelativeUrl });
  } catch (err) {
    console.error(`Failed to regenerate proof for order ${order.id}:`, err.message);
    res.status(500).json({ error: 'Poem was saved, but the proof failed to regenerate. Try again.' });
  }
});

/**
 * POST /api/admin/review/:token/approve
 * The gate opens: sends the proof email to the customer.
 * Idempotent — re-posting after approval does not re-email unless ?resend=1.
 */
router.post('/review/:token/approve', async (req, res) => {
  const db = req.app.locals.db;
  const order = findOrderByAdminToken(db, req.params.token);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  // Digital Keepsake: "approve" means deliver the finished file, not send a
  // proof. No customer proof round — the delivered file equals the preview.
  if (isDigitalOrder(order)) {
    return deliverDigitalOrder(req, res, db, order);
  }

  const alreadySent = order.status === 'proof_ready';
  if (!REVIEWABLE_STATUSES.includes(order.status) && !alreadySent) {
    return res.status(400).json({ error: `Order is ${order.status.replace(/_/g, ' ')} — nothing to approve` });
  }
  if (alreadySent && req.query.resend !== '1') {
    return res.json({ success: true, message: 'Proof was already sent to the customer.' });
  }

  if (!order.email) {
    return res.status(400).json({ error: 'Order has no customer email — cannot send the proof' });
  }
  if (!order.proof_url) {
    return res.status(400).json({ error: 'No proof image on this order yet — save the poem to generate one' });
  }

  const baseUrl = process.env.BASE_URL || 'http://localhost:3001';

  try {
    await emailService.sendProofEmail(order.email, {
      orderId: order.id,
      templateName: order.template_id,
      sku: order.product_sku,
      totalCents: order.total_cents,
    },
    `${baseUrl}${order.proof_url}`,
    `${baseUrl}/proof/${order.proof_token}`,
    `${baseUrl}/order/${order.proof_token}`);
  } catch (err) {
    console.error(`Failed to send proof email for order ${order.id}:`, err.message);
    return res.status(500).json({ error: 'Could not send the proof email. Check SMTP settings and try again.' });
  }

  db.run(
    `UPDATE orders SET
       status = 'proof_ready',
       reviewed_at = datetime('now'),
       change_request_notes = NULL,
       updated_at = datetime('now')
     WHERE id = ?`,
    [order.id]
  );
  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [order.id, 'review_approved', JSON.stringify({ resend: alreadySent })]
  );
  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [order.id, 'proof_sent', JSON.stringify({ proofUrl: order.proof_url, email: order.email })]
  );

  console.log(`Order ${order.id}: review approved — proof emailed to ${order.email}`);
  res.json({ success: true, message: 'Approved — proof emailed to the customer.' });
});

/**
 * Deliver a Digital Keepsake order (fulfillment:"digital").
 *
 * Unlike the framed flow, approval does NOT send a proof — it delivers the
 * finished, high-resolution file the customer already approved word-for-word
 * in the customizer. Steps: render the same 300 DPI print file the framed
 * 11x14 uses (stored on the /data volume via printRenderer's OUTPUT_DIR),
 * mint a one-time $19.95 upgrade credit, email the tokenized download link,
 * then mark the order `delivered`.
 *
 * Idempotency: the order is flipped to `delivered` LAST, so a mid-way failure
 * lets the admin retry safely. Rendering overwrites the same file; the upgrade
 * credit is minted at most once (guarded by the `upgrade_credit_created`
 * event); a re-approve of an already-delivered order is a no-op.
 */
async function deliverDigitalOrder(req, res, db, order) {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
  const shortId = order.id.substring(0, 8).toUpperCase();

  // Already delivered: never double-render, double-deliver, or double-mint.
  // ?resend=1 re-sends the delivery email only, reusing the existing credit.
  if (order.status === 'delivered') {
    if (req.query.resend === '1') {
      if (!order.email) {
        return res.status(400).json({ error: 'Order has no customer email — cannot resend the delivery' });
      }
      try {
        const promoCode = existingPromoCode(db, order.id);
        await sendDigitalDelivery(order, baseUrl, promoCode);
      } catch (err) {
        console.error(`Failed to resend digital delivery for order ${order.id}:`, err.message);
        return res.status(500).json({ error: 'Could not resend the delivery email. Check SMTP settings and try again.' });
      }
      return res.json({ success: true, message: 'Delivery email re-sent to the customer.' });
    }
    return res.json({ success: true, message: 'This keepsake has already been delivered to the customer.' });
  }

  if (!REVIEWABLE_STATUSES.includes(order.status)) {
    return res.status(400).json({ error: `Order is ${order.status.replace(/_/g, ' ')} — nothing to deliver` });
  }
  if (!order.email) {
    return res.status(400).json({ error: 'Order has no customer email — cannot deliver the keepsake' });
  }

  // 1. Render the final print file — same pipeline as the framed 11x14.
  //    Idempotent: overwrites output/print-ready/{orderId}.jpg on retry.
  const printRenderer = require('../services/printRenderer');
  try {
    const { printRelativeUrl } = await printRenderer.generatePrintFile(order);
    db.run('UPDATE orders SET print_file_url = ?, updated_at = datetime(\'now\') WHERE id = ?',
      [printRelativeUrl, order.id]);
    order.print_file_url = printRelativeUrl;
    console.log(`Digital keepsake rendered for order ${order.id}: ${printRelativeUrl}`);
  } catch (err) {
    console.error(`Failed to render digital keepsake for order ${order.id}:`, err.message);
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [order.id, 'print_render_failed', JSON.stringify({ error: err.message })]
    );
    try {
      await emailService.sendAdminAlert(
        `Order ${shortId} stalled: digital render failed`,
        `Order ${shortId} was approved for delivery but the keepsake file could not be rendered.\n\n` +
        `Order ID: ${order.id}\n` +
        `Step: print render (digital delivery)\n` +
        `Error: ${err.message}\n\n` +
        `Review page: ${baseUrl}/admin/review/${order.admin_token}`
      );
    } catch (alertErr) {
      console.error(`Failed to send admin alert for order ${order.id}:`, alertErr.message);
    }
    return res.status(500).json({ error: 'Failed to render the keepsake file. Our team has been notified.' });
  }

  // 2. Mint the one-time $19.95 upgrade credit (idempotent). Non-fatal: a
  //    credit hiccup must not block delivery of a paid-for file.
  let promoCode = null;
  try {
    promoCode = await ensureUpgradeCredit(db, order);
  } catch (err) {
    console.error(`Failed to create upgrade credit for order ${order.id}:`, err.message);
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [order.id, 'upgrade_credit_failed', JSON.stringify({ error: err.message })]
    );
  }

  // 3. Send the delivery email with the tokenized download link + credit.
  try {
    await sendDigitalDelivery(order, baseUrl, promoCode);
  } catch (err) {
    console.error(`Failed to send digital delivery email for order ${order.id}:`, err.message);
    return res.status(500).json({ error: 'Could not send the delivery email. Check SMTP settings and try again.' });
  }

  // 4. Mark delivered — LAST, so any failure above is safely retryable.
  db.run(
    `UPDATE orders SET
       status = 'delivered',
       reviewed_at = datetime('now'),
       proof_approved_at = datetime('now'),
       change_request_notes = NULL,
       updated_at = datetime('now')
     WHERE id = ?`,
    [order.id]
  );
  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [order.id, 'review_approved', JSON.stringify({ fulfillment: 'digital' })]
  );
  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [order.id, 'digital_delivered', JSON.stringify({ email: order.email, promoCode: promoCode || null })]
  );

  console.log(`Order ${order.id}: digital keepsake delivered to ${order.email}`);
  res.json({ success: true, message: 'Delivered — download link emailed to the customer.' });
}

/** Send (or resend) the digital delivery email for an order. */
function sendDigitalDelivery(order, baseUrl, promoCode) {
  return emailService.sendDigitalDeliveryEmail(
    order.email,
    { orderId: order.id, totalCents: order.total_cents },
    {
      downloadUrl: `${baseUrl}/download/${order.proof_token}`,
      promoCode: promoCode || null,
      upgradeUrl: `${baseUrl}/customize/${order.template_id}`,
      statusPageUrl: order.proof_token ? `${baseUrl}/order/${order.proof_token}` : null,
    }
  );
}

/** The promo code already minted for this order, if any. */
function existingPromoCode(db, orderId) {
  const row = db.get(
    `SELECT data_json FROM order_events WHERE order_id = ? AND event_type = 'upgrade_credit_created' ORDER BY created_at ASC LIMIT 1`,
    [orderId]
  );
  if (!row) return null;
  try { return JSON.parse(row.data_json).promoCode || null; } catch (e) { return null; }
}

/**
 * Create the $19.95 upgrade credit for a delivered digital order — a Stripe
 * coupon (amount_off, once, expires in 30 days) fronted by a single-use
 * promotion code `UPGRADE-<shortId>`. `allow_promotion_codes` is already on in
 * checkout, so the customer just types the code toward the framed tribute.
 *
 * Idempotent: if a credit was already minted for this order we reuse it rather
 * than mint a second coupon. Returns the promo code string.
 */
async function ensureUpgradeCredit(db, order) {
  const existing = existingPromoCode(db, order.id);
  if (existing) return existing;

  const shortId = order.id.substring(0, 8).toUpperCase();
  const promoCodeStr = `UPGRADE-${shortId}`;
  const redeemBy = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days

  const Stripe = require('stripe');
  // Pin a modern API version for this client. The Stripe account's default
  // version is old enough that promotionCodes.create rejects the `coupon`
  // parameter ("Received unknown parameter: coupon"); pinning here fixes the
  // upgrade-credit mint without touching checkout/webhook clients, which work
  // on the account default and are left alone deliberately.
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  const coupon = await stripe.coupons.create({
    amount_off: 1995,
    currency: 'usd',
    duration: 'once',
    redeem_by: redeemBy,
    name: `Digital keepsake credit for order ${shortId}`,
    metadata: { orderId: order.id },
  });

  const promo = await stripe.promotionCodes.create({
    coupon: coupon.id,
    code: promoCodeStr,
    max_redemptions: 1,
    expires_at: redeemBy,
    metadata: { orderId: order.id },
  });

  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [order.id, 'upgrade_credit_created', JSON.stringify({
      couponId: coupon.id,
      promoCode: promo.code,
      amountOffCents: 1995,
      redeemBy,
    })]
  );

  console.log(`Order ${order.id}: upgrade credit ${promo.code} created (coupon ${coupon.id})`);
  return promo.code;
}

module.exports = router;
