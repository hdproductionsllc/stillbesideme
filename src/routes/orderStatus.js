/**
 * Order Status Routes – customer-facing order tracking.
 *
 * GET /api/orders/status/:token   – Full order status + timeline (token-based, no login)
 * GET /api/orders/lookup          – Look up an order by email + short order ID
 *
 * The proof_token doubles as a permanent, unguessable per-order identifier
 * suitable for use in transactional email links.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const TEMPLATES_DIR = path.join(__dirname, '..', 'data', 'templates');
const templateCache = {};

/** Load a template by ID (cached) — mirrors checkout.js / adminReview.js. */
function loadTemplate(templateId) {
  if (templateCache[templateId]) return templateCache[templateId];
  const filePath = path.join(TEMPLATES_DIR, `${templateId}.json`);
  if (!fs.existsSync(filePath)) return null;
  templateCache[templateId] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return templateCache[templateId];
}

/**
 * Is this a Digital Keepsake order? Fulfillment lives on the SKU's template
 * entry — the only trusted source. Digital orders show a digital timeline
 * (confirmed → reviewed → delivered) and surface a download link when delivered.
 */
function isDigitalOrder(order) {
  const template = loadTemplate(order.template_id);
  if (!template || !Array.isArray(template.printProducts)) return false;
  const product = template.printProducts.find(p => p.sku === order.product_sku);
  return !!product && product.fulfillment === 'digital';
}

function shortId(orderId) {
  return orderId.substring(0, 8).toUpperCase();
}

/**
 * The frame this customer actually bought, for display.
 *
 * The proof is the artwork alone, because that is what the customer approves
 * and what goes to the printer. Showing that bare image on a page headed
 * "Framed 11x14" invites the obvious reaction: this is not what I ordered. So
 * the status page sets the proof inside their chosen moulding, which is how
 * they saw it in the builder and how it will arrive.
 *
 * Returns null when we cannot say for sure, and the page then shows the plain
 * proof. Guessing a frame colour would be worse than showing none.
 */
function frameForOrder(order) {
  // Only framed products have a frame. A print-only order ships bare paper for
  // the customer's own frame, so drawing one around its proof would promise
  // something we are not sending.
  if (!String(order.product_sku || '').startsWith('framed-')) return null;

  let choiceId = null;
  try {
    const fields = order.fields_json ? JSON.parse(order.fields_json) : null;
    choiceId = (fields && (fields.frameChoice || fields.frame)) || null;
  } catch (e) { /* unparseable fields are not worth failing a status page over */ }

  try {
    const { loadTemplate } = require('../services/tributeRenderer');
    const template = loadTemplate(order.template_id);
    const options = template.frameOptions;
    const all = ((options && options.groups) || [])
      .reduce((acc, g) => acc.concat(g.choices || []), []);
    if (!all.length) return null;

    // Resolve exactly as lumaOrderApi.resolveFrameSubcategory does: chosen,
    // then the template default, then the first. Orders placed before the
    // customizer posted frameChoice carry no choice at all, and those pieces
    // were MANUFACTURED in the default frame. Showing it is therefore not a
    // guess about what they picked, it is a statement of what was built.
    const chosen = all.find((c) => c.id === choiceId)
      || all.find((c) => c.id === options.default)
      || all[0];
    if (!chosen || !chosen.swatch) return null;
    return { id: chosen.id, label: chosen.label, swatch: chosen.swatch };
  } catch (e) { /* template gone or renamed: fall back to no frame */ }
  return null;
}

function trackingForOrder(db, order) {
  // Partner-fulfilled orders carry tracking on the orders row itself
  if (order.tracking_number) {
    return {
      number: order.tracking_number,
      carrier: order.tracking_carrier || '',
      url: order.tracking_url || '',
    };
  }

  const luma = db.get(
    'SELECT tracking_number, tracking_carrier, tracking_url FROM luma_orders WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
    [order.id]
  );
  if (!luma || !luma.tracking_number) return null;
  return {
    number: luma.tracking_number,
    carrier: luma.tracking_carrier || '',
    url: luma.tracking_url || '',
  };
}

/**
 * Milestone state from two plain booleans, so each path below reads as a table.
 */
function stateOf(reached, current) {
  if (current) return 'current';
  return reached ? 'done' : 'pending';
}

