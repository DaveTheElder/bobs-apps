# Kokoro TTS for Document Preview Read-Aloud — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace the browser's `speechSynthesis` robot voice in the bobs-apps document preview with high-quality local TTS served by Kokoro-FastAPI on LilServ, proxied through the bobs-apps backend.

**Architecture:** New Docker service `kokoro-fastapi` (CPU, OpenAI-compatible `/v1/audio/speech`) joins the homelab compose stack, loopback-private — only reachable from containers on the `homelab` network, never exposed via Caddy. The bobs-apps backend gains a thin `/api/tts/*` proxy: voice listing + per-chunk synthesis with an on-disk mp3 cache. The frontend keeps chunk-queue control (one HTTP request → one mp3 blob → `<audio>` playlist), which gives us real pause/skip/stop for free and kills the Chrome 15-second utterance-stall hack.

**Tech Stack:** `remsky/kokoro-fastapi-cpu` Docker image, Express proxy route (same factory pattern as `src/routes/geocode.js` consumers), vanilla `<audio>` element queue in React, no new frontend dependencies.

---

## Current context / assumptions

- Read-aloud lives in `frontend/src/apps/DocumentRepository.jsx:257-332`: `useReadAloud()` (raw Web Speech API, never sets `u.voice`), `blocksToSpeechText()`, and the Chrome pause/resume stall hack at :276-285.
- Backend is Express with route factories: `app.use(docsRoutes({ db, DOCS_DIR }))` in `server.js`. New route follows the same shape. No auth on any bobs-apps route today (LAN + Caddy front door); TTS inherits that posture — it's a proxy to a CPU model, not a data boundary.
- Compose file: `/home/marvin/bobs-apps/docker-compose.yml` (copy at `/home/chimera/homelab/bobs-apps-code`). bobs-apps declares `networks: [default, homelab]` with `homelab` external — the **skill-documented** requirement from two alias-loss incidents. Kokoro must join the same network.
- Kokoro-FastAPI API (verified against repo docs):
  - `POST /v1/audio/speech` body `{model:"kokoro", input, voice:"af_heart", response_format:"mp3", speed}` → audio bytes. Speed range 0.25–4.0.
  - `GET /v1/voices` → voice list. `GET /health` for readiness. Default port 8880.
- Dave runs all LilServ deploy steps himself at his keyboard (no SSH from this box). Every infra step below is a paste-able command block.
- CPU inference: Kokoro-82M ONNX on LilServ generates faster than real-time (~10× realtime class on modern x86) — acceptable for paragraph-chunked playback where we prefetch the next chunk while the current one plays.

## Proposed approach (chunk contract)

