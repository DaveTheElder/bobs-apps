// tests/test_slideshows.js — boots server.js against a TEMP db + SLIDESHOW_DIR,
// exercises every slideshow route (docs/archive/SLIDESHOW_PLAN.md phase 1).
// Run: node tests/test_slideshows.js   (PORT 8093 by default)
process.env.PORT = process.env.TEST_PORT || '8093';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobs-slides-'));
fs.mkdirSync(path.join(tmpDir, 'documents'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'slideshow-photos'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'slideshow-audio'), { recursive: true });
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DOCS_DIR = path.join(tmpDir, 'documents');
process.env.SLIDESHOW_DIR = path.join(tmpDir, 'slideshow-photos');
process.env.SLIDESHOW_AUDIO_DIR = path.join(tmpDir, 'slideshow-audio');
// yt-dlp is stubbed: same CLI contract (see tests/stub_ytdl.py), no network.
process.env.YTDL_BIN = path.join(__dirname, 'stub_ytdl.py');

const base = `http://127.0.0.1:${process.env.PORT}`;
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

// Minimal but real 1x1 JPEG/PNG/GIF bytes for upload tests.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const JPEG_FAKE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

(async () => {
  const child = require('child_process').spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: process.env, stdio: ['ignore', 'pipe', 'pipe']
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

  // ---- shows CRUD -----------------------------------------------------------
  let showId;
  await check('GET /api/slideshows starts empty', async () => {
    const d = await (await fetch(base + '/api/slideshows')).json();
    if (d.slideshows.length !== 0) throw new Error('expected 0 shows');
  });

  await check('POST /api/slideshows requires title', async () => {
    const r = await fetch(base + '/api/slideshows', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
    });
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
  });

  await check('POST /api/slideshows creates show', async () => {
    const r = await fetch(base + '/api/slideshows', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Emma Birthday' })
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    showId = d.id;
    if (d.loop !== 1) throw new Error('loop should default to 1 (TV unattended)');
    if (d.per_slide_seconds !== 5) throw new Error('default per_slide_seconds should be 5');
  });

  await check('PATCH validates music_url host', async () => {
    const r = await fetch(`${base}/api/slideshows/${showId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ music_url: 'https://vimeo.com/12345' })
    });
    if (r.status !== 400) throw new Error(`non-YouTube URL should 400, got ${r.status}`);
    const ok = await fetch(`${base}/api/slideshows/${showId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ music_url: 'https://music.youtube.com/playlist?list=PLabc123' })
    });
    if (!ok.ok) throw new Error(`youtube URL rejected: ${ok.status}`);
  });

  await check('PATCH validates mode/transition/duration', async () => {
    for (const body of [{ mode: 'vibe' }, { transition: 'wipe' }, { per_slide_seconds: 0 }]) {
      const r = await fetch(`${base}/api/slideshows/${showId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      if (r.status !== 400) throw new Error(`${JSON.stringify(body)} should 400, got ${r.status}`);
    }
  });

  // ---- uploads ------------------------------------------------------------------
  let photoIds = [];
  await check('upload rejects bad Content-Type', async () => {
    const r = await fetch(`${base}/api/slideshows/${showId}/photos`, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: PNG_1PX
    });
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
  });

  await check('upload to unknown show 404s', async () => {
    const r = await fetch(`${base}/api/slideshows/nope/photos`, {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG_1PX
    });
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
  });

  // ct/body pairs must match — a previous version destructured this wrong and
  // uploaded JPEG bytes under image/png, which the server (correctly) stored as-is.
  const UPLOADS = [
    ['image/png', PNG_1PX],
    ['image/png', PNG_1PX],
    ['image/jpeg', JPEG_FAKE],
  ];
  for (const [i, [ct, body]] of UPLOADS.entries()) {
    await check(`upload photo #${i + 1} (${ct})`, async () => {
      const r = await fetch(`${base}/api/slideshows/${showId}/photos?caption=Shot ${i + 1}`, {
        method: 'POST', headers: { 'Content-Type': ct }, body
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const d = await r.json();
      photoIds.push(d.id);
      if (d.position !== i) throw new Error(`position should be ${i}, got ${d.position}`);
      if (d.file_size !== body.length) throw new Error('server-side size mismatch');
      if (!/^[0-9a-f-]+\.(png|jpg)$/.test(d.filename)) throw new Error(`bad server filename: ${d.filename}`);
    });
  }

  await check('GET show detail lists photos in order', async () => {
    const d = await (await fetch(`${base}/api/slideshows/${showId}`)).json();
    if (d.photos.length !== 3) throw new Error(`expected 3 photos, got ${d.photos.length}`);
    if (d.photos.map(p => p.id).join() !== photoIds.join()) throw new Error('order mismatch');
    if (d.photos[0].caption !== 'Shot 1') throw new Error('caption lost');
  });

  await check('GET list reports photo_count', async () => {
    const d = await (await fetch(base + '/api/slideshows')).json();
    const show = d.slideshows.find(s => s.id === showId);
    if (show.photo_count !== 3) throw new Error(`photo_count=${show.photo_count}`);
  });

  // ---- photo bytes -----------------------------------------------------------------
  await check('GET photo bytes serves image with immutable cache', async () => {
    const d = await (await fetch(`${base}/api/slideshows/${showId}`)).json();
    const pngPhoto = d.photos.find(p => p.filename.endsWith('.png'));   // order was reshuffled above; grab a PNG specifically
    const r = await fetch(`${base}/api/slideshow-photos/${pngPhoto.filename}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (r.headers.get('content-type') !== 'image/png') throw new Error('wrong content-type');
    if (!/immutable/.test(r.headers.get('cache-control') || '')) throw new Error('missing immutable cache');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length !== PNG_1PX.length) {
      throw new Error(`bytes differ: sent ${PNG_1PX.length} got ${buf.length}`);
    }
  });

  await check('photo route blocks traversal', async () => {
    const r = await fetch(`${base}/api/slideshow-photos/..%2Ftest.db`);
    if (r.status === 200) throw new Error('traversal served a file!');
  });

  // ---- reorder -----------------------------------------------------------------------
  await check('PUT order rejects incomplete id list', async () => {
    const r = await fetch(`${base}/api/slideshows/${showId}/order`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_ids: [photoIds[0]] })
    });
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
  });

  await check('PUT order rejects duplicates', async () => {
    const r = await fetch(`${base}/api/slideshows/${showId}/order`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_ids: [photoIds[0], photoIds[0], photoIds[2]] })
    });
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
  });

  await check('PUT order reorders and persists', async () => {
    const next = [photoIds[2], photoIds[0], photoIds[1]];
    const r = await fetch(`${base}/api/slideshows/${showId}/order`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photo_ids: next })
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await (await fetch(`${base}/api/slideshows/${showId}`)).json();
    if (d.photos.map(p => p.id).join() !== next.join()) throw new Error('order did not persist');
  });

  // ---- photo patch/delete ---------------------------------------------------------------
  let keepId;
  await check('PATCH photo caption + duration_override', async () => {
    const r = await fetch(`${base}/api/slideshows/photos/${photoIds[0]}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caption: 'Recaptioned', duration_override: 12.5 })
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (d.caption !== 'Recaptioned' || d.duration_override !== 12.5) throw new Error('patch not reflected');
  });

  await check('PATCH photo rejects out-of-range duration', async () => {
    const r = await fetch(`${base}/api/slideshows/photos/${photoIds[0]}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration_override: 9999 })
    });
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
  });

  await check('DELETE photo unlinks file on disk', async () => {
    const detail = await (await fetch(`${base}/api/slideshows/${showId}`)).json();
    const victim = detail.photos.find(p => p.id === photoIds[1]);
    const r = await fetch(`${base}/api/slideshows/photos/${victim.id}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (fs.existsSync(path.join(process.env.SLIDESHOW_DIR, victim.filename))) {
      throw new Error('file still on disk after delete');
    }
  });

  // ---- background music: yt-dlp render to local files -------------------------
  await check('PATCH music_url starts download; status flips downloading->ready', async () => {
    let r = await fetch(`${base}/api/slideshows/${showId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ music_url: 'https://music.youtube.com/watch?v=dqM_zebYsDg&list=PLstubbed' })
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    // Stub is near-instant; poll briefly for the async child to finish.
    let detail;
    for (let i = 0; i < 40; i++) {
      await new Promise(rs => setTimeout(rs, 150));
      detail = await (await fetch(`${base}/api/slideshows/${showId}`)).json();
      if (detail.audio_status === 'ready') break;
    }
    if (detail.audio_status !== 'ready') throw new Error(`status=${detail.audio_status} err=${detail.audio_error}`);
    if (detail.tracks.length !== 2) throw new Error(`expected 2 tracks, got ${detail.tracks.length}`);
    if (!detail.tracks[0].filename.endsWith('.m4a')) throw new Error('track filename wrong');
  });

  await check('GET /api/slideshow-audio serves track bytes with Range support', async () => {
    const detail = await (await fetch(`${base}/api/slideshows/${showId}`)).json();
    const fn = detail.tracks[0].filename;
    const full = await fetch(`${base}/api/slideshow-audio/${fn}`);
    if (!full.ok) throw new Error(`HTTP ${full.status}`);
    const buf = Buffer.from(await full.arrayBuffer());
    if (!buf.length) throw new Error('empty body');
    const part = await fetch(`${base}/api/slideshow-audio/${fn}`, { headers: { Range: 'bytes=0-4' } });
    if (part.status !== 206 || (await part.arrayBuffer()).byteLength !== 5) {
      throw new Error(`range request not honored: ${part.status}`);
    }
  });

  await check('audio route rejects traversal + bad extension', async () => {
    let r = await fetch(`${base}/api/slideshow-audio/..%2F..%2Fetc%2Fpasswd`);
    if (r.status === 200) throw new Error('traversal served!');
    r = await fetch(`${base}/api/slideshow-audio/whatever.exe`);
    if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
  });

  await check('download failure lands in audio_error', async () => {
    // The stub fails downloads whose video id starts with "fail" (stub_ytdl.py);
    // an env-var toggle wouldn't work: the server child's env is frozen at spawn.
    const r2 = await fetch(base + '/api/slideshows', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Failing' })
    });
    const s2 = (await r2.json()).id;
    await fetch(`${base}/api/slideshows/${s2}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ music_url: 'https://www.youtube.com/watch?v=failvid001' })
    });
    let detail;
    for (let i = 0; i < 40; i++) {
      await new Promise(rs => setTimeout(rs, 150));
      detail = await (await fetch(`${base}/api/slideshows/${s2}`)).json();
      if (detail.audio_status === 'error') break;
    }
    if (detail.audio_status !== 'error') throw new Error(`expected error status, got ${detail.audio_status}`);
    if (!/403|ERROR|exit/i.test(detail.audio_error)) throw new Error(`unhelpful error: "${detail.audio_error}"`);
  });

  // ---- show delete ----------------------------------------------------------------------
  await check('DELETE show removes rows AND all files', async () => {
    const before = await (await fetch(`${base}/api/slideshows/${showId}`)).json();
    const filesOnDisk = before.photos.map(p => path.join(process.env.SLIDESHOW_DIR, p.filename));
    const r = await fetch(`${base}/api/slideshows/${showId}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const gone = await (await fetch(`${base}/api/slideshows/${showId}`));
    if (gone.status !== 404) throw new Error('show survived delete');
    for (const f of filesOnDisk) {
      if (fs.existsSync(f)) throw new Error(`orphan file left behind: ${f}`);
    }
  });

  await check('GET deleted show detail is empty', async () => {
    const r = await fetch(`${base}/api/slideshows/${showId}`);
    if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
  });

  child.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
