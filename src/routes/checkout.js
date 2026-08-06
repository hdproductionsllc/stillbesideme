/**
 * Checkout routes — proof-before-payment.
 *
 *   POST /api/checkout/proof  → create-or-update this session's draft order,
 *                               render the real watermarked proof, return it.
 *   POST /api/checkout        → record the customer's approval of that proof,
 *                               then create the Stripe Checkout Session.
 *   GET  /api/orders/confirmation
 *
 * THE ORDER OF OPERATIONS IS THE POINT. The customer sees their actual
 * server-rendered proof — the same renderer that produces the file we print —
 * and approves it BEFORE any money moves. The approval (its timestamp and the
 * exact proof URL that was on screen) is written to the database and to
 * order_events BEFORE the Stripe session is created, so there is never a paid
 * order whose approval we cannot evidence. That record is the chargeback
 * defence; do not move it after the Stripe call to save a round-trip.
 *
 * Nothing about price ever comes from the client. Every request re-derives the
 * price from the template on disk, re-runs every sanitizer below, and
 * /api/checkout additionally refuses to proceed if the payload no longer
 * matches the order the proof was rendered from.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const TEMPLATES_DIR = path.join(__dirname, '..', 'data', 'templates');

// Proof rendering is Sharp compositing several full-size photo layers. It is
// normally a couple of seconds, but a pathological upload must never leave a
// grieving customer staring at a spinner with no way forward — so the render
// is raced against this ceiling and a failure is answered with a plain,
// retryable error instead of a hung request.
const PROOF_TIMEOUT_MS = Number(process.env.PROOF_TIMEOUT_MS) || 25000;

// Statuses a session's order may still be edited/approved/paid in. Anything
// beyond this is paid for and must never be mutated by a customizer request.
const OPEN_ORDER_STATUSES = ['draft', 'pending_payment'];

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

/**
 * Keep only the fields the template declares, each clamped to its declared
 * maxLength. An allowlist rather than a filter: the blob it produces is spread
 * into fields_json alongside trusted server-derived keys (style, colors,
 * frameChoice…), so an unknown client key landing here could shadow one of them.
 *
 * poemText is excluded deliberately — it travels in its own column and is
 * validated separately; letting a 600-char field cap truncate a poem would be
 * a silent data loss.
 */
