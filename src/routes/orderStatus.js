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
const router = express.Router();

function shortId(orderId) {
  return orderId.substring(0, 8).toUpperCase();
}

function trackingForOrder(db, orderId) {
  const luma = db.get(
    'SELECT tracking_number, tracking_carrier, tracking_url FROM luma_orders WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
    [orderId]
  );
  if (!luma || !luma.tracking_number) return null;
  return {
    number: luma.tracking_number,
    carrier: luma.tracking_carrier || '',
    url: luma.tracking_url || '',
  };
}

/**
 * Build a customer-friendly timeline from the order_events audit log.
 * Returns an ordered list of milestones with their state (done | current | pending).
 */
function buildTimeline(order, events) {
  const byType = {};
  for (const e of events) {
    if (!byType[e.event_type]) byType[e.event_type] = e;
  }

  const orderPlacedAt = byType.order_created?.created_at || order.created_at;
  const paymentAt = byType.payment_confirmed?.created_at;
  const proofSentAt = byType.proof_sent?.created_at;
  const proofApprovedAt = byType.proof_approved?.created_at || order.proof_approved_at;
  const shippedAt = byType.luma_shipped?.created_at || byType.whcc_shipped?.created_at;

  const isPast = (status) => {
    const order_idx = ['draft', 'pending_payment', 'proof_ready', 'change_requested', 'proof_approved', 'in_production', 'shipped', 'delivered'].indexOf(status);
    const current_idx = ['draft', 'pending_payment', 'proof_ready', 'change_requested', 'proof_approved', 'in_production', 'shipped', 'delivered'].indexOf(order.status);
    return current_idx > order_idx;
  };

  const milestones = [
    {
      key: 'placed',
      label: 'Order placed',
      detail: 'Your order was created.',
      at: orderPlacedAt,
      state: 'done',
    },
    {
      key: 'paid',
      label: 'Payment received',
      detail: paymentAt ? 'Thank you. We\'ve started designing your proof.' : 'Waiting for payment to confirm.',
      at: paymentAt,
      state: paymentAt ? 'done' : (order.status === 'pending_payment' ? 'current' : 'pending'),
    },
    {
      key: 'proof',
      label: 'Design proof ready for review',
      detail: order.status === 'proof_ready' ? 'Please review and approve your proof.'
            : order.status === 'change_requested' ? 'You requested changes – we\'re working on a revised proof.'
            : proofSentAt ? 'Proof was sent for your review.'
            : 'We\'re creating your design proof now.',
      at: proofSentAt,
      state: order.status === 'proof_ready' ? 'current'
           : order.status === 'change_requested' ? 'current'
           : proofSentAt ? 'done' : 'pending',
    },
    {
      key: 'approved',
      label: 'Approved & sent to printer',
      detail: proofApprovedAt ? 'Your proof was approved. The frame is being printed and assembled.' : 'Pending your approval.',
      at: proofApprovedAt,
      state: proofApprovedAt ? (order.status === 'shipped' || order.status === 'delivered' ? 'done' : 'current') : 'pending',
    },
    {
      key: 'shipped',
      label: 'Shipped',
      detail: shippedAt ? 'Your tribute is on its way.' : 'You\'ll see tracking info here as soon as it ships.',
      at: shippedAt,
      state: order.status === 'shipped' || order.status === 'delivered' ? 'done' : 'pending',
    },
  ];

  // If order is cancelled, mark everything after order_placed as cancelled
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
  const tracking = trackingForOrder(db, order.id);

  res.json({
    orderId: order.id,
    shortId: shortId(order.id),
    status: order.status,
    statusLabel: humanStatus(order.status),
    templateId: order.template_id,
    sku: order.product_sku,
    skuLabel: formatSku(order.product_sku),
    totalCents: order.total_cents,
    email: order.email ? maskEmail(order.email) : null,
    proofUrl: order.proof_url,
    proofToken: order.proof_token,
    shipping: shipping ? {
      city: shipping.city,
      state: shipping.state,
      country: shipping.country,
    } : null,
    tracking,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    timeline: buildTimeline(order, events),
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

function humanStatus(status) {
  return {
    draft: 'Draft',
    pending_payment: 'Awaiting payment',
    submitted: 'Submitted',
    proof_ready: 'Proof ready for your review',
    change_requested: 'Working on revised proof',
    proof_approved: 'Being printed',
    in_production: 'Being printed',
    shipped: 'Shipped',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
  }[status] || status;
}

function formatSku(sku) {
  if (!sku) return '';
  // framed-11x14 → Framed 11 x 14"
  const m = sku.match(/framed-(\d+)x(\d+)/);
  if (m) return `Framed ${m[1]}×${m[2]}"`;
  return sku;
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (!domain || local.length <= 2) return email;
  return local[0] + '•••' + local[local.length - 1] + '@' + domain;
}

module.exports = router;
