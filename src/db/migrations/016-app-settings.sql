-- A place for credentials the running app has to rewrite by itself.
--
-- Everything this app needs to talk to somebody else has lived in the
-- environment: Stripe keys, the Luma credentials, the Resend key. That works
-- because those secrets are handed to us once and never change on their own.
-- We read them, we never write them, and Railway owns the copy of record.
--
-- Etsy breaks that assumption. Its OAuth refresh grant is single use: every
-- time we trade a refresh token for a fresh hour of access, Etsy hands back a
-- NEW refresh token and retires the one we just presented. Miss one rotation
-- and the shop is locked out until a human sits down and reauthorizes by hand.
-- An environment variable cannot rewrite itself, so the only safe home for
-- that credential is somewhere the process can write the moment it rotates,
-- and somewhere that survives a restart and a redeploy. That is this table,
-- sitting on the same Railway volume as the orders it exists to fetch.
--
-- Why a generic key/value table rather than an etsy_auth table with named
-- columns: under sql.js there is no ALTER-anything-you-like. Changing a
-- column's type, or a CHECK, or dropping one means the full recreate-and-copy
-- dance you can see in 007-review-gate.sql, foreign keys off, child tables
-- held at arm's length, the whole orders table rewritten to add one field.
-- More Etsy state is already on its way (the shop id we discover, the
-- timestamp of the last receipt pull, the sample receipt we keep so a human
-- can see what the mapper actually received), and none of it is worth a
-- migration each. A key and a JSON blob absorb all of it without ever
-- touching the schema again.
--
-- value is TEXT NOT NULL because every writer goes through etsySettings.js,
-- which stringifies before it writes. A row that exists but holds NULL would
-- mean "connected, credential missing", which is a state nothing should be
-- able to express. Delete the row instead.
--
-- updated_at answers the only forensic question that ever matters here: when
-- did this token last rotate? If it is more than ninety days old the refresh
-- token has expired on Etsy's side and the reconnect is a human job.

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
