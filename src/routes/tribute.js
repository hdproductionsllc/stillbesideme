/**
 * Tribute — the recipient-facing view of a gift.
 *
 * One URL with two entry points: the sender texts it the day they order ("this
 * is coming for you"), and the recipient scans the same link off the QR on the
 * note card when the frame arrives weeks later.
 *
 * It is deliberately NOT the order status page. /order/:proof_token exposes the
 * order total, the buyer's masked email, and the buyer's shipping city/state,
 * and it echoes proof_token — which also grants proof approval and print-file
 * download. A gift recipient must never receive any of that: at minimum they
 * would learn exactly what their friend paid for their dead pet's memorial.
 *
 * So this route keys off gift_token and hand-builds its payload. The projection
 * is an allowlist, not a redaction — new order columns can't leak here by
 * default, which matters because this link travels further than any other we
 * issue: printed on paper, texted to strangers, potentially forwarded on.
 */

const express = require('express');
const router = express.Router();

const { loadTemplate } = require('../services/tributeRenderer');

/**
 * GET /api/tribute/:giftToken
 *
 * Returns only what a recipient should see. No price, no buyer email, no
 * address, no proof token, no order id.
 */
router.get('/:giftToken', (req, res) => {
  const db = req.app.locals.db;
  const token = req.params.giftToken;

  if (!token || token.length < 8) {
    return res.status(404).json({ error: 'Tribute not found' });
  }

  const order = db.get('SELECT * FROM orders WHERE gift_token = ?', [token]);
  if (!order) {
    return res.status(404).json({ error: 'Tribute not found' });
  }

  const fields = order.fields_json ? JSON.parse(order.fields_json) : {};
  const template = loadTemplate(order.template_id);
  const mapping = (template && template.tributeMapping) || {};

  // The artwork only exists once a human has reviewed the poem and the customer
  // has approved the proof — print_file_url is written at that moment, so its
  // presence IS the readiness signal. Before then the page says "being made"
  // rather than showing a watermarked proof the recipient was never meant to
  // judge.
  const ready = !!order.print_file_url;

  res.json({
    ready,
    subjectName: fields[mapping.name] || '',
    birthDate: fields[mapping.birthDate] || '',
    passDate: fields[mapping.passDate] || '',
    poemText: ready ? (order.poem_text || '') : '',
    imageUrl: ready ? order.print_file_url : null,
    poemLabel: (template && template.poemLabel) || 'Poem',
    giftNote: (fields.giftNote || '').trim(),
    senderName: (fields.giftFrom || '').trim(),
  });
});

module.exports = router;
