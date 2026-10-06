/**
 * Partner gift links.
 *
 *   GET /gift/:slug        a practice's link, from their card or their email.
 *                          Remembers the partner on this visitor's session and
 *                          opens the designer.
 *   GET /gift/:slug/card.png
 *                          the practice's printable 4x6 card, as a download.
 *                          Public on purpose: it is the link we send a practice
 *                          when they say yes, so they can print it themselves,
 *                          and it shows nothing the card itself does not.
 *   GET /api/partner-gift  what the designer needs to show gift mode: who it is
 *                          from, whether the link can give a keepsake right now,
 *                          and the keepsake product itself.
 *
 * A link that is paused or has used its month still opens the designer and
 * still credits the practice: the family is not turned away, they just see
 * that the free keepsake is not available and can still have it framed.
 */

const express = require('express');
const partners = require('../services/partners');
const products = require('../services/products');

const router = express.Router();

// Partners give the pet tribute. Kept in one place so a second gift template
// later is a one-line change.
const GIFT_TEMPLATE_ID = 'pet-tribute';

function notFoundPage(res) {
  res.status(404).type('html').send(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Link not found – Still Beside Me</title>' +
    '<style>body{font-family:Georgia,"Times New Roman",serif;max-width:34rem;margin:16vh auto;' +
    'padding:0 1.5rem;color:#2b2b2b;line-height:1.6;text-align:center}h1{font-weight:400;font-size:1.6rem}' +
    'a{color:#8a5a44}</style></head><body>' +
    '<h1>We couldn’t find that gift link</h1>' +
    '<p>It may have been typed with a small difference. You can still ' +
    `<a href="/customize/${GIFT_TEMPLATE_ID}">make a tribute here</a>, or ` +
    '<a href="/contact">write to us</a> and we will sort it out.</p></body></html>'
  );
}

router.get('/gift/:slug', (req, res) => {
  const partner = partners.findBySlug(req.app.locals.db, String(req.params.slug || '').toLowerCase());
  if (!partner) return notFoundPage(res);

  req.session.partnerId = partner.id;
  req.session.save(() => res.redirect(302, `/customize/${GIFT_TEMPLATE_ID}?from=${partner.slug}`));
});

router.get('/gift/:slug/card.png', async (req, res) => {
  const partner = partners.findBySlug(req.app.locals.db, String(req.params.slug || '').toLowerCase());
  if (!partner) return notFoundPage(res);

  try {
    const { renderPartnerCard } = require('../services/partnerCard');
    const png = await renderPartnerCard(partner);
    res.type('png');
    res.attachment(`${partner.slug}-gift-card.png`);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(png);
  } catch (err) {
    console.error(`Partner card failed for ${partner.slug}:`, err.message);
    res.status(500).send('The card could not be made just now.');
  }
});

router.get('/api/partner-gift', (req, res) => {
  const db = req.app.locals.db;
  const partner = partners.findById(db, req.session && req.session.partnerId);
  const template = products.loadTemplate(GIFT_TEMPLATE_ID);
  const gift = products.giftProduct(template);
  if (!partner || !gift) return res.json({ partner: null });

  const availability = partners.giftAvailability(db, partner, gift.sku);
  res.json({
    partner: { name: partner.name, slug: partner.slug },
    templateId: GIFT_TEMPLATE_ID,
    available: availability.available,
    reason: availability.reason || null,
    product: gift,
  });
});

module.exports = router;
module.exports.GIFT_TEMPLATE_ID = GIFT_TEMPLATE_ID;
