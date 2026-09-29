-- Saved designs: a tribute someone started and wants to come back to.
--
-- Until now a design lived only in the browser tab that made it. Close the tab
-- and it was gone; open the site on a phone and there was nothing there. The
-- photo was tied to the server session rather than to anything durable, so even
-- a link back could not have restored it on another device.
--
-- A row here is the whole design: the designer's own state exactly as the page
-- saves it, plus the server-side photo records, reachable by one unguessable
-- token. The same token serves the "Email me my design" link and the
-- abandoned-checkout email, so both bring a family back to THEIR tribute
-- rather than to a blank page.
--
-- email is optional. The proof step saves the design quietly (no email) and
-- links it to the draft order, so an abandoned Stripe checkout can still
-- point at it. A design is only ever emailed about when someone typed their
-- address into the designer and asked for it.
--
-- One reminder, ever. reminder_sent_at is its idempotency record, written only
-- after a real send. reminders_off is the family's own "stop" switch.
--
-- Designs expire (expires_at, 90 days from the last save). An expired token
-- restores nothing and the daily engine removes the row.

CREATE TABLE IF NOT EXISTS saved_designs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  template_id TEXT NOT NULL,
  email TEXT,
  pet_name TEXT,
  state_json TEXT NOT NULL,
  photos_json TEXT,
  order_id TEXT,
  saved_email_sent_at TEXT,
  reminder_sent_at TEXT,
  reminders_off INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL DEFAULT (datetime('now', '+90 days'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_designs_token ON saved_designs(token);
CREATE INDEX IF NOT EXISTS idx_saved_designs_order ON saved_designs(order_id);
CREATE INDEX IF NOT EXISTS idx_saved_designs_email ON saved_designs(email);