/**
 * Build a customer-friendly timeline.
 *
 * A milestone's state comes from where the ORDER is, never from whether some
 * audit event happens to exist. That distinction is the whole of this fix.
 * order_events is an append-only log written by whichever route handled the
 * order, and the two approval paths do not write the same rows: the legacy
 * email round-trip (adminReview.js) logs proof_sent, while the inline flow
 * that every current order takes (productionRelease.js) never does. Reading
 * "did this happen?" off proof_sent therefore reported the proof step as
 * not-yet-reached on every inline order, drawing an unlit rung in the middle
 * of a ladder whose later rungs were lit. A customer reads that as an order
 * that stalled, and one of them wrote in to say precisely that.
 *
 * Events still supply the timestamps. They are good at that. They are simply
 * not the record of which stage an order has reached; order.status is.
 *
 * The two paths also run in different orders, which one fixed shape could not
 * express. Inline customers approve their design BEFORE they pay, so their
 * approval is stamped minutes earlier than their payment, and listing approval
 * as the later step printed those two dates backwards. Each path now gets the
 * shape it actually follows.
 */
function buildTimeline(order, events) {
  const byType = {};
  for (const e of events) {
    if (!byType[e.event_type]) byType[e.event_type] = e;
  }

  const at = {
    placed: byType.order_created?.created_at || order.created_at,
    paid: byType.payment_confirmed?.created_at,
    proofSent: byType.proof_sent?.created_at,
    // Inline approval logs its own event type. Falling back to the column
    // keeps orders that predate that event readable.
    approved: byType.proof_approved_inline?.created_at
      || byType.proof_approved?.created_at
      || order.proof_approved_at,
    // When the file actually reached the printer, a different and later
    // moment than the customer approving it.
    sentToPrinter: byType.luma_submitted?.created_at
      || byType.whcc_submitted?.created_at
      || byType.partner_order_sent?.created_at,
    shipped: byType.partner_shipped?.created_at
      || byType.luma_shipped?.created_at
      || byType.whcc_shipped?.created_at,
  };

  // proof_sent is the legacy round-trip's fingerprint: it is the only path
  // that mails a proof out and then waits. Everything else was approved
  // inline, in the builder, before payment.
  const milestones = at.proofSent
    ? legacyMilestones(order, at)
    : inlineMilestones(order, at);

  if (order.status === 'cancelled') {
    for (let i = 1; i < milestones.length; i++) {
      milestones[i].state = 'cancelled';
      milestones[i].detail = 'This order was cancelled.';
    }
  }

  return milestones;
}

/**
 * The path every current order takes: the customer approves their design in
 * the builder, pays, a person checks it by hand, then it goes to the printer.
 */
function inlineMilestones(order, at) {
  const s = order.status;
  const paid = s !== 'draft' && s !== 'pending_payment';
  const inReview = s === 'awaiting_review' || s === 'change_requested';
  const withPrinter = s === 'proof_approved' || s === 'in_production';
  const shipped = s === 'shipped' || s === 'delivered';

  return [
    {
      key: 'placed',
      label: 'Order placed',
      detail: 'Your order was created.',
      at: at.placed,
      state: 'done',
    },
    {
      key: 'approved',
      label: 'You approved your design',
      detail: 'You signed off on the poem and the layout before anything went to print.',
      at: at.approved,
      state: stateOf(!!at.approved, false),
    },
    {
      key: 'paid',
      label: 'Payment received',
      detail: paid
        ? 'Thank you. Your tribute went into the queue for its final check.'
        : 'Waiting for payment to confirm.',
      at: at.paid,
      state: stateOf(paid, s === 'pending_payment'),
    },
    {
      key: 'production',
      // Naming this step "Printing and framing" while a person is still
      // checking the file would claim work that has not started. The label
      // follows the order rather than the other way round.
      label: inReview ? 'Final check by our team' : 'Printing and framing',
      detail: inReview
        ? 'A real person is going over your design by hand before it goes to print.'
        : withPrinter
          // Our status flips when the file reaches the printer, which is not
          // the same as ink being on paper: it can sit in their queue first.
          // "With our printer" is true either way. "Being printed" is not.
          ? 'Your tribute is with our printer now, to be printed on archival paper and framed.'
          : shipped
            ? 'Printed on archival paper and framed by hand.'
            : 'Printing starts once the final check is done.',
      at: at.sentToPrinter,
      state: stateOf(shipped, inReview || withPrinter),
    },
    {
      key: 'shipped',
      label: 'Shipped',
      detail: at.shipped
        ? 'Your tribute is on its way.'
        : 'Tracking will appear here, and in your inbox, as soon as it ships.',
      at: at.shipped,
      state: stateOf(shipped, false),
    },
  ];
}

