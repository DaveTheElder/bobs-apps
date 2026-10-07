# Bob's Apps — Deploy State (as of 2026-09-03)

## TL;DR
Everything works. Caddy routes verified, network wiring durable (compose declares
`networks: [default, homelab]` + external `homelab` — survives recreates), upload-from-screen
live (`POST /api/docs/upload`), old library restored through it and truly indexed
(4 docs / 38 chunks). RAG answers grounded. No known open items.

## 2026-09-02 session findings (supersede parts of the 09-01 notes below)

1. **Caddy route fixed & verified.** Working config in source `/home/chimera/homelab/Caddyfile`,
   lines ~56/59: `reverse_proxy bobs-apps:8080` for both `/api/*` and `/docs/*`.
2. **The 09-01 "both containers on homelab bridge" claim was wrong.** `docker inspect` showed
   `homelab-bobs-apps` only on `bobs-apps-code_default`; Caddy on `homelab`. That's why both
   `bobs-apps` and `homelab-bobs-apps` gave no DNS from inside Caddy.
3. **Fix applied manually:** `docker network connect --alias bobs-apps homelab homelab-bobs-apps`.
   NOT durable across container recreation — compose file needs the `networks:` block below.
4. Editing lessons: `/etc/caddy/Caddyfile` is a single-file bind mount, read-only in-container;
   `sed -i` fails ("Resource busy"/"Read-only"). Edit host source through the inode (`cat >`).
   No `:2019` admin API → `docker restart homelab-caddy`, not `caddy reload`.
5. `/docs/` returning 404 is correct — backend only serves `/docs/:filename` (src/routes/docs.js).

### Durable network fix (apply to bobs-apps compose on LilServ, then recreate once)
```yaml
services:
  bobs-apps:
    networks: [homelab, default]
    # remove the ports: mapping? NO — keep it for loopback health checks
networks:
  homelab:
    external: true
```
Note: recreating drops the manual alias; recreate with this block instead of re-connecting.

## What's DONE (verified with real output)

| Piece | Status | Evidence |
|-------|--------|----------|
| Phase 1 — modular routes + doc repo fixes | ✅ pushed to `main` | commit `1ea3dc4`, 9/9 API tests green |
| Phase 2 — RAG pipeline (timeout, DOCX bug, inline-python) | ✅ proven end-to-end | cited answer from LM Studio in ~60s |
| Astro engine + first test suite | ✅ all green | `node tests/test_astro.js` passes |
| Frontend: single API client, pages-compatible build | ✅ builds clean | 260KB bundle, `/pages/bobs-apps/` base |
| SPA live at `/pages/bobs-apps/` | ✅ 200 + correct title | verified from .153 via curl |
| Backend container on LilServ | ✅ `Up (healthy)` | `docker compose ps` shows healthy, port 8090→8080 |
| Data migration (db + docs + chroma) | ✅ superseded 9/3 — restored via upload API | 3 old docs re-registered byte-exact through `/api/docs/upload` |

## Cleanup remaining


```bash
# Delete the one-time data migration branch from Forgejo (no longer needed):
git push origin :data-migration

# Remove the crash-looping old container if any remnants:
docker compose -f /home/chimera/homelab/bobs-apps-code/docker-compose.yml down  # only if you want to nuke it
```

## Key facts for next session

- **Repo:** `bob/bobs-apps` on Forgejo at `192.168.0.222/git/` (access via `/git/` prefix, not bare domain)
- **Local clone:** `/home/marvin/bobs-apps` (this box is .153)
- **Token:** in `~/.git-credentials` on this box; also embedded in DEPLOY.md line 30
- **LilServ manual:** `http://192.168.0.222/manual.html` — documents pages-deploy, Caddy setup, homelab layout
- **Pages deploy:** push to `pages` branch → auto-copies to `/home/chimera/homelab/sites/bobs-apps/` → served at `/pages/bobs-apps/`
- **Backend container name:** `homelab-bobs-apps`, image `lilserv/bobs-apps:latest`, port map `127.0.0.1:8090→8080/tcp`, network `homelab` (bridge d96433ec)
- **Caddy container name:** `homelab-caddy`, ports 80/443, same `homelab` network
- **LM Studio (RAG LLM):** `192.168.0.191:1234` — needs ~50s reasoning before first token; RAG timeout set to 240s in code
- **Data lives at:** `/home/chimera/homelab/bobs-apps-data/` on LilServ (mounted as `/data` in container)

## Approval workflow reminder (Dave's preference)

- Ask BEFORE firing commands that need approval popups
- Batch multiple commands into ONE terminal call with explanation paragraph
- Dave reviews at set times, not instantly; unavailable after ~9:30pm MDT
- `approvals.timeout` set to 1800s in config (takes effect next session)
