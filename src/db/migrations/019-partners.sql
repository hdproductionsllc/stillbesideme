-- Partners: the vets, home-euthanasia practices and crematoriums who hand our
-- tribute to a family as a gift.
--
-- A partner is a row, not code. Rebecca writes to a practice; when it says
-- yes, the shop adds one row here and the practice has its own link
-- (/gift/<slug>) and its own printable card. Nothing else changes per partner.
--
-- The family who follows that link makes their tribute exactly as a paying
-- customer does, and receives a screen-quality keepsake marked as a gift from
-- the practice, at no cost. The print-quality file only ever comes with a
-- framed order, which they can place from the same design at full price.
--
-- monthly_cap: how many free keepsakes one link can make in a calendar month.
-- A busy home-euthanasia vet sees twenty to forty families a month; thirty
-- covers a normal month, and the shop raises it for anyone who reaches it. It
-- exists because the link is printed on cards that can travel anywhere.
--
-- active: a link can be paused without deleting the partner or the history of
-- what it sent us.
--
-- orders.partner_id: who sent this order, gift or paid. Until now nothing
-- recorded where an order came from at all (scripts/acquisition-report.js says
-- so outright). A framed order placed from a gift keepsake keeps the partner,
-- so the shop can see which practices actually lead to framed pieces.

CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'clinic',
  contact_email TEXT,
  monthly_cap INTEGER NOT NULL DEFAULT 30,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_partners_slug ON partners(slug);

ALTER TABLE orders ADD COLUMN partner_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_orders_partner ON orders(partner_id);
