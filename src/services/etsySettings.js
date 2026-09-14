/**
 * The one place the app writes its own credentials down.
 *
 * Every other integration in this system is configured from the outside and
 * stays that way. Etsy cannot. Its refresh grant is single use: the moment we
 * spend a refresh token for a new hour of access, Etsy retires that token and
 * hands back a different one. If the replacement is not persisted before the
 * process ends, the shop is disconnected and somebody has to reauthorize by
 * hand. So the credential lives in the database (app_settings, migration 016),
 * on the same volume as the orders, and this module is the only door to it.
 *
 * It is deliberately dull. No caching, no validation, no knowledge of what a
 * refresh token is. The rule it does enforce is that a write is ONE statement:
 * there is no transaction wrapper anywhere in this codebase, so a delete
 * followed by an insert has a window in which the credential does not exist,
 * and a process that dies inside that window locks the shop out. INSERT with
 * ON CONFLICT DO UPDATE has no such window. Either the old value is there or
 * the new one is.
 *
 * getJson never throws. A settings row that will not parse is a row we cannot
 * use, and the callers all treat "no value" as "not connected", which is the
 * honest reading of a corrupted credential and the one that leads a human to
 * the reconnect button instead of to a stack trace.
 *
 * Canonical keys, so they stay in one list rather than scattered as literals:
 *   'etsy.oauth' = { refreshToken, rotatedAt, tokenUserId }
 *   'etsy.shop'  = { shopId, shopName, connectedAt }
 *   'etsy.meta'  = { lastPullAt, lastReceiptSample }
 *
 * Nothing here may ever be logged. The value under 'etsy.oauth' is the shop.
 */

/** Read one setting. Returns null when the key has never been written. */
function get(db, key) {
  const row = db.get('SELECT value FROM app_settings WHERE key = ?', [key]);
  return row && row.value != null ? String(row.value) : null;
}

/**
 * Write one setting, as a single statement so there is no empty moment.
 *
 * Then flush to disk immediately rather than letting the 100ms debounce carry
 * it. Everything stored here is single-use or hard to recover: Etsy retires a
 * refresh token the instant we spend it, so a redeploy landing inside the
 * debounce window would leave the volume holding a credential Etsy will never
 * accept again. Settings are written a handful of times a day, so the extra
 * disk write costs nothing worth counting.
 */
function set(db, key, value) {
  db.run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, String(value)]
  );
  try {
    require('../db/database').flush();
  } catch (err) {
    console.error(`[etsySettings] could not flush ${key} to disk: ${err.message}`);
  }
}

/** Read a JSON setting. null when absent, and null when it will not parse. */
function getJson(db, key) {
  const raw = get(db, key);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    console.warn(`[etsySettings] setting ${key} is not valid JSON, treating it as unset`);
    return null;
  }
}

/** Write a JSON setting. */
function setJson(db, key, obj) {
  set(db, key, JSON.stringify(obj));
}

/** Forget a setting entirely. Disconnecting means the row is gone, not empty. */
function remove(db, key) {
  db.run('DELETE FROM app_settings WHERE key = ?', [key]);
}

module.exports = { get, set, getJson, setJson, remove };
