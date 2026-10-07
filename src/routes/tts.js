// src/routes/tts.js — read-aloud synthesis proxy (Kokoro-FastAPI upstream).
//
// Why a proxy instead of browser → Kokoro directly: Kokoro runs loopback-only on
// the homelab Docker network (no Caddy route, no published port), and mp3s are
// cached on disk — re-reading a document costs zero inference. Same reasoning as
// src/geocode.js: third-party-ish upstream behind one server-side door.
//
// Validation runs BEFORE any upstream call (settings-menu lesson: never forward
// unvalidated option values to another service). Upstream errors surface as
// {error:'tts_upstream'} 502 / 'tts_unavailable' 503 so the frontend can fall
// back to speechSynthesis without parsing prose.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// Kokoro voice ids look like af_heart, am_adam, bf_sky; '+' mixes allowed.
// This regex is the whole injection story for `voice` — everything else is a 400.
const VOICE_RE = /^[a-z]{2}_[a-z]+(_[a-z]+)*(\+[a-z_]+)*$/;

const TEXT_MAX = 5000;                 // per request; frontend chunker caps at 500
const UPSTREAM_TIMEOUT_MS = 15000;     // CPU synthesis of a 500-char paragraph is ~sub-second; this is the hung-service net
const VOICES_TIMEOUT_MS = 8000;
const CACHE_MAX_BYTES = 100 * 1024 * 1024;

// Kokoro returns {object,data}; older builds/other engines use {voices} or a
// bare array. Contract to the frontend: always { voices: [{ id }] }.
function normalizeVoices(body) {
  const list = Array.isArray(body) ? body : ((body && (body.voices || body.data)) || []);
  return {
    voices: list
      .map(v => ({ id: typeof v === 'string' ? v : (v && v.id) }))
      .filter(v => v.id),
  };
}

module.exports = ttsRoutes;
module.exports.normalizeVoices = normalizeVoices; // exported for tests

function ttsRoutes({ DOCS_DIR }) {
  const router = express.Router();
  const TTS_BASE = (process.env.TTS_URL || 'http://kokoro:8880').replace(/\/$/, '');
  // Cache lives beside docs/ under /data so it survives rebuilds like everything else.
  const CACHE_DIR = path.join(DOCS_DIR, '..', 'tts-cache');

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  function cachePath(text, voice, speed) {
    const key = crypto.createHash('sha256')
      .update(`${voice || ''}|${speed ?? ''}|${text}`).digest('hex');
    return path.join(CACHE_DIR, `${key}.mp3`);
  }

  // Boot sweep: drop oldest cached mp3s until under CACHE_MAX_BYTES. One pass at
  // startup beats a per-request janitor; the dir only grows via this route.
  (async () => {
    try {
      const names = await fsp.readdir(CACHE_DIR);
      const stats = [];
      let total = 0;
      for (const n of names) {
        if (!n.endsWith('.mp3')) continue;
        const st = await fsp.stat(path.join(CACHE_DIR, n)).catch(() => null);
        if (st) { stats.push({ p: path.join(CACHE_DIR, n), mtimeMs: st.mtimeMs, size: st.size }); total += st.size; }
      }
      if (total <= CACHE_MAX_BYTES) return;
      stats.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
      for (const s of stats) {
        if (total <= CACHE_MAX_BYTES) break;
        await fsp.rm(s.p, { force: true });
        total -= s.size;
      }
    } catch (e) {
      console.error(`[tts] cache sweep failed: ${e.message}`); // never fatal
    }
  })();

  async function upstream(pathname, { method, body, timeoutMs }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(TTS_BASE + pathname, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- voices ---------------------------------------------------------------
  router.get('/api/tts/voices', async (_req, res) => {
    try {
      const r = await upstream('/v1/voices', { method: 'GET', timeoutMs: VOICES_TIMEOUT_MS });
      if (!r.ok) return res.status(503).json({ error: 'tts_unavailable' });
      res.json(normalizeVoices(await r.json()));
    } catch {
      res.status(503).json({ error: 'tts_unavailable' });
    }
  });

  // ---- synth ----------------------------------------------------------------
  router.post('/api/tts/synth', async (req, res) => {
    const { text, voice, speed } = req.body || {};

    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required and must be non-empty' });
    }
    if (text.length > TEXT_MAX) {
      return res.status(400).json({ error: `text exceeds ${TEXT_MAX} chars` });
    }
    if (voice !== undefined && !(typeof voice === 'string' && VOICE_RE.test(voice))) {
      return res.status(400).json({ error: 'invalid voice id' });
    }
    if (speed !== undefined && !(typeof speed === 'number' && Number.isFinite(speed) && speed >= 0.25 && speed <= 4.0)) {
      return res.status(400).json({ error: 'speed must be a number between 0.25 and 4.0' });
    }

    // Normalize identically to the frontend chunker so cache keys line up with
    // what the client will request on playback.
    const spoken = text.trim().replace(/\s+/g, ' ');
    const file = cachePath(spoken, voice, speed);

    try {
      if (fs.existsSync(file)) {
        res.set('Content-Type', 'audio/mpeg');
        res.set('Cache-Control', 'private, max-age=86400');
        return fs.createReadStream(file).pipe(res);
      }
    } catch { /* unreadable cache entry behaves as a miss */ }

    let audio;
    try {
      const r = await upstream('/v1/audio/speech', {
        method: 'POST',
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        body: {
          model: 'kokoro',
          input: spoken,
          response_format: 'mp3',
          ...(voice ? { voice } : {}),
          ...(speed !== undefined ? { speed } : {}),
        },
      });
      if (!r.ok) return res.status(502).json({ error: 'tts_upstream' });
      // Full buffer, not a pipe: chunks are paragraph-sized (<1 MB mp3) and we
      // need the bytes on disk before serving. Atomic tmp+rename — no torn files.
      audio = Buffer.from(await r.arrayBuffer());
    } catch {
      return res.status(502).json({ error: 'tts_upstream' });
    }

    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await fsp.writeFile(tmp, audio);
      await fsp.rename(tmp, file); // atomic on same filesystem (both in tts-cache/)
    } catch (e) {
      console.error(`[tts] cache write failed: ${e.message}`); // serve anyway; caching is an optimization
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }

    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    res.end(audio);
  });

  return router;
};
