// src/tts.js — speech chunking for read-aloud synthesis.
//
// Why: Kokoro synthesizes one request per audio file, and first-audio latency
// is bounded by the size of the first request. We send sentence-grouped chunks
// capped at CHUNK_MAX chars so playback starts in <1s and each chunk is a
// cacheable unit (sha256(voice|speed|text) → mp3).
//
// The frontend keeps an identical copy (frontend/src/tts-chunks.js, ESM — no
// bundler aliasing between backend/ and frontend/src/) pinned by a parity test
// in tests/test_tts.js. Change one, change both; the test fails loudly.

const CHUNK_MAX = 500;

// Collapse all whitespace (paragraph breaks included) to single spaces —
// blocksToSpeechText() output is prose already; TTS engines don't read \n\n.
function normalize(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

// Hard-cut an over-long sentence on word boundaries. Returns pieces ≤ CHUNK_MAX;
// a single word longer than the cap becomes its own oversized piece (we refuse
// to mangle words mid-syllable — slightly late audio beats a broken word).
function hardCut(sentence) {
  const words = sentence.split(' ');
  const pieces = [];
  let cur = '';
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if (cur.length + 1 + w.length <= CHUNK_MAX) cur += ' ' + w;
    else { pieces.push(cur); cur = w; }
  }
  if (cur) pieces.push(cur);
  return pieces;
}

/**
 * Split normalized speech text into synthesis chunks.
 * Greedy sentence grouping up to CHUNK_MAX chars; sentences are never split
 * unless one alone exceeds the cap. "" / whitespace → [].
 */
function splitSpeechChunks(text) {
  const norm = normalize(text);
  if (!norm) return [];

  // Split after ., ! or ? when followed by a space (or end). Lookbehind is safe: Node >=16.
  // The separator space lands on the next fragment — trim it off; we rejoin with ' '.
  const sentences = norm.split(/(?<=[.!?])(?=\s)/).map((s) => s.trim()).filter(Boolean);

  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (s.length > CHUNK_MAX) {
      if (cur) { chunks.push(cur); cur = ''; }
      chunks.push(...hardCut(s));
      continue;
    }
    if (!cur) { cur = s; continue; }
    if (cur.length + 1 + s.length <= CHUNK_MAX) cur += ' ' + s;
    else { chunks.push(cur); cur = s; }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

module.exports = { splitSpeechChunks, normalize, CHUNK_MAX };
