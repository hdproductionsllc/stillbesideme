/**
 * Checkout route – creates an order and Stripe Checkout Session.
 * POST /api/checkout
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const TEMPLATES_DIR = path.join(__dirname, '..', 'data', 'templates');

// ── Preview-adjustment sanitizers (never trust the client) ──────────
// The customizer sends the customer's divider-drag panel ratios and photo
// zoom/pan so the print matches what they framed on screen. Both are
// optional; malformed values are dropped (renderers fall back to defaults).

/** A 2-track fr array like [1.15, 1]; anything else is dropped. */
function sanitizeTracks(tracks) {
  if (!Array.isArray(tracks) || tracks.length !== 2) return null;
  const nums = tracks.map(Number);
  if (!nums.every(n => Number.isFinite(n) && n > 0.05 && n < 20)) return null;
  return nums;
}

function sanitizeRatios(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const columns = sanitizeTracks(raw.columns);
  const rows = sanitizeTracks(raw.rows);
  return (columns || rows) ? { ...(columns ? { columns } : {}), ...(rows ? { rows } : {}) } : null;
}

/** Per-slot photo crops { photo, panel2 } with zoom [1,3] and pan [0,1]. */
function sanitizePhotoCrops(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const slot of ['photo', 'panel2']) {
    const c = raw[slot];
    if (!c || typeof c !== 'object') continue;
    const zoom = Number(c.zoom);
    if (!Number.isFinite(zoom)) continue;
    const panX = Number(c.panX);
    const panY = Number(c.panY);
    out[slot] = {
      zoom: Math.min(3, Math.max(1, zoom)),
      panX: Math.min(1, Math.max(0, Number.isFinite(panX) ? panX : 0.5)),
      panY: Math.min(1, Math.max(0, Number.isFinite(panY) ? panY : 0.5)),
    };
  }
  return Object.keys(out).length ? out : null;
}

/** Load a template by ID (cached after first read). */
const templateCache = {};
function loadTemplate(templateId) {
  if (templateCache[templateId]) return templateCache[templateId];
  const filePath = path.join(TEMPLATES_DIR, `${templateId}.json`);
  if (!fs.existsSync(filePath)) return null;
  templateCache[templateId] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return templateCache[templateId];
}

/**
 * POST /api/checkout
 *
 * Body: {
 *   templateId, sku, fields, poemText,
 *   style, layout, orderType
 * }
 *
 * Photos come from the server-side session (uploaded earlier via /api/images/upload).
 *
 * Returns: { checkoutUrl }
 */
