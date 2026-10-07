// frontend/src/tts-chunks.js — read-aloud chunking, browser side.
//
// ESM twin of src/tts.js (CommonJS; backend/ is outside the Vite root so it
// can't be imported directly). tests/test_tts.js runs a parity suite against
// both copies with identical fixtures — if you edit one and not the other,
// npm test fails. Keep them in lockstep.

export const CHUNK_MAX = 500;

function normalize(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

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

// Split normalized speech text into synthesis chunks (<= CHUNK_MAX chars,
// sentence boundaries preferred). "" / whitespace -> [].
export function splitSpeechChunks(text) {
  const norm = normalize(text);
  if (!norm) return [];

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
