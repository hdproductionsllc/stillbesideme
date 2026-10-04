/**
 * Admin: partners (the practices that give our tribute as a gift).
 *
 *   GET  /admin/partners                  the page
 *   GET  /admin/api/partners              every partner, with what it has sent us
 *   POST /admin/api/partners              add one (a practice said yes)
 *   POST /admin/api/partners/:id          pause / resume, change the monthly cap
 *   GET  /admin/api/partners/:id/card.png the printable 4x6 card for them
 *
 * Behind the same admin gate as the orders dashboard.
 */

const express = require('express');
const path = require('path');
const { requireAdmin } = require('./adminDashboard');
const partners = require('../services/partners');
const products = require('../services/products');
const { renderPartnerCard, giftUrlFor } = require('../services/partnerCard');
const { GIFT_TEMPLATE_ID } = require('./partnerGift');

const router = express.Router();

function giftSku() {
  const gift = products.giftProduct(products.loadTemplate(GIFT_TEMPLATE_ID));
  return gift ? gift.sku : null;
}

function shape(p) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    kind: p.kind,
    contactEmail: p.contact_email || '',
    monthlyCap: p.monthly_cap,
    active: !!p.active,
    notes: p.notes || '',
    link: giftUrlFor(p),
    giftsGiven: p.giftsGiven || 0,
    giftsThisMonth: p.giftsThisMonth || 0,
    paidOrders: p.paidOrders || 0,
    paidCents: p.paidCents || 0,
    createdAt: p.created_at,
  };
}

router.get('/partners', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin', 'partners.html'));
});

router.get('/api/partners', requireAdmin, (req, res) => {
  const list = partners.listWithStats(req.app.locals.db, giftSku());
  res.json({ partners: list.map(shape), kinds: partners.KINDS });
});

router.post('/api/partners', requireAdmin, express.json(), (req, res) => {
  const result = partners.createPartner(req.app.locals.db, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ partner: shape(result.partner) });
});

router.post('/api/partners/:id', requireAdmin, express.json(), (req, res) => {
  const updated = partners.updatePartner(req.app.locals.db, Number(req.params.id), req.body || {});
  if (!updated) return res.status(404).json({ error: 'Partner not found' });
  res.json({ partner: shape(updated) });
});

router.get('/api/partners/:id/card.png', requireAdmin, async (req, res) => {
  const partner = partners.findById(req.app.locals.db, Number(req.params.id));
  if (!partner) return res.status(404).send('Partner not found');
  try {
    const png = await renderPartnerCard(partner);
    res.type('png');
    if (req.query.download === '1') {
      res.attachment(`${partner.slug}-gift-card.png`);
    }
    res.send(png);
  } catch (err) {
    console.error(`Partner card failed for ${partner.slug}:`, err.message);
    res.status(500).send('The card could not be made just now.');
  }
});

module.exports = router;