router.post('/checkout', async (req, res) => {
  const db = req.app.locals.db;

  try {
    const { templateId, sku, fields, poemText, style, layout, orderType, colors, frameIcon, frameChoice, poemFirst, customRatios, photoCrops } = req.body;
    const safeFrameIcon = ['none', 'paw', 'heart'].includes(frameIcon) ? frameIcon : 'none';

    // Preview adjustments: panel ratios + photo zoom/pan (see sanitizers above)
    const safeRatios = sanitizeRatios(customRatios);
    const safeCrops = sanitizePhotoCrops(photoCrops);

    // Validate auto-matched colors (never trust client) — drop if malformed
    const HEX_RE = /^#[0-9a-fA-F]{6}$/;
    let safeColors = null;
    if (colors && HEX_RE.test(colors.mat) && HEX_RE.test(colors.bevel) && HEX_RE.test(colors.text)
        && (colors.tone === 'dark' || colors.tone === 'light')) {
      safeColors = { mat: colors.mat, bevel: colors.bevel, text: colors.text, tone: colors.tone };
      // Frame + accent (the 3D-printed frame color and engraved name/dates)
      if (HEX_RE.test(colors.frame)) safeColors.frame = colors.frame;
      if (HEX_RE.test(colors.accent)) safeColors.accent = colors.accent;
    }

    // Validate required fields
    if (!templateId || !sku) {
      return res.status(400).json({ error: 'templateId and sku are required' });
    }

    // Look up price from template (never trust client)
    const template = loadTemplate(templateId);
    if (!template) {
      return res.status(400).json({ error: `Unknown template: ${templateId}` });
    }

    const product = template.printProducts.find(p => p.sku === sku);
    if (!product) {
      return res.status(400).json({ error: `Unknown SKU: ${sku}` });
    }

    // Get photos from server-side session
    const photos = req.session.photos || {};
    if (Object.keys(photos).length === 0) {
      return res.status(400).json({ error: 'No photos uploaded. Please upload a photo first.' });
    }

    // Require a poem/letter
    if (!poemText || !poemText.trim()) {
      return res.status(400).json({ error: 'Please generate or select a poem before purchasing.' });
    }

    // A frame only applies to framed products. Digital keepsakes and print-only
    // SKUs have no frame, so they never resolve a frame or take a frame upcharge
    // (the customizer posts frameChoice regardless of the chosen rung, so
    // guarding here prevents charging for a frame the customer never receives).
    const isFramed = typeof sku === 'string' && sku.startsWith('framed-');
    // Resolve the chosen frame + its upcharge from the template (never trust
    // the client's price). Unknown/absent frame falls back to the default.
    let safeFrame = null;
    let frameUpcharge = 0;
    if (isFramed && template.frameOptions && Array.isArray(template.frameOptions.groups)) {
      for (const group of template.frameOptions.groups) {
        const match = (group.choices || []).find(c => c.id === frameChoice);
        if (match) { safeFrame = match.id; frameUpcharge = group.upchargeCents || 0; break; }
      }
      if (!safeFrame) safeFrame = template.frameOptions.default || null;
    }

    // Create order
    const orderId = uuidv4();
    const totalCents = product.price + frameUpcharge;

    db.run(
      `INSERT INTO orders (id, session_id, status, template_id, product_sku, fields_json, photos_json, poem_text, total_cents)
       VALUES (?, ?, 'pending_payment', ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        req.sessionID,
        templateId,
        sku,
        JSON.stringify({ ...fields, style, layout, orderType, frameIcon: safeFrameIcon, poemFirst: !!poemFirst, ...(safeFrame ? { frameChoice: safeFrame } : {}), ...(safeColors ? { colors: safeColors } : {}), ...(safeRatios ? { customRatios: safeRatios } : {}), ...(safeCrops ? { photoCrops: safeCrops } : {}) }),
        JSON.stringify(photos),
        poemText.trim(),
        totalCents
      ]
    );

    // Log event
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [orderId, 'order_created', JSON.stringify({ sku, totalCents, templateId })]
    );

    // Create Stripe Checkout Session
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;

    // Digital SKUs have nothing to ship, so they skip the shipping address
    // step and free-shipping line entirely. Everything else is identical.
    const isDigital = product.fulfillment === 'digital';

    const sessionParams = {
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${template.name} – ${product.label}`,
            description: isDigital
              ? 'Personalized memorial keepsake, high-resolution printable file.'
              : 'Personalized memorial wall art, museum-quality framed print. Free shipping.',
          },
          unit_amount: totalCents,
        },
        quantity: 1,
      }],
      metadata: { orderId },
      allow_promotion_codes: true,
      success_url: `${baseUrl}/order-confirmed?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/customize/${templateId}`,
    };

    if (!isDigital) {
      sessionParams.shipping_address_collection = {
        allowed_countries: ['US'],
      };
      sessionParams.shipping_options = [{
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: 0, currency: 'usd' },
          display_name: 'Free shipping',
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 5 },
            maximum: { unit: 'business_day', value: 10 },
          },
        },
      }];
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    // Save Stripe session ID on order
    db.run(
      `UPDATE orders SET stripe_session_id = ?, updated_at = datetime('now') WHERE id = ?`,
      [session.id, orderId]
    );

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session. Please try again.' });
  }
});

/**
 * GET /api/orders/confirmation?session_id=cs_xxx
 * Fetch order summary for the confirmation page.
 */
router.get('/orders/confirmation', async (req, res) => {
  const db = req.app.locals.db;
  const sessionId = req.query.session_id;

  if (!sessionId) {
    return res.status(400).json({ error: 'session_id is required' });
  }

  const order = db.get(
    'SELECT * FROM orders WHERE stripe_session_id = ?',
    [sessionId]
  );

  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const fieldsData = order.fields_json ? JSON.parse(order.fields_json) : {};
  const shipping = order.shipping_json ? JSON.parse(order.shipping_json) : null;

  res.json({
    orderId: order.id,
    status: order.status,
    templateId: order.template_id,
    sku: order.product_sku,
    totalCents: order.total_cents,
    email: order.email,
    proofToken: order.proof_token || null,
    shipping,
    style: fieldsData.style,
    createdAt: order.created_at,
  });
});

module.exports = router;
