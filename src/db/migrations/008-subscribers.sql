-- Email subscribers captured from the footer/popup signup form.
-- Stored in our own DB (on the /data volume) so no signup is ever lost,
-- regardless of whether a marketing platform (Mailchimp/Resend) is wired up.
-- The unique index dedupes repeat signups by the same address.
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);
