// tests/test_tts.js — chunker invariants + /api/tts proxy contract.
// Part 1 is pure unit (offline). Part 2 boots server.js against a STUB upstream
// (no real Kokoro needed) and kills the stub to prove the error contract;
// nothing here touches the network beyond loopback, so it runs in offline suites.
// Run: node tests/test_tts.js
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { splitSpeechChunks, CHUNK_MAX } = require('../src/tts');

// ---- Part 1: chunker ---------------------------------------------------------
{
  assert.deepStrictEqual(splitSpeechChunks(''), []);
  assert.deepStrictEqual(splitSpeechChunks('   \n\n  '), []);
}
{
  // Short text → exactly one chunk, text preserved.
  const c = splitSpeechChunks('Hello there. This fits in one chunk.');
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0], 'Hello there. This fits in one chunk.');
}
{
  // Multiple sentences group greedily but never exceed the cap; every sentence
  // stays whole; concatenation of chunks reproduces all words in order.
  const sentence = (n) => `Sentence number ${n} runs a comfortable length for speech.`;
  const text = Array.from({ length: 20 }, (_, i) => sentence(i + 1)).join(' ');
  const chunks = splitSpeechChunks(text);
  assert.ok(chunks.length > 1, 'expected multiple chunks');
  for (const ch of chunks) {
    assert.ok(ch.length <= CHUNK_MAX, `chunk too long: ${ch.length}`);
    // no chunk ends mid-sentence
    assert.ok(/[.!?]$/.test(ch.trim()), `chunk does not end on sentence boundary: "${ch.slice(-40)}"`);
  }
  const rejoined = chunks.join(' ').split(/\s+/).filter(Boolean).join(' ');
  assert.strictEqual(rejoined, text.split(/\s+/).filter(Boolean).join(' '));
}
{
  // A single sentence longer than the cap hard-cuts on word boundaries: every
  // token survives intact and in order (distinct words → a mid-word cut shows up).
  const words = Array.from({ length: 200 }, (_, i) => `word${i + 1}`);
  const long = words.join(' ') + '.';
  const chunks = splitSpeechChunks(long);
  assert.ok(chunks.length >= Math.ceil(long.length / CHUNK_MAX) - 1);
  for (const ch of chunks) {
    assert.ok(ch.length <= CHUNK_MAX, `hard cut exceeded cap: ${ch.length}`);
    // never ends mid-word: last token must be a whole word (optionally + final '.')
    const last = ch.trimEnd().split(/\s+/).pop();
    assert.ok(/^word\d+\.?$/.test(last), `chunk cut mid-word, ends with "${last}"`);
  }
  const got = chunks.join(' ').trim().replace(/\.$/, '').split(/\s+/);
  assert.deepStrictEqual(got, words);
}
{
  // Paragraph breaks collapse to single spaces (blocksToSpeechText output is prose already).
  const c = splitSpeechChunks('First para.\n\nSecond para.');
  assert.deepStrictEqual(c, ['First para. Second para.']);
}
console.log(`ok   chunker unit tests (${CHUNK_MAX} cap)`);

// ---- Part 1a: voice-shape normalization ---------------------------------------
{
  const { normalizeVoices } = require('../src/routes/tts');
  assert.deepStrictEqual(normalizeVoices({ object: 'list', data: [{ id: 'af_bella' }] }), { voices: [{ id: 'af_bella' }] });
  assert.deepStrictEqual(normalizeVoices({ voices: ['am_adam', { name: 'x' }] }), { voices: [{ id: 'am_adam' }] });
  assert.deepStrictEqual(normalizeVoices([{ id: 'a' }, 'b']), { voices: [{ id: 'a' }, { id: 'b' }] });
  assert.deepStrictEqual(normalizeVoices(null), { voices: [] });
}
console.log('ok   normalizeVoices shapes');

// ---- Part 1b: frontend/backend chunker parity ---------------------------------
// frontend/src/tts-chunks.js is an ESM twin of src/tts.js (see header comment).
// Same fixtures through both; any divergence fails npm test.
const FIXTURES = [
  '', '   ', '\n\n',
  'Hello there. This fits in one chunk.',
  'First para.\n\nSecond para.',
  'Tiny.', 'One! Two? Three.',
  Array.from({ length: 30 }, (_, i) => `Greedily grouped sentence number ${i} with filler.`).join('  '), // double-space collapse too
  Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ') + '.',           // no punctuation → one giant sentence → hard cuts
  'A'.repeat(600) + '.',                                                        // one unbreakable mega-word
  'Ends without punctuation and then a question? Yes. And more text follows!',
];

// ---- Part 2: proxy routes against a stub upstream ----------------------------
process.env.PORT = process.env.TEST_PORT || '8094';
const TTS_STUB_PORT = process.env.TEST_TTS_PORT || '8095';

