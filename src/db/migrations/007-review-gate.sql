-- Review gate: every proof passes human review before the customer email.
-- Adds 'awaiting_review' to the status CHECK (SQLite recreate pattern) plus
-- reviewed_at (when a human approved the proof for sending) and uv_file_url
-- (programmatic UV frame inscription file, generated from order data only).
--
-- Foreign keys are disabled for the recreate: order_events, whcc_orders and
-- luma_orders reference orders(id), and DROP TABLE on the parent would fail
-- against a database that already has child rows.
PRAGMA foreign_keys = OFF;

CREATE TABLE orders_new (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id),
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_payment','submitted','awaiting_review','proof_ready','proof_approved','change_requested','in_production','shipped','delivered','cancelled')),
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
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  admin_token TEXT,
  tracking_number TEXT,
  tracking_carrier TEXT,
  tracking_url TEXT,
  reviewed_at TEXT,
  uv_file_url TEXT
);

INSERT INTO orders_new (
  id, customer_id, session_id, status, template_id, product_sku,
  fields_json, photos_json, poem_text, proof_url, print_file_url,
  shipping_json, total_cents, stripe_session_id, stripe_payment_intent_id,
  email, fulfillment_provider, proof_token, proof_approved_at,
  change_request_notes, created_at, updated_at,
  admin_token, tracking_number, tracking_carrier, tracking_url
) SELECT
  id, customer_id, session_id, status, template_id, product_sku,
  fields_json, photos_json, poem_text, proof_url, print_file_url,
  shipping_json, total_cents, stripe_session_id, stripe_payment_intent_id,
  email, fulfillment_provider, proof_token, proof_approved_at,
  change_request_notes, created_at, updated_at,
  admin_token, tracking_number, tracking_carrier, tracking_url
FROM orders;

DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_proof_token ON orders(proof_token) WHERE proof_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_admin_token ON orders(admin_token) WHERE admin_token IS NOT NULL;

PRAGMA foreign_keys = ON;
