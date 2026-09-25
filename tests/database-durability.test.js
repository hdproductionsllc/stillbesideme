/**
 * Every change must reach the file on the volume, and an older copy must
 * never replace a newer one.
 *
 * The database lives in memory (sql.js) and is copied to disk by a debounced
 * writer. Two races used to lose writes, and both were silent:
 *
 *   1. A change landing while a save was already running was skipped ("a save
 *      is in progress") and only reached disk if some LATER change happened to
 *      come along. The last write before a quiet spell, or a redeploy, was gone.
 *   2. flushSync(), the urgent path used for payments, the rotated Etsy token
 *      and shutdown, could run while a slower debounced save was in flight.
 *      That save then finished last and put its OLDER copy on top.
 *
 * Disk writes are slowed on purpose here so each race happens every time.
 * The file is read back with a fresh sql.js to check what a restart would see.
 *
 *   node tests/database-durability.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'db-durability-test-'));
process.env.DATA_DIR = TMP;

const initSqlJs = require('sql.js');
const database = require('../src/db/database');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Every async disk write (the debounced writer's path) takes 300ms to begin.
// Both entry points are slowed so the test means the same thing against any
// version of the writer.
const realOpen = fs.promises.open;
const realWriteFile = fs.promises.writeFile;
fs.promises.open = async (...args) => { await sleep(300); return realOpen(...args); };
fs.promises.writeFile = async (...args) => { await sleep(300); return realWriteFile(...args); };

let SQL;
function onDisk() {
  const disk = new SQL.Database(fs.readFileSync(database.DB_PATH));
  const rows = disk.exec('SELECT v FROM notes ORDER BY v');
  disk.close();
  return rows.length ? rows[0].values.map(r => r[0]) : [];
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

(async () => {
  SQL = await initSqlJs();
  const db = await database.init();
  db.run('CREATE TABLE notes (v TEXT)');
  database.flushSync();

  console.log('\nDatabase durability\n');

  await check('a change made while a save is running still reaches disk', async () => {
    db.run(`INSERT INTO notes VALUES ('a1')`);
    await sleep(150);            // debounce fired; the slow save of a1 is in flight
    db.run(`INSERT INTO notes VALUES ('a2')`);
    await sleep(1200);           // no further writes: nothing else will rescue a2
    assert.deepStrictEqual(onDisk(), ['a1', 'a2']);
  });

  await check('a slow save finishing after flushSync does not put older data back', async () => {
    db.run(`INSERT INTO notes VALUES ('b1')`);
    await sleep(150);            // slow save of (…, b1) is in flight
    db.run(`INSERT INTO notes VALUES ('b2')`);
    database.flushSync();        // urgent path: b2 is on disk now
    assert.ok(onDisk().includes('b2'), 'flushSync wrote b2');
    await sleep(1200);           // the in-flight save finishes, holding only b1
    assert.deepStrictEqual(onDisk(), ['a1', 'a2', 'b1', 'b2']);
  });

  await check('a burst of writes all land', async () => {
    for (let i = 0; i < 20; i++) {
      db.run(`INSERT INTO notes VALUES (?)`, [`c${String(i).padStart(2, '0')}`]);
      await sleep(i % 5 === 0 ? 120 : 5);
    }
    await sleep(2500);
    const got = onDisk().filter(v => v.startsWith('c'));
    assert.strictEqual(got.length, 20, `only ${got.length} of 20 on disk`);
  });

  await check('no temp files are left behind', async () => {
    const leftovers = fs.readdirSync(TMP).filter(f => f.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, []);
  });

  await check('a backup snapshot is a whole, readable database', async () => {
    const dest = database.backupNow('2026-09-25T00-00-00');
    const snap = new SQL.Database(fs.readFileSync(dest));
    assert.strictEqual(snap.exec('SELECT COUNT(*) FROM notes')[0].values[0][0], 24);
    snap.close();
    assert.ok(!fs.existsSync(`${dest}.tmp`));
  });

  fs.promises.open = realOpen;
  fs.promises.writeFile = realWriteFile;
  database.flushSync();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n');
  process.exitCode = failures ? 1 : 0;
})().catch(err => {
  console.error(err);
  process.exit(1);
});
