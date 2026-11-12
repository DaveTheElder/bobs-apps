// tests/test_news.js — boots server.js against a TEMP db and exercises every
// news route (list/create/get/update/delete + filter/sort contract in
// src/routes/news.js). Mirrors the test_slideshows.js harness.
// Run: node tests/test_news.js   (PORT 8094 by default)
process.env.PORT = process.env.TEST_PORT || '8094';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobs-news-'));
fs.mkdirSync(path.join(tmpDir, 'documents'), { recursive: true });
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DOCS_DIR = path.join(tmpDir, 'documents');

const base = `http://127.0.0.1:${process.env.PORT}`;
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

const json = (method, p, body) =>
  fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

(async () => {
  const child = require('child_process').spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', d => serverLog += d);
  child.stderr.on('data', d => serverLog += d);

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { const r = await fetch(base + '/health'); up = r.ok; } catch {}
  }
  if (!up) { console.error('server did not start:\n' + serverLog); process.exit(1); }

  await check('GET /api/news starts empty', async () => {
    const r = await json('GET', '/api/news');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (d.news.length !== 0) throw new Error(`expected 0 items, got ${d.news.length}`);
  });

  let topId, secondId;
  await check('POST /api/news creates item with defaults', async () => {
    const r = await json('POST', '/api/news', {
      title: 'Second story', summary: 'Summary B', category: 'tech',
      published_at: '2026-10-19T06:30:00Z',
    });
    if (r.status !== 201) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    secondId = d.id;
    if (d.category !== 'tech') throw new Error('category not stored');
    if (d.featured !== 0) throw new Error('featured should default to 0');
  });

  await check('POST /api/news honors featured + content', async () => {
    const r = await json('POST', '/api/news', {
      title: 'Top story', summary: 'Summary A', content: 'Deep dive body',
      source: 'AP', url: 'https://example.com/a', featured: true,
      published_at: '2026-10-20T06:30:00Z',
    });
    if (r.status !== 201) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    topId = d.id;
    if (d.featured !== 1) throw new Error('featured not coerced to 1');
  });

  await check('POST /api/news rejects missing title/summary', async () => {
    for (const body of [{ summary: 'x' }, { title: 'x' }, { title: '  ', summary: 'x' }]) {
      const r = await json('POST', '/api/news', body);
      if (r.status !== 400) throw new Error(`expected 400 for ${JSON.stringify(body)}, got ${r.status}`);
    }
  });

  await check('GET list puts featured first, newest second', async () => {
    const d = await (await json('GET', '/api/news')).json();
    if (d.news[0].id !== topId) throw new Error('featured item should lead');
    if (d.news[1].id !== secondId) throw new Error('newest non-featured should follow');
  });

  await check('GET list filters by category and featured=1', async () => {
    const world = await (await json('GET', '/api/news?category=world')).json();
    if (world.news.length !== 0) throw new Error('expected empty world filter');
    const tech = await (await json('GET', '/api/news?category=tech')).json();
    if (tech.news.length !== 1 || tech.news[0].id !== secondId) throw new Error('tech filter wrong');
    const feat = await (await json('GET', '/api/news?featured=1')).json();
    if (feat.news.length !== 1 || feat.news[0].id !== topId) throw new Error('featured filter wrong');
  });

  await check('GET /api/news/:id returns row; unknown id 404s', async () => {
    const r = await json('GET', `/api/news/${topId}`);
    const d = await r.json();
    if (d.content !== 'Deep dive body') throw new Error('content mismatch');
    const miss = await json('GET', '/api/news/nope');
    if (miss.status !== 404) throw new Error(`expected 404, got ${miss.status}`);
  });

  await check('PUT updates subset fields and recomputes featured', async () => {
    const r = await json('PUT', `/api/news/${secondId}`, { featured: '1', summary: 'Updated B' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (d.featured !== 1 || d.summary !== 'Updated B') throw new Error('update not applied');
    if (d.title !== 'Second story') throw new Error('untouched field changed');
    const empty = await json('PUT', `/api/news/${secondId}`, { category: '' });
    // empty category is falsy → stored as '' per contract; must still be 200
    if (!empty.ok) throw new Error(`HTTP ${empty.status}`);
    const bad = await json('PUT', `/api/news/${secondId}`, { title: '  ' });
    if (bad.status !== 400) throw new Error(`blank title should 400, got ${bad.status}`);
    const gone = await json('PUT', '/api/news/nope', { title: 'x' });
    if (gone.status !== 404) throw new Error(`expected 404, got ${gone.status}`);
  });

  await check('sort=name orders alphabetically', async () => {
    // Both rows are featured=1 by now, so title ASC fully determines order.
    const d = await (await json('GET', '/api/news?sort=name')).json();
    const titles = d.news.map(i => i.title);
    const sorted = [...titles].sort((a, b) => a.localeCompare(b));
    if (titles.join() !== sorted.join()) throw new Error(`name sort wrong: ${titles}`);
  });

  await check('DELETE removes row; second delete 404s', async () => {
    const r = await json('DELETE', `/api/news/${secondId}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const again = await json('DELETE', `/api/news/${secondId}`);
    if (again.status !== 404) throw new Error(`expected 404, got ${again.status}`);
    const d = await (await json('GET', '/api/news')).json();
    if (d.news.length !== 1) throw new Error('delete removed the wrong row count');
  });

  child.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
