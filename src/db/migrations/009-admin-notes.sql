-- Free-text support notes per order, written by the admin from the dashboard
-- (e.g. "customer called, reshipping to new address"). Keeps support context
-- with the order instead of scattered across emails.
ALTER TABLE orders ADD COLUMN admin_notes TEXT;