function sanitizeFields(raw, template) {
  if (!raw || typeof raw !== 'object') return {};

  const out = {};
  for (const field of template.memoryFields || []) {
    if (field.type === 'poem-selector') continue;

    const value = raw[field.id];
    if (typeof value !== 'string') continue;

    const trimmed = value.trim();
    if (!trimmed) continue;

    out[field.id] = field.maxLength ? trimmed.slice(0, field.maxLength) : trimmed;
  }
  return out;
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
 * Validate + sanitize a customizer payload into the exact row content an order
 * should hold, deriving the price server-side from the template.
 *
 * This is the single source of truth for BOTH endpoints. /api/checkout/proof
 * writes what it returns; /api/checkout re-runs it and compares, so the thing
 * the customer pays for is provably the thing they were shown.
 *
 * @returns {{ error: string }} on rejection, otherwise the resolved draft.
 */
function buildOrderDraft(req) {
  const {
    templateId, sku, fields, poemText, style, layout, orderType,
    colors, frameIcon, frameChoice, poemFirst, customRatios, photoCrops,
  } = req.body;

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
    return { error: 'templateId and sku are required' };
  }

  // Look up price from template (never trust client)
  const template = loadTemplate(templateId);
  if (!template) {
    return { error: `Unknown template: ${templateId}` };
  }

  const product = template.printProducts.find(p => p.sku === sku);
  if (!product) {
    return { error: `Unknown SKU: ${sku}` };
  }

  // Get photos from server-side session
  const photos = req.session.photos || {};
  if (Object.keys(photos).length === 0) {
    return { error: 'No photos uploaded. Please upload a photo first.' };
  }

  // Require a poem/letter
  if (!poemText || !poemText.trim()) {
    return { error: 'Please generate or select a poem before purchasing.' };
  }

  // A frame only applies to framed products. Digital keepsakes and print-only
  // SKUs have no frame, so they never resolve a frame or take a frame upcharge
  // (the customizer posts frameChoice regardless of the chosen rung, so
  // guarding here prevents charging for a frame the customer never receives).
  const isFramed = typeof sku === 'string' && sku.startsWith('framed-');
  // Resolve the chosen frame + its upcharge from the template (never trust
  // the client's price). Unknown/absent frame falls back to the default.
  // A frame group may be gated by print size (signature frames only on
  // larger prints via minShortSideIn) — a group whose size floor the SKU
  // doesn't meet is skipped, so a manipulated client can't buy a $60
  // signature frame on an 8x10 where it isn't offered.
  let safeFrame = null;
  let frameUpcharge = 0;
  if (isFramed && template.frameOptions && Array.isArray(template.frameOptions.groups)) {
    const sizeMatch = sku.match(/(\d+)x(\d+)/);
    const shortSideIn = sizeMatch ? Math.min(Number(sizeMatch[1]), Number(sizeMatch[2])) : 0;
    for (const group of template.frameOptions.groups) {
      if (group.minShortSideIn && shortSideIn < group.minShortSideIn) continue;
      const match = (group.choices || []).find(c => c.id === frameChoice);
      if (match) { safeFrame = match.id; frameUpcharge = group.upchargeCents || 0; break; }
    }
    if (!safeFrame) safeFrame = template.frameOptions.default || null;
  }

  // Clamp customer-authored text to the lengths the template declares. The
  // client's `maxlength` is cosmetic — every other value posted here (colors,
  // ratios, crops, frame) is re-derived or sanitized server-side, and `fields`
  // was the one hole. It matters most for giftNote: it is rendered onto a
  // fixed-height sheet of paper, so an unbounded note doesn't just look wrong,
  // it silently runs off the page Luma prints.
  const safeFields = sanitizeFields(fields, template);

  // Order type drives which fields are shown, printed, and sent to Luma —
  // an arbitrary client string must not flow through as one of them.
  const safeOrderType = orderType === 'gift' ? 'gift' : 'self';

  return {
    templateId,
    sku,
    template,
    product,
    totalCents: product.price + frameUpcharge,
    fieldsJson: JSON.stringify({
      ...safeFields,
      style,
      layout,
      orderType: safeOrderType,
      frameIcon: safeFrameIcon,
      poemFirst: !!poemFirst,
      ...(safeFrame ? { frameChoice: safeFrame } : {}),
      ...(safeColors ? { colors: safeColors } : {}),
      ...(safeRatios ? { customRatios: safeRatios } : {}),
      ...(safeCrops ? { photoCrops: safeCrops } : {}),
    }),
    photosJson: JSON.stringify(photos),
    poemText: poemText.trim(),
  };
}

/**
 * The order this browser session is currently building, if any.
 *
 * Re-proofing after an edit must land on the SAME row — otherwise every tweak
 * of a comma leaves an abandoned order behind, and the admin dashboard fills
 * with ghosts. Only rows that are still open (never paid) are eligible.
 */
function findOpenSessionOrder(db, sessionId) {
  if (!sessionId) return null;
  return db.get(
    `SELECT * FROM orders
      WHERE session_id = ? AND status IN ('draft', 'pending_payment')
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1`,
    [sessionId]
  );
}

/**
 * Race a promise against a ceiling so a wedged render can never hold a request
 * open. The underlying work is not cancellable (Sharp is already in flight on
 * a libuv thread), but the customer gets an answer either way — which is the
 * thing that matters.
 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const ceiling = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, ceiling]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * POST /api/checkout/proof
 *
 * Body: the full customizer payload — the same shape POST /api/checkout takes
 * (templateId, sku, fields, poemText, style, layout, orderType, colors,
 * frameIcon, frameChoice, poemFirst, customRatios, photoCrops). Photos come
 * from the server-side session (uploaded earlier via /api/images/upload).
 *
 * Creates or updates this session's draft order, renders the real watermarked
 * proof from it, and returns it for the customer to approve.
 *
 * Returns: { orderId, proofUrl }
 */
