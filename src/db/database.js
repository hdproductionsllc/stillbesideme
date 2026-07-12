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
      await fs.promises.writeFile(DB_PATH, Buffer.from(data));
    } catch (err) {
      console.error('Database save error:', err);
    } finally {
      _saving = false;
    }
  }, 100);
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

module.exports = { init, backupNow, DB_PATH };
