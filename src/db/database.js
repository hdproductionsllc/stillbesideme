/**
 * Database – SQLite via sql.js (pure JS, no native compilation needed).
 * Provides a synchronous-feeling API with auto-save to disk.
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'store.db');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let db = null;

/** Save the in-memory database to disk (debounced, async) */
let _saveTimer = null;
let _saving = false;

// Every persist is stamped with a monotonic generation so a slower write can
// never land on top of a newer one. The export is synchronous, so the stamp
// taken right after it orders snapshots by age; a snapshot whose generation is
// already behind what is on disk is thrown away instead of renamed into place.
// This is what keeps the final synchronous flush at shutdown from being undone
// by an async save that was still mid-write when the signal arrived.
let _writeSeq = 0;
let _persistedSeq = 0;

/**
 * sql.js hands us the whole database as one buffer, so persisting means
 * replacing the file wholesale — and a process that dies partway through that
 * write leaves a truncated store.db, i.e. every order gone. So we never write
 * over the live file: the snapshot goes to a temp file in the SAME directory
 * (rename is only atomic within a filesystem) and is then renamed over the
 * target, which either happens completely or not at all.
 */
function tempPath(seq) {
  return `${DB_PATH}.tmp-${process.pid}-${seq}`;
}

async function persist(data, seq) {
  const tmp = tempPath(seq);
  await fs.promises.writeFile(tmp, Buffer.from(data));
  if (seq < _persistedSeq) {
    // A newer snapshot (e.g. the shutdown flush) already landed — discard ours.
    await fs.promises.unlink(tmp).catch(() => {});
    return;
  }
  await fs.promises.rename(tmp, DB_PATH);
  _persistedSeq = seq;
}

function save() {
  if (!db) return;

  // Debounce: coalesce rapid writes into a single disk flush
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    if (_saving || !db) return;
    _saving = true;
    try {
      const data = db.export();
      await persist(data, ++_writeSeq);
    } catch (err) {
      console.error('Database save error:', err);
    } finally {
      _saving = false;
    }
  }, 100);
}

/**
 * Persist immediately, synchronously, and return whether it happened.
 *
 * The 100ms debounce above means the last write of a request may exist only in
 * memory. Railway sends SIGTERM and then replaces the container, so without a
 * flush on that path anything written in the final tenth of a second of a
 * deploy — a paid order, a proof approval — is simply lost. Signal handlers
 * have no time to await, hence the synchronous twin of persist().
 */
function flushSync() {
  if (!db) return false;
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  try {
    const data = db.export();
    const seq = ++_writeSeq;
    const tmp = tempPath(seq);
    fs.writeFileSync(tmp, Buffer.from(data));
    fs.renameSync(tmp, DB_PATH);
    _persistedSeq = seq;
    return true;
  } catch (err) {
    console.error('Database flush error:', err);
    return false;
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
 */
function backupNow(stamp, keep = 14) {
  if (!db) throw new Error('Database not initialized');
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `store-${stamp}.db`);
  fs.writeFileSync(dest, Buffer.from(db.export()));

  // Prune oldest, keep the newest `keep`.
  const snaps = fs.readdirSync(dir)
    .filter(f => f.startsWith('store-') && f.endsWith('.db'))
    .sort(); // ISO-ish stamps sort lexically = chronologically
  for (const old of snaps.slice(0, Math.max(0, snaps.length - keep))) {
    try { fs.unlinkSync(path.join(dir, old)); } catch (e) { /* best effort */ }
  }
  return dest;
}

module.exports = { init, backupNow, flushSync, DB_PATH };