router.post('/checkout/proof', async (req, res) => {
  const db = req.app.locals.db;

  try {
    const draft = buildOrderDraft(req);
    if (draft.error) {
      return res.status(400).json({ error: draft.error });
    }

    // Create-or-update this session's open order. Editing invalidates any
    // approval already on the row: the customer approved a picture, and this
    // is no longer that picture.
    const existing = findOpenSessionOrder(db, req.sessionID);
    let orderId;

    if (existing) {
      orderId = existing.id;
      db.run(
        `UPDATE orders SET
           status = 'draft',
           template_id = ?,
           product_sku = ?,
           fields_json = ?,
           photos_json = ?,
           poem_text = ?,
           total_cents = ?,
           proof_approved_at = NULL,
           proof_approved_url = NULL,
           updated_at = datetime('now')
         WHERE id = ?`,
        [draft.templateId, draft.sku, draft.fieldsJson, draft.photosJson,
          draft.poemText, draft.totalCents, orderId]
      );
      db.run(
        `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
        [orderId, 'draft_updated', JSON.stringify({
          sku: draft.sku, totalCents: draft.totalCents, templateId: draft.templateId,
        })]
      );
    } else {
      orderId = uuidv4();
      db.run(
        `INSERT INTO orders (id, session_id, status, template_id, product_sku, fields_json, photos_json, poem_text, total_cents)
         VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
        [orderId, req.sessionID, draft.templateId, draft.sku, draft.fieldsJson,
          draft.photosJson, draft.poemText, draft.totalCents]
      );
      db.run(
        `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
        [orderId, 'order_created', JSON.stringify({
          sku: draft.sku, totalCents: draft.totalCents, templateId: draft.templateId,
        })]
      );
    }

    // Render the real proof — the same renderer, from the same row, that the
    // print file will later be built from.
    const proofGenerator = require('../services/proofGenerator');
    const orderRow = db.get('SELECT * FROM orders WHERE id = ?', [orderId]);

    let proofRelativeUrl;
    try {
      const result = await withTimeout(
        proofGenerator.generateProof(orderRow), PROOF_TIMEOUT_MS, 'Proof generation'
      );
      proofRelativeUrl = result.proofRelativeUrl;
    } catch (err) {
      console.error(`Failed to generate proof for draft order ${orderId}:`, err.message);
      db.run(
        `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
        [orderId, 'proof_generation_failed', JSON.stringify({ error: err.message, stage: 'pre_payment' })]
      );
      return res.status(503).json({
        error: 'We couldn’t finish preparing your proof just now. Please try again in a moment — nothing has been charged.',
        code: 'proof_failed',
      });
    }

    // The proof file is always output/proofs/{orderId}.jpg, so every re-render
    // overwrites it. The `?v=` stamp gives each render a distinct URL: it keeps
    // an edited proof from showing through a cached image, and — more
    // importantly — makes the approval record below point at one specific
    // render rather than at a path whose contents may since have changed.
    const proofUrl = `${proofRelativeUrl}?v=${Date.now()}`;

    db.run(
      `UPDATE orders SET proof_url = ?, updated_at = datetime('now') WHERE id = ?`,
      [proofUrl, orderId]
    );
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [orderId, 'proof_generated', JSON.stringify({ proofUrl, stage: 'pre_payment' })]
    );

    res.json({ orderId, proofUrl });
  } catch (err) {
    console.error('Proof preparation error:', err);
    res.status(500).json({ error: 'We couldn’t prepare your proof. Please try again.' });
  }
});

/**
 * POST /api/checkout
 *
 * Body: the same customizer payload as /api/checkout/proof, PLUS
 *   { orderId, approved: true }
 * — the id returned by /api/checkout/proof and the customer's explicit
 * approval of the proof they were shown for it.
 *
 * Refuses with 400 if the approval is missing, if the order isn't this
 * session's, or if the payload no longer matches the order the proof was
 * rendered from (they edited something after approving — the UI must fetch a
 * fresh proof and ask again).
 *
 * Records the approval — timestamp and exact proof URL — in `orders` and in
 * `order_events` BEFORE the Stripe session is created.
 *
 * Returns: { checkoutUrl }
 */