`blocksToSpeechText()` already produces clean prose. Split it into **sentence-grouped chunks capped at ~500 chars** (Kokoro's own sentence splitting handles rhythm within a request; the cap bounds first-audio latency and cache granularity). Frontend requests chunk *i*, plays it, prefetches chunk *i+1*. Cache key: `sha256(voice + speed + text)` → `/data/tts-cache/<hash>.mp3`. Same doc re-read = instant.

Fallback: if `GET /api/tts/voices` fails (service down), the UI falls back to the existing `speechSynthesis` path — keep it, don't delete it; also add a voice `<select>` for that fallback so Edge's "Natural" online voices get picked when available (20-line stopgap value on its own).

---

## Phase 0 — Kokoro service on LilServ (Dave pastes these)

### Task 0.1: Add kokoro to the compose stack

**Files:** Modify `/home/chimera/homelab/bobs-apps-code/docker-compose.yml` (repo copy at `~/bobs-apps/docker-compose.yml` — land it in the repo first, then Dave pulls).

Append service:

```yaml
  kokoro:
    image: remsky/kokoro-fastapi-cpu:latest
    container_name: homelab-kokoro
    restart: unless-stopped
    # NO published ports: reachable only from the homelab network (bobs-apps proxy).
    networks: [homelab]
    environment:
      DEFAULT_VOICE: "af_heart"
      DEVICE: "cpu"
    volumes:
      - /home/chimera/homelab/kokoro-voices:/api/src/processing/voices_registry.json # optional pin; omit to use image defaults
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8880/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s

networks:
  homelab:
    external: true
```

(If the compose file already has a top-level `networks:` block, merge — do not duplicate the key. Verify with `docker compose config` before upping.)

**Verify:** `docker compose up -d kokoro && docker logs -f homelab-kokoro` until "Model warmed up on cpu" banner; then from the bobs-apps container:
`docker exec homelab-bobs-apps curl -sf http://kokoro:8880/v1/voices | head -c 300` → JSON voice list. (One bare curl per command — approval-allowlist discipline.)

### Task 0.2: Smoke-test synthesis end to end from the backend container

Run on LilServ:
```bash
docker exec homelab-bobs-apps sh -c 'curl -sf -X POST http://kokoro:8880/v1/audio/speech -H "Content-Type: application/json" -d "{\"model\":\"kokoro\",\"input\":\"Hello, this is a test of the read aloud feature.\",\"voice\":\"af_heart\",\"response_format\":\"mp3\"}" -o /tmp/t.mp3 && ls -la /tmp/t.mp3'
```
Expected: mp3 file ≥ ~20 KB. Note wall time (`time` it once) — if CPU synthesis is under ~1s for a 500-char paragraph we're green; anything over ~4s and revisit (bigger chunks + full prefetch, or GPU image).

---

## Phase 1 — Backend: chunker + TTS proxy route

### Task 1.1: Chunking utility

**Files:**
- Create: `src/tts.js`
- Test: `tests/test_tts.js` (add to `npm test`)

Split spoken text into sentence-safe chunks. Pure function, no I/O — testable offline.

```js
// src/tts.js
const CHUNK_MAX = 500;

// Split pre-normalized speech text into <=CHUNK_MAX-char chunks at sentence
// boundaries. Chunks never cut mid-sentence unless a single sentence exceeds
// the cap (then hard-cut on word boundaries). Invariant: concatenation of all
// chunks equals the input with whitespace between chunks collapsed.
function splitSpeechChunks(text) { /* ... */ }

module.exports = { splitSpeechChunks, CHUNK_MAX };
```

**Step 1 — failing tests:** empty → `[]`; short text → one chunk; multiple sentences grouped greedily under cap; one 900-char sentence → word-boundary hard cuts ≤500 no words broken; text with `\n\n` collapses.
**Run:** `node --test tests/test_tts.js` (match whatever runner the other `tests/*.js` use — check `package.json` scripts first) → FAIL, then implement → PASS. Commit: `feat(tts): sentence-safe chunker`.

### Task 1.2: Proxy routes

**Files:**
- Create: `src/routes/tts.js`
- Modify: `server.js` (one `app.use(ttsRoutes(...))` line)
- Test: extend `tests/test_tts.js` with API-level validation tests

Route surface (factory pattern, mirrors `docsRoutes({ db, DOCS_DIR })`):

```js
module.exports = function ttsRoutes({ DOCS_DIR }) { /* returns express.Router */ };
// TTS_URL env → default http://kokoro:8880  (compose network alias)
```

- `GET /api/tts/voices` — passthrough of upstream `/v1/voices`; 503 JSON `{error:"tts_unavailable"}` on upstream failure (frontend uses this as the fallback signal; mirror geocode.js's upstream-error handling).
- `POST /api/tts/synth` — body `{ text: string, voice?: string, speed?: number }`. Validation **before** touching upstream (settings-menu lesson: never forward unvalidated option values):
  - `text`: required non-empty string ≤ 5000 chars → else 400.
  - `voice`: `/^[a-z]{2}_[a-z_]+(\+[a-z_]+)*$/` or absent → else 400.
  - `speed`: number 0.25–4.0 or absent → else 400.
  - Cache hit: stream cached file (`Content-Type: audio/mpeg`, `Cache-Control: private, max-age=86400`). Miss: fetch upstream (15 s timeout via `AbortController`), tee to cache, stream through. Upstream error/timeout → 502 `{error:"tts_upstream"}`.
- Cache dir: `DOCS_DIR/../tts-cache` (i.e. `/data/tts-cache` in prod — survives rebuilds like docs). LRU by mtime capped at ~100 MB, swept on server boot, not per-request.

**Tests:** validation 400s + cache-key stability (`synth(text,v1)` ≠ `synth(text,v2)`) run offline against a stub upstream (tiny http server in-test — no network dependency). Live passthrough test skips when upstream unreachable, same pattern as the geocode probe in `tests/test_api.js`.
Commit: `feat(tts): /api/tts proxy with mp3 cache + validation`.

---

## Phase 2 — Frontend: `<audio>` queue player

### Task 2.1: `useTtsPlayer` hook

**Files:** Modify `frontend/src/apps/DocumentRepository.jsx` (replace `useReadAloud`, keep a slimmed `speechSynthesis` fallback path).

State: `{ mode: 'off' | 'tts' | 'fallback', speaking, paused, chunkIndex, totalChunks, voices, voice, speed }`. One module-scope `<audio>` element ref. Behavior:

1. On start: `splitSpeechChunks(blocksToSpeechText(blocks))` client-side (port the 20-line util to `frontend/src/tts-chunks.js`, import in both — single source of truth; or duplicate deliberately and pin with a parity test, pick during impl based on how frontend imports shared code today).
2. Play chunk *i*; when `audio.play()` starts, fetch chunk *i+1* (prefetch) into an object URL. Cache each fetched blob URL until stop/preview-close (`URL.revokeObjectURL` — same leak discipline as the pdfBlobUrl effect at :351).
3. Controls: Play/Pause (`audio.pause()`), Stop (revoke + reset), speed select persisted to `localStorage` under a new key `document-tts-settings-v1` (don't overload the RAG settings key), voice `<select>` populated from `/api/tts/voices`.
4. Voices fetch fails → set `mode:'fallback'`, use old speechSynthesis path with a voice picker that prefers any `getVoices()` entry matching `/natural|neural/i` (Edge gets its online voices this way for free). Delete the 12-second pause/resume stall hack **only** on the TTS path; keep it on fallback.
5. Existing unmount/preview-close effect (:354-358) must also stop audio + revoke URLs.

### Task 2.2: UI wiring in the preview header

Replace the current read-aloud button row with: play/pause, stop, voice select, speed select, `chunk i/n` progress. Keep current styling idioms (inline styles as used today). Error toast on synth failure mid-doc: "TTS server unreachable — falling back to browser voice" + resume via fallback from the failed chunk onward is **out of scope** for v1 (stop + message; YAGNI).

---

## Phase 3 — Deploy & docs

### Task 3.1: Ship it
1. `cd frontend && npm run build` → `bash scripts/publish_pages.sh`; verify hashed asset name via bare curl of `/pages/bobs-apps/index.html`.
2. Push `main`; Dave pulls on LilServ and runs the paste-able block:
   ```bash
   cd /home/chimera/homelab/bobs-apps-code && git pull --ff-only
   docker compose config            # sanity: kokoro service + homelab network parse
   docker compose up -d kokoro bobs-apps
   ```
3. Verify in the browser preview on a docx/pdf-text preview; confirm cache hit (second play of same doc starts instantly, no new upstream log lines).

### Task 3.2: Docs + skill updates (same PR)
- `DEPLOY.md`: kokoro service block + health probe + "if read-aloud silently falls back to browser voice, check `docker ps` for homelab-kokoro".
- Update the `bobs-apps-deploy` skill: TTS route lives behind compose alias `kokoro`, validation-before-upstream rule, cache location/eviction.

---

## Test / validation summary

| Layer | What | How |
|---|---|---|
| Unit | chunker invariants | `tests/test_tts.js`, offline |
| API | 400s, cache-key isolation, upstream-error 502/503 | stub upstream server in test |
| Live (skippable) | voices passthrough, real synth | probe-and-skip like geocode |
| Manual E2E | play docx preview, pause/speed/voice switch mid-read, kill kokoro container → fallback message | browser + `docker stop homelab-kokoro` |

## Risks / tradeoffs / open questions

- **CPU latency:** first real measurement is Task 0.2; the plan degrades gracefully (prefetch depth) but if LilServ is slow we can bump chunk size or move Kokoro to Tom's box later — proxy URL is one env var (`TTS_URL`), that's the whole point of the seam.
- **Image size / first pull:** kokoro CPU image + voices ≈ 1–2 GB download on LilServ; schedule Dave's deploy accordingly.
- **Voice registry volume mount (Task 0.1)** is optional cargo — drop it if `docker compose config` complains or image default list is fine.
- **PDF docs:** read-aloud rides extracted text (`previewData.text`) exactly like today; no change for scanned/image PDFs with no extractable text (button stays disabled as now).
- **Open question for Dave:** default voice — `af_heart` (Kokoro's flagship female) vs `am_adam` (male); trivial either way, it's a dropdown.
- **Explicitly out of scope v1:** streaming SSE from Kokoro, seek-by-sentence highlight, cross-chunk gapless audio (<50 ms gaps between chunks are fine for documents), per-word timestamps.
