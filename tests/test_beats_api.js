#!/usr/bin/env node
/**
 * tests/test_beats_api.js — beat desk routes against a temp DB, model stubbed offline.
 *
 * Covers: sync ingestion (idempotent), roster shape, memo merge on pushNotebook,
 * chat POST offline-degrade (unreachable model box -> honest canned reply, NOT 500),
 * message cursor pagination. Run: node tests/test_beats_api.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `bobs-apps-beats-${process.pid}.db`);
if (fs.existsSync(process.env.DB_PATH)) fs.rmSync(process.env.DB_PATH);
// Unreachable port: exercises the degrade path deterministically, offline.
process.env.BEAT_MODEL_URL = 'http://127.0.0.1:9/v1/chat/completions';

const express = require('express');
const { db, initDB } = require('../src/db.js');
const newsRoutes = require('../src/routes/news.js');

const PORT = 0; // ephemeral
let base;

const jget = async (p) => { const r = await fetch(base + p); return { code: r.status, body: await r.json() }; };
const jpost = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { code: r.status, body: await r.json() };
};

async function main() {
  await initDB();
  const app = express();
  app.use(express.json());
  app.use(newsRoutes({ db }));
  const server = await new Promise(res => {
    const s = app.listen(0, () => { res(s); });
  });
  base = `http://127.0.0.1:${server.address().port}`;

  // 1. sync ingests roster + run + leads + notebook.
  const sync = await jpost('/api/news/beats/sync', {
    desks: [{ beat: 'tech-industry', name: 'Sloane', card: 'chips and capex', persona: { name: 'Sloane', voice: 'dry' }, enabled: true }],
    runs: [{ beat: 'tech-industry', n_new: 40, n_leads: 2 }],
    leads: [{ beat: 'tech-industry', lead_date: '2026-10-22', title: 'TSMC deal', url: 'https://x/1', one_liner: 'who pays?', thread_id: 'tsmc-tpu', score: 5 }],
    notebooks: { 'tech-industry': { seen: {}, threads: [{ id: 'tsmc-tpu', title: 'TSMC deal', status: 'hot' }], leads: [], memories: [] } },
  });
  assert.strictEqual(sync.code, 200, `sync failed: ${JSON.stringify(sync.body)}`);
  assert.strictEqual(sync.body.leads_stored, 1);

  // 2. re-push same lead: idempotent (0 stored), roster survives.
  const sync2 = await jpost('/api/news/beats/sync', {
    leads: [{ beat: 'tech-industry', lead_date: '2026-10-22', title: 'TSMC deal', url: 'https://x/1', one_liner: 'who pays?', thread_id: 'tsmc-tpu', score: 5 }],
  });
  assert.strictEqual(sync2.body.leads_stored, 0, 'duplicate lead must not re-store');

  // 3. roster shape: persona parsed, last_run + leads attached.
  const roster = await jget('/api/news/beats?date=2026-10-22');
  assert.strictEqual(roster.body.beats.length, 1);
  const sloane = roster.body.beats[0];
  assert.strictEqual(sloane.name, 'Sloane');
  assert.strictEqual(sloane.persona.voice, 'dry');
  assert.strictEqual(sloane.leads.length, 1);
  assert.strictEqual(sloane.open_threads, 1);

  // 4. chat POST with unreachable model: 201, degrade text, editor msg stored.
  const chat = await jpost('/api/news/beats/tech-industry/messages', { text: 'what is your read on the TSMC deal?' });
  assert.strictEqual(chat.code, 201, `chat must degrade, not 500: ${JSON.stringify(chat.body)}`);
  assert.ok(/desk offline/.test(chat.body.beat.text), 'expected offline degrade text');

  // 5. messages readable; id cursor returns only newer (incl. same-ms siblings).
  const msgs = await jget('/api/news/beats/tech-industry/messages');
  assert.strictEqual(msgs.body.messages.length, 2);
  const after = msgs.body.messages[0].id;
  const newer = await jget(`/api/news/beats/tech-industry/messages?after=${encodeURIComponent(after)}`);
  assert.strictEqual(newer.body.messages.length, 1, 'id cursor must not leak siblings');

  // 6. memo merge: runner push must not clobber a chat memo.
  const beatdb = require('../src/beatdb');
  const nb = await beatdb.getNotebook(db, 'tech-industry');
  nb.memories = [{ text: 'from chat', added: beatdb.nowIso(), source: 'chat' }];
  await beatdb.pushNotebook(db, 'tech-industry', nb); // push our own memo back: union keeps 1
  const nb2 = await beatdb.getNotebook(db, 'tech-industry');
  assert.strictEqual(nb2.memories.length, 1, 'verbatim memo must not double');
  nb2.leads = [{ t: 'x' }]; // runner-side payload change
  nb2.memories = [];        // runner's local copy predates the chat memo
  await beatdb.pushNotebook(db, 'tech-industry', nb2);
  const nb3 = await beatdb.getNotebook(db, 'tech-industry');
  assert.strictEqual(nb3.memories.length, 1, 'runner push must preserve server memos');
  assert.strictEqual(nb3.leads.length, 1, 'runner payload still lands');

  // 7. unknown beat -> 404; empty text -> 400.
  const bad = await jpost('/api/news/beats/nonsense/messages', { text: 'hi' });
  assert.strictEqual(bad.code, 404);
  const empty = await jpost('/api/news/beats/tech-industry/messages', { text: '  ' });
  assert.strictEqual(empty.code, 400);

  server.close();
  fs.rmSync(process.env.DB_PATH, { force: true });
  console.log('test_beats_api: PASS (7 groups)');
}

main().catch(e => { console.error('FAIL', e.message); process.exit(1); });
