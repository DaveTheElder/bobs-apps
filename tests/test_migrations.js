#!/usr/bin/env node
/**
 * Upgrade-path test: initDB() must boot cleanly on a v1 schema DB (messages table
 * WITHOUT session_id — exactly what's in the wild from the first history ship).
 * The v1→v2 ordering bug (index over session_id before its ALTER) took the server
 * down at startup; fresh-DB tests can't catch that, so this file exists.
 *
 * Runs against a throwaway file under os.tmpdir() — never touches the real DB_PATH.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function v1SchemaDbPath() {
  const p = path.join(os.tmpdir(), `bobs-apps-v1-${process.pid}.db`);
  if (fs.existsSync(p)) fs.rmSync(p);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(p);
  // Verbatim v1 rag_messages: no session_id column, index absent.
  db.exec(`CREATE TABLE rag_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    model TEXT,
    llm_offline INTEGER DEFAULT 0,
    sources_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.exec(`INSERT INTO rag_messages (role, content) VALUES
    ('user', 'old question'), ('assistant', 'old answer')`);
  db.close();
  return p;
}

// src/db.js exports a sqlite3 (callback-API) Database — wrap the reads in promises.
const all = (db, sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => e ? rej(e) : res(r)));

async function main() {
  const v1 = v1SchemaDbPath();
  process.env.DB_PATH = v1; // src/db.js reads DB_PATH at require time
  const { db, initDB } = require('../src/db.js');
  await initDB(); // pre-fix: rejects with 'no such column: session_id'

  // Legacy rows must be visible as one backfilled thread, not orphaned.
  const legacy = await all(db,
    `SELECT s.id, count(m.id) n FROM rag_sessions s LEFT JOIN rag_messages m ON m.session_id = s.id GROUP BY s.id HAVING n > 0`);
  assert.strictEqual(legacy.length, 1, 'expected exactly one session with messages');
  assert.strictEqual(legacy[0].id, 'legacy', `messages should sit in the legacy thread, got '${legacy[0].id}'`);
  assert.strictEqual(Number(legacy[0].n), 2, `both legacy rows should survive backfill, got ${legacy[0].n}`);

  // The index must exist post-migration (it was relocated after the ALTER).
  const idx = await all(db, `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_rag_messages_session'`);
  assert.strictEqual(idx.length, 1, 'session_id index missing after migration');

  // Idempotency: running init again on the migrated DB must be a no-op, not an error.
  await initDB();
  const rows = await all(db, `SELECT count(*) c FROM rag_messages WHERE session_id='legacy'`);
  assert.strictEqual(Number(rows[0].c), 2, 're-running initDB must not duplicate backfill');

  fs.rmSync(v1, { force: true }); // throwaway under tmpdir only — never the real DB_PATH file
  console.log('migrations (v1 upgrade): all tests passed');
}

main().catch(e => { console.error('migration test FAILED:', e.message); process.exit(1); });
