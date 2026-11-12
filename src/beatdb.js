// src/beatdb.js — beat-desk storage: ALL beat SQL in one portable module.
//
// Why one module: the Postgres question is settled "rejected for now, revisit with
// facts" (docs/archive/postgres-migration-plan.md), and Dave's ruling (10/22) is
// that the schema stays portable so a later switch is a file rewrite, not a hunt.
// Portability rules enforced here (see plan 2026-10-22 §PORTABILITY):
//   * TEXT primary keys, UUIDs minted app-side (crypto.randomUUID)
//   * timestamps are app-written ISO-8601 UTC strings with ms (never CURRENT_TIMESTAMP)
//   * no INSERT OR REPLACE / GLOB / || concat / JSON1 — plain SELECT/INSERT/UPDATE
//     with ? placeholders only
//   * JSON payloads as TEXT; parsing lives in callers, not SQL
//   * message ordering: created_at TEXT + id tiebreak (no rowid reliance)
// Route code must call these functions, never hand-write beat SQL.

const crypto = require('crypto');

// App-written ISO-8601 UTC, forced strictly increasing within this process
// (snowflake-lite): two inserts in the same millisecond would otherwise order
// by random UUID and print the answer before the question. The container is the
// single writer, so a process-local guard is sufficient — and portable (no
// sequences, no dialect functions).
let _lastMs = 0;
const nowIso = () => {
  let t = Date.now();
  if (t <= _lastMs) t = _lastMs + 1;
  _lastMs = t;
  return new Date(t).toISOString();
};

// Statements run by initDB() on every boot. New tables + CREATE IF NOT EXISTS
// means old databases pick them up without ALTER ordering hazards.
const TABLES = [
  `CREATE TABLE IF NOT EXISTS beat_desks (
    beat TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    card TEXT NOT NULL DEFAULT '',
    persona_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS beat_runs (
    id TEXT PRIMARY KEY,
    beat TEXT NOT NULL,
    ran_at TEXT NOT NULL,
    n_new INTEGER NOT NULL DEFAULT 0,
    n_leads INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS beat_leads (
    id TEXT PRIMARY KEY,
    beat TEXT NOT NULL,
    lead_date TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    one_liner TEXT NOT NULL DEFAULT '',
    thread_id TEXT NOT NULL DEFAULT '',
    score INTEGER NOT NULL DEFAULT 0,
    filed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS beat_notebooks (
    beat TEXT PRIMARY KEY,
    json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS beat_messages (
    id TEXT PRIMARY KEY,
    beat TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_beat_runs_beat ON beat_runs(beat, ran_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_beat_leads_date ON beat_leads(lead_date DESC, beat)`,
  `CREATE INDEX IF NOT EXISTS idx_beat_messages_beat ON beat_messages(beat, created_at, id)`,
];

// sqlite3 callback API -> promises; every beat caller uses these four only.
const run = (db, sql, params = []) =>
  new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (db, sql, params = []) =>
  new Promise((res, rej) => db.all(sql, params, (e, r) => (e ? rej(e) : res(r))));
const get = (db, sql, params = []) =>
  new Promise((res, rej) => db.get(sql, params, (e, r) => (e ? rej(e) : res(r))));

// ── roster (beat_desks) ───────────────────────────────────────────────────────
// Config files live on the pipeline host; the runner syncs the roster so the
// container (which never sees those files) can answer chat and render the desk.

async function upsertDesk(db, { beat, name, card, persona, enabled }) {
  const ts = nowIso();
  const exists = await get(db, 'SELECT beat FROM beat_desks WHERE beat = ?', [beat]);
  if (exists) {
    await run(db,
      `UPDATE beat_desks SET name = ?, card = ?, persona_json = ?, enabled = ?, updated_at = ?
       WHERE beat = ?`,
      [name, card, JSON.stringify(persona || {}), enabled === false ? 0 : 1, ts, beat]);
  } else {
    await run(db,
      `INSERT INTO beat_desks (beat, name, card, persona_json, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [beat, name, card, JSON.stringify(persona || {}), enabled === false ? 0 : 1, ts]);
  }
}

async function listDesks(db) {
  const rows = await all(db, 'SELECT * FROM beat_desks ORDER BY beat');
  return rows.map(r => ({ ...r, persona: safeParse(r.persona_json, {}) }));
}

// ── runs ──────────────────────────────────────────────────────────────────────

async function insertRun(db, { beat, n_new, n_leads, note }) {
  await run(db,
    `INSERT INTO beat_runs (id, beat, ran_at, n_new, n_leads, note) VALUES (?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), beat, nowIso(), n_new | 0, n_leads | 0, note || '']);
}

