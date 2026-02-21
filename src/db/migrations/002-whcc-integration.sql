-- WHCC Print Lab Integration
-- Catalog cache, product mapping, and order fulfillment tracking

-- Raw WHCC catalog JSON, refreshed every 24 hours
CREATE TABLE IF NOT EXISTS whcc_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  catalog_type TEXT NOT NULL UNIQUE,  -- 'order' or 'editor'
  data_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Maps our product SKUs to WHCC product identifiers
CREATE TABLE IF NOT EXISTS whcc_product_map (
  sku TEXT PRIMARY KEY,               -- our SKU: framed-8x10, framed-11x14, etc.
  whcc_product_uid TEXT NOT NULL,
  whcc_node_id TEXT,
  whcc_attribute_uids TEXT,           -- JSON array of attribute UIDs
  description TEXT,                   -- human-readable note
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tracks WHCC fulfillment per order
CREATE TABLE IF NOT EXISTS whcc_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  entry_id TEXT,                      -- our reference sent to WHCC
  confirmation_id TEXT,               -- WHCC's ConfirmationID after import
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','imported','submitted','accepted','rejected','shipped','error')),
  tracking_number TEXT,
  tracking_carrier TEXT,
  tracking_url TEXT,
  request_json TEXT,                  -- full request payload (debug)
  response_json TEXT,                 -- full response payload (debug)
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_whcc_orders_order ON whcc_orders(order_id);
CREATE INDEX IF NOT EXISTS idx_whcc_orders_confirmation ON whcc_orders(confirmation_id);
CREATE INDEX IF NOT EXISTS idx_whcc_orders_status ON whcc_orders(status);
