-- Story Vault: a private, tokenized page for each paid order that keeps the
-- pet's tribute alive, and — only if the family opts in — emails them on the
-- days that matter: the pet's birthday, their "gotcha day", and the anniversary
-- of their passing.
--
-- Kept in its own tables rather than as columns on `orders` because a vault has
-- a lifecycle the order does not: it outlives fulfillment, carries its own
-- opt-in consent and unsubscribe state, and accrues a per-occasion send log.
-- The vault token is a fourth capability token (after proof/admin/gift): it
-- grants read-only access to the story page and the power to set the dates or
-- unsubscribe — nothing about the order, the buyer, or the price.

CREATE TABLE IF NOT EXISTS vaults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT REFERENCES orders(id),
  email TEXT,
  pet_name TEXT,
  token TEXT UNIQUE,
  opt_in INTEGER DEFAULT 0,        -- family asked us to remember these days
  opt_out INTEGER DEFAULT 0,       -- family unsubscribed (wins over opt_in)
  birthday_mmdd TEXT,              -- 'MM-DD', NULL until known
  gotcha_mmdd TEXT,                -- 'MM-DD', NULL until known
  passing_mmdd TEXT,               -- 'MM-DD', NULL until known
  passing_year INTEGER,            -- year of passing (drives "N years" copy)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vaults_token ON vaults(token);
CREATE INDEX IF NOT EXISTS idx_vaults_order ON vaults(order_id);

-- One row per (vault, occasion, year) that we ACTUALLY sent. The date engine
-- checks this before sending so an occasion goes out at most once per calendar
-- year, no matter how often the daily timer runs. The UNIQUE constraint is the
-- hard guarantee; the engine's pre-check is the fast path.
CREATE TABLE IF NOT EXISTS vault_email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id INTEGER NOT NULL REFERENCES vaults(id),
  occasion TEXT NOT NULL CHECK (occasion IN ('birthday','gotcha','anniversary')),
  year INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(vault_id, occasion, year)
);

CREATE INDEX IF NOT EXISTS idx_vault_email_log_vault ON vault_email_log(vault_id);
