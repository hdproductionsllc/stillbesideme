-- Where an order came from, and how its customer approved it.
--
-- Until now every order was born the same way: a buyer filled in the
-- customizer, approved their own proof inline, and paid through Stripe. One
-- door, and the approval arrived as a side effect of walking through it.
--
-- An Etsy buyer pays on Etsy. They never touch our checkout, so nothing
-- creates the row, and they have never seen a proof. Both gaps are filled by
-- hand (and later by the order.paid webhook), which means the order row now
-- has to carry two facts it could previously take for granted.
--
-- source: which door. 'direct' for our own checkout, 'etsy' for a marketplace
-- order. Drives the admin badge, the approval branch on the review page, and
-- later the shipment sync back to Etsy. Defaulted so every existing row is
-- correctly 'direct' without a backfill.
--
-- etsy_receipt_id: the marketplace's own order number, UNIQUE so that a
-- double-submitted form (or, later, eight webhook retries) cannot produce
-- eight tributes for one sale. NULLs are distinct in SQLite, so every direct
-- order coexists happily under the same index.
--
-- approval_channel / approval_evidence: HOW the customer approved.
--
--   The printer gate in adminReview.js asks a question about evidence, not
--   about mechanism: did the customer accept THIS proof image, at THIS time?
--   proof_approved_url + proof_approved_at answer it. A buyer who says yes in
--   an Etsy message is answering the same question, so recording their
--   approval writes the same two fields and the release path needs no changes
--   at all.
--
--   What those two fields cannot say is who asked, and what the customer
--   actually said. On the web the answer is implicit: they clicked their own
--   tokenized link, so the click IS the record. An Etsy approval is a human
--   reading a conversation and deciding it counts, so the words that convinced
--   them get stored beside it. If a buyer ever says they never approved
--   anything, the evidence is on the order rather than in somebody's memory.

ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE orders ADD COLUMN etsy_receipt_id INTEGER;
ALTER TABLE orders ADD COLUMN approval_channel TEXT;
ALTER TABLE orders ADD COLUMN approval_evidence TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_etsy_receipt ON orders(etsy_receipt_id);
CREATE INDEX IF NOT EXISTS idx_orders_source ON orders(source);