/**
 * The legacy email round-trip, kept for the orders still in it: we mail a
 * proof out after payment and wait for the customer to approve it.
 */
function legacyMilestones(order, at) {
  const s = order.status;
  const paid = s !== 'draft' && s !== 'pending_payment';
  const preparing = s === 'awaiting_review';
  const awaitingCustomer = s === 'proof_ready' || s === 'change_requested';
  const withPrinter = s === 'proof_approved' || s === 'in_production';
  const shipped = s === 'shipped' || s === 'delivered';

  return [
    {
      key: 'placed',
      label: 'Order placed',
      detail: 'Your order was created.',
      at: at.placed,
      state: 'done',
    },
    {
      key: 'paid',
      label: 'Payment received',
      detail: paid
        ? 'Thank you. We have started designing your proof.'
        : 'Waiting for payment to confirm.',
      at: at.paid,
      state: stateOf(paid, s === 'pending_payment'),
    },
    {
      key: 'proof',
      label: 'Design proof ready for review',
      detail: preparing
        ? 'Our team is preparing and reviewing your design by hand. Your proof will arrive by email soon.'
        : s === 'change_requested'
          ? 'You asked for changes, and we are working on a revised proof.'
          : s === 'proof_ready'
            ? 'Please review and approve your proof.'
            : 'Your proof was sent for your review.',
      at: at.proofSent,
      state: stateOf(!!at.proofSent || withPrinter || shipped, preparing || awaitingCustomer),
    },
    {
      key: 'approved',
      label: 'Approved and sent to printer',
      detail: at.approved
        ? 'Your proof was approved and the piece is with our printer.'
        : 'Pending your approval.',
      at: at.sentToPrinter || at.approved,
      state: stateOf(shipped, withPrinter),
    },
    {
      key: 'shipped',
      label: 'Shipped',
      detail: at.shipped
        ? 'Your tribute is on its way.'
        : 'Tracking will appear here, and in your inbox, as soon as it ships.',
      at: at.shipped,
      state: stateOf(shipped, false),
    },
  ];
}

/**
 * Digital Keepsake timeline: confirmed → reviewed → delivered. No shipping.
 * The review step reflects the mandatory human gate ("reviewed by a real
 * person"); delivery surfaces the download link on the page.
 */
function buildDigitalTimeline(order, events) {
  const byType = {};
  for (const e of events) {
    if (!byType[e.event_type]) byType[e.event_type] = e;
  }

  const orderPlacedAt = byType.order_created?.created_at || order.created_at;
  const paymentAt = byType.payment_confirmed?.created_at;
  const deliveredAt = byType.digital_delivered?.created_at || order.proof_approved_at;
  const isDelivered = order.status === 'delivered';
  const awaitingReview = order.status === 'awaiting_review' || order.status === 'change_requested';

  const milestones = [
    {
      key: 'confirmed',
      label: 'Order confirmed',
      detail: order.status === 'pending_payment'
        ? 'Waiting for payment to confirm.'
        : 'Thank you. Your tribute is in the queue for review.',
      at: paymentAt || orderPlacedAt,
      state: order.status === 'pending_payment' ? 'current' : 'done',
    },
    {
      key: 'reviewed',
      label: 'Reviewed by a real person',
      detail: isDelivered
        ? 'A member of our team reviewed your tribute by hand.'
        : awaitingReview
          ? 'A real person is reviewing your tribute now. This usually takes a few hours.'
          : 'Your tribute will be reviewed by a real person before it\'s sent.',
      at: isDelivered ? deliveredAt : null,
      state: isDelivered ? 'done' : (awaitingReview ? 'current' : 'pending'),
    },
    {
      key: 'delivered',
      label: 'Ready in your inbox',
      detail: isDelivered
        ? 'Your high-resolution file is ready to download below. We also emailed you the link.'
        : 'We\'ll email your download link as soon as your tribute is ready.',
      at: isDelivered ? deliveredAt : null,
      state: isDelivered ? 'done' : 'pending',
    },
  ];

  if (order.status === 'cancelled') {
    for (let i = 1; i < milestones.length; i++) {
      milestones[i].state = 'cancelled';
      milestones[i].detail = 'This order was cancelled.';
    }
  }

  return milestones;
}

/**
 * GET /api/orders/status/:token
 * Returns full status payload — designed to feed the order status page.
 */