// ── leads ─────────────────────────────────────────────────────────────────────

async function insertLead(db, l) {
  await run(db,
    `INSERT INTO beat_leads (id, beat, lead_date, title, url, one_liner, thread_id, score, filed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), l.beat, l.lead_date, l.title, l.url || '', l.one_liner || '',
      l.thread_id || '', l.score | 0, nowIso()]);
}

async function listLeads(db, { beat, date, limit = 20 } = {}) {
  let sql = 'SELECT * FROM beat_leads WHERE 1=1';
  const params = [];
  if (beat) { sql += ' AND beat = ?'; params.push(beat); }
  if (date) { sql += ' AND lead_date = ?'; params.push(date); }
  sql += ' ORDER BY filed_at DESC, id LIMIT ?';
  params.push(limit | 0);
  return all(db, sql, params);
}

// ── notebooks ─────────────────────────────────────────────────────────────────
// The pipeline host owns seen/threads/leads; the server keeps a mirror for chat
// grounding, and MEMOS are the shared-mutable field: chat appends, the runner
// must not clobber them. pushNotebook() therefore merges memos (union by text,
// server order preserved) instead of overwriting.

async function getNotebook(db, beat) {
  const row = await get(db, 'SELECT json FROM beat_notebooks WHERE beat = ?', [beat]);
  return row ? safeParse(row.json, emptyNb()) : emptyNb();
}

async function pushNotebook(db, beat, nb) {
  const server = await getNotebook(db, beat);
  const incoming = Array.isArray(nb.memories) ? nb.memories : [];
  const seenTexts = new Set(server.memories.map(m => m.text));
  const merged = server.memories.concat(incoming.filter(m => m.text && !seenTexts.has(m.text)));
  const cap = merged.slice(-10); // memo cap mirrors beat_store.MEMO_CAP (keep in sync)
  const payload = { ...nb, memories: cap };
  const ts = nowIso();
  const exists = await get(db, 'SELECT beat FROM beat_notebooks WHERE beat = ?', [beat]);
  if (exists) {
    await run(db, 'UPDATE beat_notebooks SET json = ?, updated_at = ? WHERE beat = ?',
      [JSON.stringify(payload), ts, beat]);
  } else {
    await run(db, 'INSERT INTO beat_notebooks (beat, json, updated_at) VALUES (?, ?, ?)',
      [beat, JSON.stringify(payload), ts]);
  }
  return payload;
}

// ── chat ──────────────────────────────────────────────────────────────────────

async function insertMessage(db, { beat, role, text }) {
  const msg = { id: crypto.randomUUID(), beat, role, text, created_at: nowIso() };
  await run(db,
    `INSERT INTO beat_messages (id, beat, role, text, created_at) VALUES (?, ?, ?, ?, ?)`,
    [msg.id, beat, role, text, msg.created_at]);
  return msg;
}

// Cursor = the ID of the last seen message. Resolving its created_at server-side
// and comparing (created_at, id) pairs keeps same-millisecond messages strict —
// passing the raw timestamp made "newer" leak siblings (caught by test 10/22).
async function listMessages(db, beat, { after = '', limit = 50 } = {}) {
  if (!after) {
    return all(db,
      `SELECT * FROM beat_messages WHERE beat = ? ORDER BY created_at, id LIMIT ?`,
      [beat, limit | 0]);
  }
  const cur = await get(db,
    `SELECT created_at FROM beat_messages WHERE beat = ? AND id = ?`, [beat, after]);
  if (!cur) {
    return all(db,
      `SELECT * FROM beat_messages WHERE beat = ? ORDER BY created_at, id LIMIT ?`,
      [beat, limit | 0]);
  }
  return all(db,
    `SELECT * FROM beat_messages WHERE beat = ?
     AND (created_at > ? OR (created_at = ? AND id > ?))
     ORDER BY created_at, id LIMIT ?`,
    [beat, cur.created_at, cur.created_at, after, limit | 0]);
}

// lastMessageCursor: id of the newest message (poll cursor for the UI).
async function lastCursor(db, beat) {
  const row = await get(db,
    `SELECT id FROM beat_messages WHERE beat = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [beat]);
  return row ? row.id : '';
}

// ── helpers ───────────────────────────────────────────────────────────────────

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
function emptyNb() { return { seen: {}, threads: [], leads: [], memories: [] }; }

module.exports = {
  TABLES, nowIso, run, all, get,
  upsertDesk, listDesks,
  insertRun, insertLead, listLeads,
  getNotebook, pushNotebook,
  insertMessage, listMessages, lastCursor,
};
