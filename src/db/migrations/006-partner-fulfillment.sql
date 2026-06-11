-- Partner UV-print fulfillment: tokenized admin link + order-level tracking.
--
-- admin_token is deliberately SEPARATE from proof_token: the customer-facing
-- proof/status link must never be able to mutate fulfillment state.
-- Tracking columns live on orders (not luma_orders) so partner-fulfilled
-- orders surface tracking on the status page without faking a Luma row.

ALTER TABLE orders ADD COLUMN admin_token TEXT;
ALTER TABLE orders ADD COLUMN tracking_number TEXT;
ALTER TABLE orders ADD COLUMN tracking_carrier TEXT;
ALTER TABLE orders ADD COLUMN tracking_url TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_admin_token ON orders(admin_token) WHERE admin_token IS NOT NULL;
