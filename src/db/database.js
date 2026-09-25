/**
 * Database – SQLite via sql.js (pure JS, no native compilation needed).
 * Provides a synchronous-feeling API with auto-save to disk.
 *
 * sql.js holds the whole database in memory; the file on the volume is a copy
 * we keep writing out. Three rules keep that copy trustworthy:
 *
 *   1. It is never written in place. Each save goes to a temp file, is forced
 *      to disk, and is then renamed over store.db. A rename is atomic, so a
 *      crash or a redeploy mid-save leaves the previous good file, never half
 *      of a new one.
 *   2. Every change reaches disk. A change that lands while a save is already
 *      running is picked up by another pass of the same writer, not dropped
 *      because "a save is in progress".
 *   3. An older copy never replaces a newer one. Each write carries the
 *      version of the data it exported, and only a newer version is renamed
 *      into place. That matters when flushSync() (the urgent path) runs while
 *      a slower debounced save is still in flight: the late finisher holds
 *      older data and must throw its temp file away, not land on top.
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'store.db');
// The debounced writer and flushSync() each have their own temp file, so the
// urgent path never writes into a file the background path is halfway through.
const SAVE_TMP_PATH = path.join(DATA_DIR, 'store.db.tmp');
const FLUSH_TMP_PATH = path.join(DATA_DIR, 'store.db.flush.tmp');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let db = null;

// Versions: _memVersion counts changes made in memory, _diskVersion is the
// newest of those known to be on disk. The file is current when they match.
let _memVersion = 0;
let _diskVersion = 0;
let _saveTimer = null;
let _writerRunning = false;

/** Write bytes to a temp file and force them to disk before returning. */
async function writeDurable(file, bytes) {
  const handle = await fs.promises.open(file, 'w');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function writeDurableSync(file, bytes) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The one background writer. Loops until the file is current, so changes
 * made during a pass are written by the next pass. The slow part (writing and
 * syncing the temp file) is async; the version check and the rename are
 * synchronous together, so nothing can run between "is mine still the newest?"
 * and "put it in place".
 */
async function runWriter() {
  if (_writerRunning) return; // the running pass will see the new version
  _writerRunning = true;
  try {
    while (db && _diskVersion < _memVersion) {
      const version = _memVersion;
      const bytes = Buffer.from(db.export());
      await writeDurable(SAVE_TMP_PATH, bytes);
      if (version > _diskVersion) {
        fs.renameSync(SAVE_TMP_PATH, DB_PATH);
        _diskVersion = version;
      } else {
        // flushSync() put newer data on disk while this pass was writing.
        fs.rmSync(SAVE_TMP_PATH, { force: true });
      }
    }
  } catch (err) {
    // The file still holds the last good copy. The unsaved changes stay
    // counted, so the next write (or shutdown's flushSync) retries them.
    console.error('Database save error:', err);
  } finally {
    _writerRunning = false;
  }
}

/** Note a change and save it soon (debounced: a burst costs one write). */
function save() {
  if (!db) return;
  _memVersion++;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    runWriter();
  }, 100);
}

/**
 * Write the database to disk right now, synchronously.
 *
 * The debounce above is the right trade for ordinary writes: a burst of order
 * updates costs one disk write instead of twenty. But a debounce always leaves
 * a window where a fact exists only in memory, and a redeploy lands squarely
 * in it. Railway sends SIGTERM and the process exits within 100ms of the last
 * write, so the payment a webhook just recorded, or the approval a customer
 * just gave, can be the write that never reaches the volume. Some facts cannot
 * be asked for twice: Stripe considers a 200'd event delivered, and Etsy
 * retires a refresh token the moment we spend it, so a lost write there locks
 * the shop out until a human reconnects by hand.
 *
 * So shutdown calls this before exiting, and anything that records such a
 * fact calls it too instead of trusting the debounce. Safe to call at any
 * time, including while a debounced save is in flight (see rule 3 above).
 */
function flushSync() {
  if (!db) return;
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  if (_diskVersion === _memVersion) return;
  try {
    const version = _memVersion;
    writeDurableSync(FLUSH_TMP_PATH, Buffer.from(db.export()));
    fs.renameSync(FLUSH_TMP_PATH, DB_PATH);
    _diskVersion = version;
  } catch (err) {
    console.error('Database flush error:', err);
  }
}

/** Thin wrapper that provides a clean API and auto-saves on writes */
class Database {
  constructor(sqlDb) {
    this._db = sqlDb;
  }

  /** Run a statement that modifies data (INSERT, UPDATE, DELETE, CREATE) */
  run(sql, params = []) {
    this._db.run(sql, params);
    save();
    return this;
  }

  /** Execute raw SQL (for multi-statement migrations) */
  exec(sql) {
    this._db.exec(sql);
    save();
    return this;
  }

  /** Get a single row */
  get(sql, params = []) {
    const stmt = this._db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return undefined;
  }

  /** Get all rows */
  all(sql, params = []) {
    const stmt = this._db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }
}

/** Run file-based migrations */
function migrate(wrapper) {
  wrapper.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    wrapper.all('SELECT name FROM _migrations').map(r => r.name)
  );

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    wrapper.exec(sql);
    wrapper.run('INSERT INTO _migrations (name) VALUES (?)', [file]);
    console.log(`  Migration applied: ${file}`);
  }
}

/** Initialize and return the database singleton */
async function init() {
  if (db) return new Database(db);

  const SQL = await initSqlJs();

  // Load existing database file or create new
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Enable WAL-like performance (not available in sql.js, but we set pragma for compatibility)
  try { db.run('PRAGMA foreign_keys = ON'); } catch (e) { /* ok */ }

  const wrapper = new Database(db);
  migrate(wrapper);
  return wrapper;
}

/**
 * Write a timestamped snapshot of the live database into DATA_DIR/backups and
 * prune to the most recent `keep`. Returns the snapshot path. This protects
 * against app-level corruption and gives an off-site pull point (paired with
 * the gated download endpoint). `stamp` is passed in (callers have a clock;
 * this module must not call Date() so it stays deterministic in tests).
 * Written through a temp file like the live copy, so a snapshot that exists
 * is a whole one.
 */
function backupNow(stamp, keep = 14) {
  if (!db) throw new Error('Database not initialized');
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `store-${stamp}.db`);
  const tmp = `${dest}.tmp`;
  writeDurableSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, dest);

  // Prune oldest, keep the newest `keep`.
  const snaps = fs.readdirSync(dir)
    .filter(f => f.startsWith('store-') && f.endsWith('.db'))
    .sort(); // ISO-ish stamps sort lexically = chronologically
  for (const old of snaps.slice(0, Math.max(0, snaps.length - keep))) {
    try { fs.unlinkSync(path.join(dir, old)); } catch (e) { /* best effort */ }
  }
  return dest;
}

// The brands grew different names for the same call (SBM `flush`, KT
// `flushSync`). Both are exported so code ported in either direction works.
module.exports = { init, backupNow, flushSync, flush: flushSync, DB_PATH };
