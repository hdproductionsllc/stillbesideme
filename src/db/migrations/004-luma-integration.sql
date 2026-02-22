-- Luma Prints fulfillment integration
-- Drop-ship framed prints via Luma REST API (replaces WHCC as primary provider)

-- Track Luma fulfillment per order (mirrors whcc_orders)
CREATE TABLE IF NOT EXISTS luma_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  luma_order_number TEXT,
  status TEXT DEFAULT 'pending'
    CHECK(status IN ('pending','submitted','processing','shipped','error')),
  tracking_number TEXT,
  tracking_carrier TEXT,
  tracking_url TEXT,
  request_json TEXT,
  response_json TEXT,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT (datetime('now')),
  updated_at TIMESTAMP DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_luma_orders_order_id ON luma_orders(order_id);
CREATE INDEX IF NOT EXISTS idx_luma_orders_luma_order_number ON luma_orders(luma_order_number);

-- Track which provider fulfilled each order
ALTER TABLE orders ADD COLUMN fulfillment_provider TEXT DEFAULT 'whcc';
