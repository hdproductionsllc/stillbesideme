-- Customer reviews with real star ratings.
--
-- This table is deliberately SEPARATE from src/data/reviews.json. That file is
-- the canonical record of the 30 quotes the owner collected by hand, and none
-- of them carries a rating: no customer was ever asked to score their grief, so
-- no rating data exists for them and none may be invented. Those quotes stay
-- unrated forever and are published as Review schema without reviewRating.
--
-- Everything in THIS table is different in kind: a rating a named customer
-- chose themselves, tied to an order they actually paid for, submitted through
-- their own tokenized link. Only rows here may ever feed an AggregateRating,
-- and the aggregate must reflect exactly the published rows, nothing else.
--
-- Access reuses the order's existing proof_token rather than minting a fifth
-- capability token. The customer already holds that link, it is already
-- unguessable and already tied to one order, and the authority it grants here
-- (leave a review of your own piece) is strictly narrower than the authority it
-- already grants (approve the proof, download the print file).

CREATE TABLE IF NOT EXISTS customer_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),

  -- The rating the customer chose. NOT NULL: a row in this table exists
  -- because someone rated something. Unrated feedback belongs in reviews.json.
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),

  body TEXT,

  -- How they want to be credited, e.g. "Keith L.". Blank means the owner
  -- decides at moderation time; it is never auto-filled from the order.
  author_display TEXT,

  -- Consent is per-review and explicit. Without it the review is private
  -- feedback to the shop and must never appear on a page, whatever its status.
  consent_to_publish INTEGER NOT NULL DEFAULT 0,

  -- FTC Rule on Consumer Reviews (2024): a review from someone who received the
  -- product free or discounted must carry a visible disclosure wherever it is
  -- shown. This flag is the source of truth for that label. It is set by the
  -- shop at moderation time, not by the customer, because the shop is the one
  -- who knows what was comped.
  incentivised INTEGER NOT NULL DEFAULT 0,

  -- pending: submitted, not yet looked at. Nothing auto-publishes.
  -- published: visible on the site and counted in the aggregate.
  -- hidden: seen and set aside. Never shown, never counted.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','hidden')),

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
);

-- One review per order. This is the hard guarantee behind the "you have already
-- left a review" response; the route's pre-check is only the friendly path.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_reviews_order ON customer_reviews(order_id);

-- The aggregate helper and the moderation queue are the only two readers, and
-- both filter on status first.
CREATE INDEX IF NOT EXISTS idx_customer_reviews_status ON customer_reviews(status);
