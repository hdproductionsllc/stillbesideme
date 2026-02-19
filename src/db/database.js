/**
 * Database — SQLite via sql.js (pure JS, no native compilation needed).
 * Provides a synchronous-feeling API with auto-save to disk.
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'store.db');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

let db = null;

/** Save the in-memory database to disk */
function save() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
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

module.exports = { init };