(async () => {
  const fe = await import('../frontend/src/tts-chunks.js');
  for (let i = 0; i < FIXTURES.length; i++) {
    assert.deepStrictEqual(fe.splitSpeechChunks(FIXTURES[i]), splitSpeechChunks(FIXTURES[i]),
      `chunker parity mismatch on fixture ${i}`);
  }
  assert.strictEqual(fe.CHUNK_MAX, CHUNK_MAX);
  console.log(`ok   chunker frontend/backend parity (${FIXTURES.length} fixtures)`);


  // Stub Kokoro: GET /v1/voices, POST /v1/audio/speech (counts calls so we can assert cache hits).
  let synthCalls = 0;
  const FAKE_MP3 = Buffer.from('ID3\x03\x00fake-mp3-bytes', 'binary');
  const stub = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/voices') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ voices: [{ id: 'af_heart' }, { id: 'am_adam' }] }));
    }
    if (req.method === 'POST' && req.url === '/v1/audio/speech') {
      synthCalls++;
      let body = '';
      req.on('data', d => body += d);
      return req.on('end', () => {
        const parsed = JSON.parse(body);
        if (parsed.model !== 'kokoro' || !parsed.input) {
          res.writeHead(400); return res.end('{}');
        }
        // Echo voice into bytes so cache-key isolation is observable.
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(Buffer.concat([FAKE_MP3, Buffer.from(parsed.voice)]));
      });
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => stub.listen(Number(TTS_STUB_PORT), '127.0.0.1', r));

  // Isolate state BEFORE requiring the server (db.js reads env at load time).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bobs-tts-test-'));
  fs.mkdirSync(path.join(tmpDir, 'documents'), { recursive: true });
  process.env.DB_PATH = path.join(tmpDir, 'test.db');
  process.env.DOCS_DIR = path.join(tmpDir, 'documents');
  process.env.TTS_URL = `http://127.0.0.1:${TTS_STUB_PORT}`;

  const base = `http://127.0.0.1:${process.env.PORT}`;
  let passed = 0, failed = 0;
  async function check(name, fn) {
    try { await fn(); passed++; console.log(`ok   ${name}`); }
    catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
  }

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
  if (!up) { console.error('server did not start:\n' + serverLog); stub.close(); process.exit(1); }

  const postSynth = (body) => fetch(`${base}/api/tts/synth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  await check('GET /api/tts/voices passes upstream list through', async () => {
    const r = await fetch(`${base}/api/tts/voices`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    assert.ok(Array.isArray(d.voices) && d.voices.some(v => v.id === 'af_heart'));
  });

  // ---- validation happens BEFORE upstream (stub call count stays flat) -------
  await check('400 on missing/empty text', async () => {
    for (const body of [{}, { text: '' }, { text: '   ' }]) {
      const r = await postSynth(body);
      assert.strictEqual(r.status, 400, `body ${JSON.stringify(body)} → ${r.status}`);
      assert.ok((await r.json()).error);
    }
    assert.strictEqual(synthCalls, 0, 'validation must not reach upstream');
  });

  await check('400 on over-long text (cap 5000)', async () => {
    const r = await postSynth({ text: 'a'.repeat(5001) });
    assert.strictEqual(r.status, 400);
  });

  await check('400 on invalid voice', async () => {
    for (const v of ['AF HEART', '../etc/passwd', "af_'; DROP", 'a_x', 'af_heart++', '']) {
      const r = await postSynth({ text: 'Hi.', voice: v });
      assert.strictEqual(r.status, 400, `voice ${JSON.stringify(v)} → ${r.status}`);
    }
    assert.strictEqual(synthCalls, 0);
  });

  await check('400 on out-of-range / non-numeric speed', async () => {
    for (const s of [0.1, 4.5, 'fast', -1]) {
      const r = await postSynth({ text: 'Hi.', speed: s });
      assert.strictEqual(r.status, 400, `speed ${JSON.stringify(s)} → ${r.status}`);
    }
    // valid combo passes (voice list + speed)
    const ok = await postSynth({ text: 'Hello world.', voice: 'af_bella+af_sky', speed: 1.25 });
    assert.strictEqual(ok.status, 200, `valid synth → ${ok.status}`);
  });

  // ---- cache behavior ---------------------------------------------------------
  let firstBytes;
  await check('synth returns audio/mpeg and caches to disk', async () => {
    const before = synthCalls;
    const r = await postSynth({ text: 'Cache me if you can.', voice: 'af_heart' });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /audio\/mpeg/);
    assert.match(r.headers.get('cache-control') || '', /max-age=\d+/);
    firstBytes = Buffer.from(await r.arrayBuffer());
    assert.ok(firstBytes.includes('fake-mp3-bytes'));
    assert.strictEqual(synthCalls, before + 1);

    const cacheDir = path.join(tmpDir, 'tts-cache');
    // Key format mirrors src/routes/tts.js: sha256(`${voice}|${speed ?? ''}|${text}`)
    const key = require('crypto').createHash('sha256')
      .update('af_heart||Cache me if you can.').digest('hex');
    assert.ok(fs.existsSync(path.join(cacheDir, `${key}.mp3`)), 'expected cached file missing');
  });

  await check('identical request is a cache hit (no upstream call)', async () => {
    const before = synthCalls;
    const r = await postSynth({ text: 'Cache me if you can.', voice: 'af_heart' });
    assert.strictEqual(r.status, 200);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.ok(bytes.equals(firstBytes));
    assert.strictEqual(synthCalls, before, 'cache hit must not reach upstream');
  });

  await check('different voice → different cache key (upstream called again)', async () => {
    const before = synthCalls;
    const r = await postSynth({ text: 'Cache me if you can.', voice: 'am_adam' });
    assert.strictEqual(r.status, 200);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.ok(!bytes.equals(firstBytes), 'voice change must not return other voice audio');
    assert.strictEqual(synthCalls, before + 1);
  });

  // ---- upstream failure contract ---------------------------------------------
  await check('upstream down → synth 502 tts_upstream, voices 503 tts_unavailable', async () => {
    stub.close();
    await new Promise(r => stub.on('close', r));
    const s = await postSynth({ text: 'This will fail.', voice: 'af_heart' }); // uncached text
    assert.strictEqual(s.status, 502);
    assert.strictEqual((await s.json()).error, 'tts_upstream');
    const v = await fetch(`${base}/api/tts/voices`);
    assert.strictEqual(v.status, 503);
    assert.strictEqual((await v.json()).error, 'tts_unavailable');
  });

  child.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