router.get('/status/:token', (req, res) => {
  const db = req.app.locals.db;
  const token = req.params.token;

  if (!token || token.length < 8) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const order = db.get('SELECT * FROM orders WHERE proof_token = ?', [token]);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const events = db.all(
    'SELECT event_type, data_json, created_at FROM order_events WHERE order_id = ? ORDER BY created_at ASC',
    [order.id]
  );

  const shipping = order.shipping_json ? JSON.parse(order.shipping_json) : null;
  const tracking = trackingForOrder(db, order);
  const digital = isDigitalOrder(order);
  const frame = digital ? null : frameForOrder(order);
  const downloadUrl = (digital && order.status === 'delivered' && order.print_file_url && order.proof_token)
    ? `/download/${order.proof_token}`
    : null;

  res.json({
    orderId: order.id,
    shortId: shortId(order.id),
    status: order.status,
    statusLabel: humanStatus(order.status, digital),
    templateId: order.template_id,
    sku: order.product_sku,
    skuLabel: formatSku(order.product_sku),
    digital,
    downloadUrl,
    totalCents: order.total_cents,
    email: order.email ? maskEmail(order.email) : null,
    proofUrl: order.proof_url,
    proofToken: order.proof_token,
    frame,
    shipping: digital || !shipping ? null : {
      city: shipping.city,
      state: shipping.state,
      country: shipping.country,
    },
    tracking: digital ? null : tracking,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    timeline: digital ? buildDigitalTimeline(order, events) : buildTimeline(order, events),
  });
});

/**
 * GET /api/orders/lookup?email=X&shortId=Y
 * Returns { token } if a match is found. Used by the /order lookup form.
 * Email + 8-char shortId gives ~4 billion possible IDs per email — safe without login.
 */
router.get('/lookup', (req, res) => {
  const db = req.app.locals.db;
  const email = (req.query.email || '').trim().toLowerCase();
  const sid = (req.query.shortId || '').trim().toLowerCase();

  if (!email || !sid || sid.length < 6) {
    return res.status(400).json({ error: 'Please enter both your email and order ID.' });
  }

  // Match on first 8 chars of order ID + email (case insensitive)
  const order = db.get(
    `SELECT id, proof_token FROM orders
     WHERE LOWER(SUBSTR(id, 1, ?)) = ?
       AND LOWER(email) = ?
       AND proof_token IS NOT NULL`,
    [sid.length, sid, email]
  );

  if (!order) {
    return res.status(404).json({ error: 'We couldn\'t find an order matching those details. Double-check your order ID and email, or contact us.' });
  }

  res.json({ token: order.proof_token });
});

function humanStatus(status, digital) {
  if (digital) {
    return {
      draft: 'Draft',
      pending_payment: 'Awaiting payment',
      submitted: 'Submitted',
      awaiting_review: 'Being reviewed',
      delivered: 'Delivered to your inbox',
      cancelled: 'Cancelled',
    }[status] || status;
  }
  return {
    draft: 'Draft',
    pending_payment: 'Awaiting payment',
    submitted: 'Submitted',
    awaiting_review: 'Final check before printing',
    proof_ready: 'Proof ready for your review',
    change_requested: 'Working on revised proof',
    proof_approved: 'Approved, heading to the printer',
    in_production: 'At the printer',
    shipped: 'Shipped',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
  }[status] || status;
}

function formatSku(sku) {
  if (!sku) return '';
  // framed-11x14 → Framed 11×14"
  const m = sku.match(/framed-(\d+)x(\d+)/);
  if (m) return `Framed ${m[1]}×${m[2]}"`;
  // digital-11x14 → Digital Keepsake
  if (/^digital-/.test(sku)) return 'Digital Keepsake';
  // print-11x14 → Print only 11×14"
  const p = sku.match(/print-(\d+)x(\d+)/);
  if (p) return `Print only ${p[1]}×${p[2]}"`;
  return sku;
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (!domain || local.length <= 2) return email;
  return local[0] + '•••' + local[local.length - 1] + '@' + domain;
}

module.exports = router;
// Exposed for tests: which frame a given order is shown in decides whether the
// customer recognises their own product on the page, and that deserves to be
// asserted rather than eyeballed.
module.exports.frameForOrder = frameForOrder;

// Exposed for tests: a milestone reported as not-yet-reached on an order that
// has plainly passed it is what made a paying customer write in to ask whether
// anything was happening at all. That deserves assertions, not eyeballing.
module.exports.buildTimeline = buildTimeline;
