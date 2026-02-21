-- Stripe payment integration columns
ALTER TABLE orders ADD COLUMN stripe_session_id TEXT;
ALTER TABLE orders ADD COLUMN stripe_payment_intent_id TEXT;
ALTER TABLE orders ADD COLUMN email TEXT;
