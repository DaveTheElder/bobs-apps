// tests/test_api.js — boots server.js against a TEMP db, hits every docs/RAG route.
// Run: node tests/test_api.js   (uses PORT 8091 by default)
process.env.PORT = process.env.TEST_PORT || '8091';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Isolate state BEFORE requiring the server (db.js reads env at load time).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobs-test-'));
fs.mkdirSync(path.join(tmpDir, 'documents'), { recursive: true });
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DOCS_DIR = path.join(tmpDir, 'documents');

const base = `http://127.0.0.1:${process.env.PORT}`;
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

(async () => {
  const child = require('child_process').spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: process.env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', d => serverLog += d);
  child.stderr.on('data', d => serverLog += d);

  // wait for health
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { const r = await fetch(base + '/health'); up = r.ok; } catch {}
  }
  if (!up) { console.error('server did not start:\n' + serverLog); process.exit(1); }

  // ---- documents: register with a REAL file on disk -------------------------
  const samplePdf = path.join(ROOT, 'documents', 'test-report.pdf');
  fs.copyFileSync(samplePdf, path.join(tmpDir, 'documents', 'sample.pdf'));

  await check('GET /api/docs starts empty', async () => {
    const r = await fetch(base + '/api/docs');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (d.docs.length !== 0) throw new Error('expected 0 docs');
  });

  let createdId;
  await check('POST /api/docs registers existing file', async () => {
    const r = await fetch(base + '/api/docs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Sample PDF', filename: 'sample.pdf', file_type: 'pdf', category: 'test' })
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    createdId = d.id;
    if (d.file_size <= 0) throw new Error('file_size should be computed server-side');
  });

  await check('POST /api/docs rejects missing file', async () => {
    const r = await fetch(base + '/api/docs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Ghost', filename: 'ghost.pdf', file_type: 'pdf' })
    });
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
  });

  await check('GET /api/docs/:id/preview returns structured blocks', async () => {
    const r = await fetch(`${base}/api/docs/${createdId}/preview`);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const d = await r.json();
    if (d.format !== 'structured' || !Array.isArray(d.blocks)) throw new Error('missing structured blocks');
    if (!/test/i.test(d.text)) throw new Error('expected "test" in extracted text');
  });

  await check('GET /docs/:filename serves the file', async () => {
    const r = await fetch(base + '/docs/sample.pdf');
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    if (!/application\/(pdf|octet-stream)/.test(r.headers.get('content-type') || '')) throw new Error('wrong content type: ' + r.headers.get('content-type'));
  });

  // ---- RAG status (fresh db) --------------------------------------------------
  await check('GET /api/rag/status responds', async () => {
    const r = await fetch(base + '/api/rag/status');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (typeof d.total_docs !== 'number') throw new Error('missing total_docs');
  });

  await check('POST /api/rag/query validates input', async () => {
    const r = await fetch(base + '/api/rag/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
  });

  // ---- RAG chat sessions ------------------------------------------------------
  // Seeded straight into the temp DB: /query needs LM Studio alive and tests must pass
  // with it down. These pin session CRUD + the lazy-title write path contract.
  let createdSessionId = null;
  await check('GET /api/rag/sessions starts empty', async () => {
    const r = await fetch(base + '/api/rag/sessions');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (!Array.isArray(d.sessions) || d.sessions.length !== 0) throw new Error('expected empty sessions array');
  });

  await check('POST /api/rag/sessions creates a session', async () => {
    const r = await fetch(base + '/api/rag/sessions', { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (!d.id || d.id.length < 10) throw new Error('no session id returned');
    createdSessionId = d.id;
    // Empty sessions stay hidden from the list until they have messages.
    const l = await (await fetch(base + '/api/rag/sessions')).json();
    if (l.sessions.some(s => s.id === d.id)) throw new Error('empty session should not be listed');
  });

  await check('GET /sessions/:id/messages seeds, parses sources, orders by id', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(process.env.DB_PATH);
    raw.exec(`INSERT INTO rag_messages (session_id, role, content, model, llm_offline, sources_json) VALUES
      ('${createdSessionId}', 'user', 'Q1: what is RAG?', NULL, 0, '[]'),
      ('${createdSessionId}', 'assistant', 'A1: retrieval-augmented generation.', 'test-model', 0, '[{"title":"Doc X","chunk_index":2,"total_chunks":5}]')`);
    raw.close();
    const r = await fetch(base + `/api/rag/sessions/${createdSessionId}/messages`);
    const d = await r.json();
    if (d.messages.length !== 2) throw new Error(`expected 2 messages, got ${d.messages.length}`);
    const [q, a] = d.messages;
    if (q.role !== 'user' || a.role !== 'assistant') throw new Error('role order wrong');
    if (!q.content.includes('Q1')) throw new Error('user content lost');
    if (a.model !== 'test-model') throw new Error('model not surfaced');
    if (!Array.isArray(a.sources) || a.sources[0].title !== 'Doc X' || typeof a.sources[0].chunk_index !== 'number') {
      throw new Error('sources_json not parsed back into objects');
    }
    if (!(q.id < a.id)) throw new Error(`assistant id ${a.id} should sort after user id ${q.id}`);
  });

  await check('listed session shows title + message count', async () => {
    const d = await (await fetch(base + '/api/rag/sessions')).json();
    const s = d.sessions.find(x => x.id === createdSessionId);
    if (!s) throw new Error('session with messages should be listed');
    if (s.messages !== 2) throw new Error(`expected count 2, got ${s.messages}`);
  });

  await check('rag_messages rejects bogus role (CHECK constraint)', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(process.env.DB_PATH);
    let threw = false;
    try { raw.exec(`INSERT INTO rag_messages (session_id, role, content) VALUES ('x', 'bot', 'nope')`); } catch { threw = true; }
    raw.close();
    if (!threw) throw new Error('CHECK(role) did not reject bogus role');
  });

  await check('DELETE /api/rag/sessions/:id removes thread + its messages', async () => {
    const r = await fetch(base + `/api/rag/sessions/${createdSessionId}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await (await fetch(base + `/api/rag/sessions/${createdSessionId}/messages`)).json();
    if (d.messages.length !== 0) throw new Error('messages survived session delete');
  });

  // Models picker proxies LM Studio. LM Studio may be down in CI — both outcomes
  // are acceptable; a hang or a malformed body is not.
  await check('GET /api/rag/models responds with list or clean 502', async () => {
    const r = await fetch(base + '/api/rag/models');
    if (r.status === 200) {
      const d = await r.json();
      if (!Array.isArray(d.models)) throw new Error('models is not an array');
      if (d.models.some(m => /embed/i.test(m.id))) throw new Error('embedding model leaked into picker');
      if (d.models.length && typeof d.models[0] !== 'object') throw new Error('model entries must be {{id, state}}');
    } else if (r.status !== 502) {
      throw new Error(`expected 200 or 502, got ${r.status}`);
    }
  });

  await check('POST /api/rag/models/warm validates and never hangs', async () => {
    const bad = await fetch(base + '/api/rag/models/warm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    if (bad.status !== 400) throw new Error(`missing model should be 400, got ${bad.status}`);
    // Bogus id: cannot load anything real; route must answer fast (ok:false or pending), never 5xx-hang.
    const r = await fetch(base + '/api/rag/models/warm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'zz-no-such-model' }) });
    if (!r.ok) throw new Error(`warm bogus expected 200, got ${r.status}`);
    const d = await r.json();
    if (typeof d.ok !== 'boolean') throw new Error('warm response missing ok boolean');
  });

  // ---- upload (raw-bytes endpoint) ---------------------------------------------
  let uploadedId;
  await check('POST /api/docs/upload rejects missing title', async () => {
    const r = await fetch(base + '/api/docs/upload', { method: 'POST', body: new Blob(['x']) });
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
  });
  await check('POST /api/docs/upload rejects unsupported type', async () => {
    const r = await fetch(`${base}/api/docs/upload?title=Nope`, { method: 'POST', body: new Blob(['x']) });
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
  });
  await check('POST /api/docs/upload stores file + row server-side-named', async () => {
    const bytes = fs.readFileSync(samplePdf);
    const r = await fetch(`${base}/api/docs/upload?title=Uploaded%20PDF&category=test`, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: bytes
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    uploadedId = d.id;
    if (d.file_type !== 'pdf') throw new Error('wrong file_type');
    if (d.file_size !== bytes.length) throw new Error(`size mismatch: ${d.file_size} vs ${bytes.length}`);
    if (!/^[0-9a-f-]{36}\.pdf$/.test(d.filename)) throw new Error(`unexpected filename ${d.filename}`);
    const onDisk = path.join(tmpDir, 'documents', d.filename);
    if (!fs.existsSync(onDisk) || fs.statSync(onDisk).size !== bytes.length) throw new Error('file not written correctly');
  });

  // ---- delete ------------------------------------------------------------------
  await check('DELETE /api/docs/:id removes row + file', async () => {
    const r = await fetch(`${base}/api/docs/${createdId}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (fs.existsSync(path.join(tmpDir, 'documents', 'sample.pdf'))) throw new Error('file still on disk');
  });

  // ---- astro --------------------------------------------------------------------
  await check('GET /api/astro/chart returns valid chart', async () => {
    const r = await fetch(base + '/api/astro/chart?date=1990-05-15&time=14:30&lat=52.52&lon=13.40');
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    if (!d.planets || !Array.isArray(d.aspects)) throw new Error('bad chart shape');
  });

  await check('GET /api/astro/geocode rejects missing q', async () => {
    const r = await fetch(base + '/api/astro/geocode');
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
    const d = await r.json();
    if (!d.error) throw new Error('error body missing');
  });

  // Live Nominatim round-trip — skipped offline so the suite stays LM-studio/network-down safe.
  let upstreamUp = true;
  try { const probe = await fetch(base + '/api/astro/geocode?q=Denver'); upstreamUp = probe.status !== 502; } catch { upstreamUp = false; }
  await check('GET /api/astro/geocode resolves city + ZIP (live, skipped offline)', async () => {
    if (!upstreamUp) { console.log('     (skipped: geocoding upstream unreachable)'); return; }
    const city = await (await fetch(base + '/api/astro/geocode?q=Denver')).json();
    const denver = city.results[0];
    if (!denver || Math.abs(denver.lat - 39.74) > 0.5 || Math.abs(denver.lon + 104.99) > 0.5) {
      throw new Error(`Denver lookup wrong: ${JSON.stringify(denver).slice(0, 200)}`);
    }
    if (denver.timezone !== 'America/Denver') throw new Error(`Denver missing IANA timezone: ${denver.timezone}`);
    const zip = await (await fetch(base + '/api/astro/geocode?q=90210')).json();
    const beverly = zip.results[0];
    if (!beverly || Math.abs(beverly.lat - 34.09) > 0.5 || Math.abs(beverly.lon + 118.41) > 0.5) {
      throw new Error(`ZIP 90210 lookup wrong: ${JSON.stringify(beverly).slice(0, 200)}`);
    }
    if (!beverly.postcode && !/United States/.test(beverly.displayName)) throw new Error('ZIP result missing US context');
  });

  // ---- astro timezone handling --------------------------------------------------
  await check('tz= converts local wall-clock to the same chart as manual UTC', async () => {
    // 7:30pm Denver May 15 1990 (MDT, -6) == 01:30 UTC May 16. Both spellings
    // must produce identical planet longitudes — that's the whole feature.
    const local = await (await fetch(base + '/api/astro/chart?date=1990-05-15&time=19:30&lat=39.74&lon=-104.99&tz=' + encodeURIComponent('America/Denver'))).json();
    const utc = await (await fetch(base + '/api/astro/chart?date=1990-05-16&time=01:30&lat=39.74&lon=-104.99')).json();
    if (!local.planets || !utc.planets) throw new Error('chart shape broken: ' + JSON.stringify(local).slice(0, 120));
    for (const k of Object.keys(utc.planets)) {
      const a = local.planets[k].longitude, b = utc.planets[k].longitude;
      if (Math.abs(a - b) > 1e-6) throw new Error(`${k}: local-tz chart ${a} != UTC chart ${b}`);
    }
    // And it must NOT equal treating 19:30 as UTC (the bug this fixes). The
    // ascendant swings ~95° over a 6h shift, so it can't drift past the check.
    const wrong = await (await fetch(base + '/api/astro/chart?date=1990-05-15&time=19:30&lat=39.74&lon=-104.99')).json();
    const ascDelta = Math.abs(((local.houses.ascendant.longitude - wrong.houses.ascendant.longitude) % 360 + 540) % 360 - 180);
    if (ascDelta < 10) throw new Error(`tz appears ignored — ascendant only moved ${ascDelta.toFixed(1)}°`);
  });

  await check('tz= rejects bogus zones with a helpful 400', async () => {
    const r = await fetch(base + '/api/astro/chart?date=1990-05-15&time=19:30&tz=Mars/Olympus');
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
    const d = await r.json();
    if (!/IANA/.test(d.error)) throw new Error('unhelpful error: ' + d.error);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  child.kill('SIGTERM');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('test harness error:', e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
