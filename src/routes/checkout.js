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
    const { templateId, sku, fields, poemText, style, layout, orderType } = req.body;

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

    // Create order
    const orderId = uuidv4();
    const totalCents = product.price;

    db.run(
      `INSERT INTO orders (id, session_id, status, template_id, product_sku, fields_json, photos_json, poem_text, total_cents)
       VALUES (?, ?, 'pending_payment', ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        req.sessionID,
        templateId,
        sku,
        JSON.stringify({ ...fields, style, layout, orderType }),
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

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${template.name} – ${product.label}`,
            description: 'Personalized memorial wall art, museum-quality framed print. Free shipping.',
          },
          unit_amount: totalCents,
        },
        quantity: 1,
      }],
      shipping_address_collection: {
        allowed_countries: ['US'],
      },
      shipping_options: [{
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: 0, currency: 'usd' },
          display_name: 'Free shipping',
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 5 },
            maximum: { unit: 'business_day', value: 10 },
          },
        },
      }],
      metadata: { orderId },
      success_url: `${baseUrl}/order-confirmed?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/customize/${templateId}`,
    });

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
    shipping,
    style: fieldsData.style,
    createdAt: order.created_at,
  });
});

module.exports = router;