router.post('/checkout', async (req, res) => {
  const db = req.app.locals.db;

  try {
    const { orderId, approved } = req.body;

    // No approval, no payment. This is the whole gate.
    if (approved !== true && approved !== 'true') {
      return res.status(400).json({
        error: 'Please review and approve your proof before continuing to payment.',
        code: 'approval_required',
      });
    }
    if (!orderId || typeof orderId !== 'string') {
      return res.status(400).json({
        error: 'Please review and approve your proof before continuing to payment.',
        code: 'approval_required',
      });
    }

    // Scoped to this browser session — an order id alone must never be enough
    // to drive someone else's order to checkout.
    const order = db.get(
      'SELECT * FROM orders WHERE id = ? AND session_id = ?',
      [orderId, req.sessionID]
    );
    if (!order) {
      return res.status(404).json({
        error: 'We couldn’t find your tribute. Please review your proof again.',
        code: 'order_not_found',
      });
    }
    if (!OPEN_ORDER_STATUSES.includes(order.status)) {
      return res.status(400).json({
        error: 'This tribute has already been paid for.',
        code: 'already_paid',
      });
    }
    if (!order.proof_url) {
      return res.status(400).json({
        error: 'Please review and approve your proof before continuing to payment.',
        code: 'proof_missing',
      });
    }

    // Re-validate and re-derive everything from the template. The price is
    // never read from the request.
    const draft = buildOrderDraft(req);
    if (draft.error) {
      return res.status(400).json({ error: draft.error });
    }

    // The approval must describe the artwork we are about to charge for. If
    // anything moved since the proof was rendered — a field, the poem, the
    // photo, the size, the frame — the approval on file is for a different
    // picture, so we stop and ask the UI to show the new one.
    const stale =
      order.template_id !== draft.templateId ||
      order.product_sku !== draft.sku ||
      order.fields_json !== draft.fieldsJson ||
      order.photos_json !== draft.photosJson ||
      (order.poem_text || '') !== draft.poemText ||
      Number(order.total_cents) !== draft.totalCents;

    if (stale) {
      return res.status(400).json({
        error: 'Your tribute has changed since that proof was made. Please take one more look at the updated proof before you pay.',
        code: 'proof_stale',
      });
    }

    // ── Record the approval. This happens BEFORE Stripe, deliberately: it is
    // the evidence that the customer saw and accepted this exact artwork, and
    // an order must never be able to reach a payment page without it.
    const approvedAt = new Date().toISOString();
    db.run(
      `UPDATE orders SET
         status = 'pending_payment',
         proof_approved_at = datetime('now'),
         proof_approved_url = ?,
         updated_at = datetime('now')
       WHERE id = ?`,
      [order.proof_url, orderId]
    );
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [orderId, 'proof_approved_inline', JSON.stringify({
        proofUrl: order.proof_url,
        approvedAt,
        templateId: draft.templateId,
        sku: draft.sku,
        totalCents: draft.totalCents,
        ip: req.ip || null,
        userAgent: String(req.get('user-agent') || '').slice(0, 300),
      })]
    );

    // Create Stripe Checkout Session
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;

    // Because the order row is reused across edits, an earlier Stripe session
    // may still be live against a version of this tribute that no longer
    // exists — and it would charge that old price. Close it first. Best-effort:
    // an already-expired or already-completed session throws, and neither is a
    // reason to block this payment.
    if (order.stripe_session_id) {
      try {
        await stripe.checkout.sessions.expire(order.stripe_session_id);
      } catch (err) {
        console.log(`Order ${orderId}: previous Stripe session not expired (${err.message})`);
      }
    }

    // Digital SKUs have nothing to ship, so they skip the shipping address
    // step and free-shipping line entirely. Everything else is identical.
    const isDigital = draft.product.fulfillment === 'digital';

    const sessionParams = {
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${draft.template.name} – ${draft.product.label}`,
            description: isDigital
              ? 'Personalized memorial keepsake, high-resolution printable file.'
              : 'Personalized memorial wall art, museum-quality framed print. Free shipping.',
          },
          unit_amount: draft.totalCents,
        },
        quantity: 1,
      }],
      metadata: { orderId },
      allow_promotion_codes: true,
      success_url: `${baseUrl}/order-confirmed?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/customize/${draft.templateId}`,
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
            minimum: { unit: 'business_day', value: 8 },
            maximum: { unit: 'business_day', value: 12 },
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

  // Story vault (created by the payment webhook): the confirmation page uses
  // this to show the "may we remember them with you?" opt-in card. A missing
  // vault (legacy orders, webhook race) just means no card — never an error.
  const vault = db.get(
    'SELECT token, pet_name, birthday_mmdd, gotcha_mmdd, passing_mmdd, passing_year FROM vaults WHERE order_id = ?',
    [order.id]
  );

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
    vaultToken: vault ? vault.token : null,
    petName: (vault && vault.pet_name) || fieldsData.petName || '',
    vaultDates: vault ? {
      birthday: vault.birthday_mmdd,
      gotchaDay: vault.gotcha_mmdd,
      passingDay: vault.passing_mmdd,
      passingYear: vault.passing_year,
    } : {},
  });
});

module.exports = router;
