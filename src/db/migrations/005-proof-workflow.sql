-- Proof approval workflow: add columns + expand status CHECK constraint

-- Add new columns
ALTER TABLE orders ADD COLUMN proof_token TEXT;
ALTER TABLE orders ADD COLUMN proof_approved_at TEXT;
ALTER TABLE orders ADD COLUMN change_request_notes TEXT;

-- Unique index for fast token lookups (public approval URLs)
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_proof_token ON orders(proof_token) WHERE proof_token IS NOT NULL;

-- Recreate orders table with expanded status constraint (adds pending_payment, change_requested)
-- SQLite does not support ALTER CHECK, so we use the standard recreate pattern.
CREATE TABLE orders_new (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id),
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_payment','submitted','proof_ready','proof_approved','change_requested','in_production','shipped','delivered','cancelled')),
  template_id TEXT NOT NULL,
  product_sku TEXT,
  fields_json TEXT,
  photos_json TEXT,
  poem_text TEXT,
  proof_url TEXT,
  print_file_url TEXT,
  shipping_json TEXT,
  total_cents INTEGER DEFAULT 0,
  stripe_session_id TEXT,
  stripe_payment_intent_id TEXT,
  email TEXT,
  fulfillment_provider TEXT,
  proof_token TEXT,
  proof_approved_at TEXT,
  change_request_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO orders_new SELECT
  id, customer_id, session_id, status, template_id, product_sku,
  fields_json, photos_json, poem_text, proof_url, print_file_url,
  shipping_json, total_cents, stripe_session_id, stripe_payment_intent_id,
  email, fulfillment_provider, proof_token, proof_approved_at,
  change_request_notes, created_at, updated_at
FROM orders;

DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_proof_token ON orders(proof_token) WHERE proof_token IS NOT NULL;
