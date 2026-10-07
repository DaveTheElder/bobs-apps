# Deploying Bob's Apps on LilServ

Status: SPA + backend code are ready and tested. Two things remain, both done **on LilServ** as user `chimera` (no SSH from other LAN boxes right now — port 22 is closed to them).

## What ships where

| Piece | Where it lives | How it gets there |
|---|---|---|
| SPA (static) | `/home/chimera/homelab/sites/bobs-apps/` | **Automatic** on `git push origin pages` — the pages-deploy service copies the branch. Already wired in LilServ's stack, nothing to configure. |
| Backend API | Docker container `homelab-bobs-apps`, loopback :8090 → Caddy `/api/` | Manual: copy repo dir + one compose include + one Caddyfile route (below). ~5 min. |

## 1) Publish the SPA (no server access needed — do this first, from any LAN box with a clone)

```bash
cd bobs-apps          # local clone of bob/bobs-apps
git fetch origin pages --force 2>/dev/null || true   # drop old published copy if it exists locally
git push origin pages # LilServ's pages-deploy picks this up within seconds
```

Then check from another device: `http://192.168.0.222/pages/bobs-apps/` should show the app shell. The Document Repo / RAG panels won't work yet (no API) — that's expected until step 3.

## 2) Backend container on LilServ

```bash
# as chimera, on LilServ
cd /home/chimera/homelab
mkdir -p bobs-apps-data/docs bobs-apps-data/chromadb_data

# bring the code — NEVER paste a token into the URL (it lands in .git/config and
# any log). Create a read-only Forgejo token, then:
git clone http://bob@192.168.0.222/git/bob/bobs-apps.git bobs-apps-code \
  # prompted for password → paste the token once; or cp -r /path/to/clone bobs-apps-code

# one-time data migration from the .153 box (the live DB + docs + chroma):
scp marvin@192.168.0.153:/home/marvin/bobs-apps/bobs-apps.db        bobs-apps-data/
scp -r marvin@192.168.0.153:/home/marvin/bobs-apps/documents/*      bobs-apps-data/docs/
scp -r marvin@192.168.0.153:/home/marvin/bobs-apps/chromadb_data/*  bobs-apps-data/chromadb_data/

# build + start (uses the compose file in the repo)
cd bobs-apps-code
docker compose -f docker-compose.yml up -d --build
docker compose -f docker-compose.yml logs -f   # first boot downloads MiniLM (~90MB), watch it finish
```

## 2b) Kokoro TTS (document read-aloud voice)

`docker-compose.yml` now defines a `kokoro` service. One-time bring-up on LilServ — the image is ~3.6 GB (models baked in), schedule accordingly:

```bash
cd /home/chimera/homelab/bobs-apps-code && git pull --ff-only
docker compose -f docker-compose.yml config   # sanity: kokoro + homelab network parse
docker compose -f docker-compose.yml up -d kokoro bobs-apps
```

No Caddy route and no published ports — Kokoro is reachable only from containers on the `homelab` network; the SPA hits it via `/api/tts/*` on bobs-apps, which also caches mp3s under `bobs-apps-data/tts-cache/`.

Verify (each from LilServ shell):
```bash
docker compose -f docker-compose.yml ps kokoro            # healthy after ~60s warmup
curl -s http://127.0.0.1:8090/api/tts/voices              # → {"voices":[{"id":"af_heart"},...]}
curl -s -X POST http://127.0.0.1:8090/api/tts/synth -H 'Content-Type: application/json' \
  -d '{"text":"Hello from Kokoro.","voice":"af_heart"}' --output /tmp/t.mp3 && ls -la /tmp/t.mp3
```

If read-aloud silently shows a "browser voice" badge in the preview header, kokoro is down — check `docker ps` for `homelab-kokoro`. Pointing at an engine elsewhere (e.g. Tom): set `TTS_URL` on the bobs-apps service; nothing else changes.

### Status parked 2026-09-22 evening (resume here tomorrow)

Done: code + SPA pushed (`main` @ ghcr-fix, `pages` bundle `index-D8PqVlWh.js`); compose kokoro image corrected to `ghcr.io/remsky/kokoro-fastapi-cpu`.
NOT done — remaining steps, in order:
1. LilServ: `cd /home/chimera/homelab/bobs-apps-code && git pull --ff-only` then `docker compose -f docker-compose.yml up -d --build bobs-apps kokoro` (~3.6 GB pull; --build also bakes the new TTS router into bobs-apps — old container 404s /api/tts/*).
2. Verify: `curl -s http://127.0.0.1:8090/api/tts/voices` → voice list JSON. If 503: `docker logs homelab-kokoro --tail 20`. Note: image may lack curl → healthcheck can lie "unhealthy" while the app serves fine; trust the voices curl over `ps`.
3. Confirm pages-deploy hook actually published the new bundle (`curl http://192.168.0.222/pages/bobs-apps/` should reference `index-D8PqVlWh.js`; last check still served old `DBM6iKfg`).
4. Then browser test: open a doc preview → 🔊 Read Aloud; voice + speed pickers, chunk progress, fallback badge when kokoro is stopped.
Unrelated loose end from same evening: Jerry (.191) LM Server /v1/models responds but chat completion hung >180s — likely swap/offload stall (suspect the `gemma4@?` garbage-quant entry); poke Tom .247 next time or confirm resident model in LM Studio UI.

## 3) Caddy route — add to `/home/chimera/homelab/Caddyfile` (inside the existing site block, before or after the `/pages` handler):

```caddy
handle /api/* {
    reverse_proxy 127.0.0.1:8090
}
handle /docs/* {
    reverse_proxy 127.0.0.1:8090
}
```

Then `docker compose restart caddy` (or whatever the Caddy service is named in that stack).

## 4) Verify from another LAN device (not LilServ itself — proves routing + CORS-free behavior):

- [ ] `http://192.168.0.222/pages/bobs-apps/` loads, app grid renders
- [ ] Document Repo shows the 3 migrated documents; preview on *Numerology* returns structured blocks
- [ ] RAG: ask "what does the guide say about chunking?" → cited answer (first call is slow — model load)
- [ ] Astro: generate a chart for 1990-06-21 12:00 UTC — Sun should be ~90°
- [ ] `curl http://192.168.0.222/api/rag/status` → JSON with chunk counts

## Rollback (if it ever needs to go away)

```bash
docker compose -f bobs-apps-code/docker-compose.yml down     # container + port
rm -rf /home/chimera/homelab/sites/bobs-apps                 # SPA
git push origin :pages                                        # kill the pages branch (optional)
# data survives in bobs-apps-data/ until you delete it
```

## Why this layout

- **Static on `/pages`, API on `/api`** — matches LilServ's existing architecture (Caddy + Forgejo + pages-deploy). No new public ports beyond what Caddy already owns; the container is loopback-only.
- **One volume, three things** (`docs/`, `bobs-apps.db`, `chromadb_data/`) — all state in one place, easy to back up with the existing homelab tar recipe in the manual (add `bobs-apps-data` to it).
- **CORS is a non-issue** — same host, different path. The SPA's API client (`frontend/src/api.js`) detects `/pages/*` at runtime and points at `http://<host>/api`; standalone mode on :8090 keeps working too because the fallback is relative `/api`.
