# bobs-apps → PostgreSQL migration plan (LilServ)

Date: 2026-09-05 · Status: v1 final · Repo: `/home/marvin/bobs-apps` (main @ `630a93f`) · Deploy target: LilServ 192.168.0.222, compose project `/home/chimera/homelab/bobs-apps-code`, data dir `/home/chimera/homelab/bobs-apps-data` (mounted at `/data`)

---

## 1. Goals & non-goals — and the honest case against this

**Goals:** standalone Postgres container as bobs-apps' primary store; SQLite retired (kept warm N days for rollback); backups become a dump-and-cron job instead of "hope nobody opens the WAL wrong".

**Non-goals:** no ChromaDB move (embeddings live in `rag/` + `/data/chromadb_data` — they work, and pgvector is *someday*, not today), no HA/multi-node, **no Caddy route for Postgres**, no cloud.

**Case FOR Postgres here:** real concurrency (the RAG writer + API readers + a future scheduler all hitting one file); typed columns instead of "INTEGER that may contain anything"; genuine FK constraints; `pg_dump` is a boring, proven backup story; and the boot-time migrator pattern that just crashed your container twice (`initDB()` running raw SQLite DDL at startup) gets replaced by explicit versioned migrations that can fail *without bricking startup*.

**Case AGAINST:** you are one operator with one app and one writer-heavy workload — SQLite WAL handles this fine today, and the current incident history is about *my* migration bugs, not SQLite's limits. PG adds a service to babysit, an env-file secret to guard, and its own failure modes (volume perms, auth host rules, tuning for 127.0.0.1 vs container DNS).

**Verdict:** worth doing only if you want the two operational wins above (real FKs + non-booting migrator + pg_dump discipline). If this plan is executed for tidiness alone, roll it back inside the rollback window and admit nothing; SQLite was fine.

---

## 2. Postgres container

Image `postgres:17-alpine`. Service added to bobs-apps' compose (same project → default network carries app→db traffic; also join `homelab` **only** if another homelab container will ever need queries — otherwise keep it off that net). PG must **never** get a Caddy route and binds no host port at all: reachable only by container DNS name on the compose network.

```yaml
services:
  bobs-apps-db:
    image: postgres:17-alpine
    container_name: homelab-bobs-apps-db
    restart: unless-stopped
    # NO ports: section at all — internal-only by omission.
    environment:
      POSTGRES_DB: bobsapps
      POSTGRES_USER: bobsapps
      POSTGRES_PASSWORD_FILE: /run/secrets/pgpass   # or env_file below
    env_file:
      - /home/chimera/homelab/bobs-apps-data/pg.env  # untracked; contains POSTGRES_PASSWORD=*** mode 600>
    volumes:
      - /home/chimera/homelab/bobs-apps-data/pgdata:/var/lib/postgresql/data   # host path matches existing style, absolute on purpose
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U bobsapps -d bobsapps"]
      interval: 15s
      timeout: 5s
      retries: 4
```

If you keep the deployed compose's explicit `networks:` convention (`default` + external `homelab` — omitting it broke `/api` twice), declare the same for `bobs-apps-db` **except** skip `homelab`; internal-only is a feature. App gets `DATABASE_URL: postgres://bobsapps:***@bobs-apps-db:5432/bobsapps?schema=public` as env (from the same untracked pg.env, no secrets in compose).

App depends_on ordering: add to bobs-apps service `depends_on: { bobs-apps-db: { condition: service_healthy } }`.

**Backups:** nightly cron on LilServ (host crontab is fine):
```bash
docker exec homelab-bobs-apps-db pg_dump -U bobsapps -d bobsapps --format=custom \
  > /home/chimera/homelab/bobs-apps-data/backups/bobsapps-$(date +\%F).dump && \
  find /home/chimera/homelab/bobs-apps-data/backups -name '*.dump' -mtime +14 -delete
```
**A backup you haven't restored is a rumor.** Before cutover, run one `pg_restore --create` into a scratch DB and count rows.

---

## 3. Schema translation (SQLite → PG)

Current tables (`src/db.js`, all TEXT ids, no types beyond INTEGER hints):

| SQLite | Postgres DDL | Notes |
|---|---|---|
| `documents(id TEXT PK, title, filename, mime_type, size_bytes INTEGER, uploaded_at TEXT DEFAULT (datetime('now')))` | `id TEXT PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT, size_bytes BIGINT, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()` | datetime→TIMESTAMPTZ; app currently stores ISO strings from JS anyway — verify column type matches what route writes |
| `rag_queries(id TEXT PK, query, answer, created_at TEXT default)` | same shape, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, add `session_id` FK if you keep this table (it predates sessions; candidate for deletion — decide in §9 checklist) |
| `app_registry(name TEXT PK, description, category, version, enabled INTEGER, updated_at)` | `enabled BOOLEAN` — **not** INTEGER; PG rejects truthiness comparisons on ints |
| `rag_sessions(id TEXT PK, title, created_at, updated_at)` + trigger bumping `updated_at` after message insert | same columns TIMESTAMPTZ; keep the UPDATE-on-insert as a Postgres trigger OR (simpler) do it in the app's transaction — trigger fidelity is optional, pick one and write down which |
| `rag_messages(id TEXT PK, session_id NOT NULL DEFAULT 'legacy' REFERENCES rag_sessions(id), question, answer, sources_json TEXT, created_at)` + `idx_rag_messages_session` | add real `REFERENCES rag_sessions(id) ON DELETE CASCADE`, index on `session_id`. **Decision:** with CASCADE live, delete the app's two-step explicit delete in `routes/rag.js` — but do it in the SAME PR so there is no window of "no FK and no manual cleanup". `sources_json` stays TEXT (JSONB tempts; current code does JSON.parse on read — leave as TEXT this migration, revisit never) |

Dialect landmines found by grep (`datetime('now')`, `INSERT OR …`, `LIKE` case-folding, INTEGER-as-bool): 11 hits across `db.js`, `core.js`, `docs.js`, `rag.js`. All die in §4's rewrite; the two triggers and partial-index habits get PG equivalents above.

---

## 4. Code migration — pick (b): thin adapter over `pg`

Options: **(a)** promise-rewrite all ~1,065 route LOC to `await pool.query()`. Correct end state, biggest diff, every test fixture re-plumbed at once. **(c)** Kysely/query builder: nice types, but this app's SQL is already hand-written and small; new dependency + rewrite = two rewrites in a trench coat.

**(b) wins:** keep the `get/all/run` callback surface (or its promise twin) exported from `src/db.js`, backed by one lazy `pg.Pool`. Routes keep working with near-zero diff while you migrate them opportunistically, file by file, over days — each converted route is independently testable and revertible. Concretely:

```js
// src/pg-adapter.js (new) — same verbs the routes already call.
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
function all(sql, params, cb)  { pool.query(sql, params).then(r => cb(null, r.rows), e => cb(e)); }
function get(sql, params, cb)  { all(sql, params, (e, rows) => cb(e, rows && rows[0])); }
function run(sql, params, cb)  { pool.query(sql, params).then(r => cb(null, { changes: r.rowCount }), e => cb(e)); }
```
SQLite→PG SQL rewrites still happen per-route (placeholders `?` → `$n`, `datetime('now')` → `now()`), but adapter-shipped routes get a tiny shim that converts `?` to `$n`. Ship the adapter behind `DB_BACKEND=pg|sqlite` env **for the migration window only** (see §6 kill condition); sqlite path deleted once PG survives one week.

---

## 5. One-shot data migration script + verification

`tools/migrate-sqlite-to-pg.js` — reads `/data/bobs-apps.db` via `sqlite3`, writes PG, transaction-per-table in FK order (`rag_sessions` → `rag_messages` → `documents` → rest), preserves ids/created_at verbatim (parse TEXT timestamps into TIMESTAMPTZ literals; do NOT let the target default to now()):

```js
await pgClient.query('BEGIN');
const rows = await readAll(sqliteDb, 'SELECT * FROM rag_sessions ORDER BY created_at');
for (const r of rows) await pgClient.query(INSERT_SESSIONS_PARAMS, [r.id, r.title, ts(r.created_at), ts(r.updated_at)]);
await pgClient.query('COMMIT');   // repeat per table; abort everything on any error
```

Verification checklist (script prints each line): row counts equal per table · `SELECT sum(length(sources_json))` matches and every value re-parses as JSON array in PG (`WHERE NOT jsonb_typeof(try_cast...)` sanity via a JS-side pass) · min/max of timestamps match · orphan check: `rag_messages.session_id` with no parent = 0.

---

## 6. Cutover + rollback

Freeze window (nobody else uses this; 5 minutes): stop bobs-apps → run migration script → smoke test (§8) → start on PG → watch logs 10 min. **Rollback:** `DB_BACKEND=sqlite` env flip — but that's a one-way door: writes land in PG while SQLite sits stale, so rollback = restore the `.dump` or copy fresh rows back before flipping. Keep `/data/bobs-apps.db` (and its `-wal/-shm`) untouched for **7 days** after cutover; delete by hand thereafter.

Dual-mode `DB_BACKEND` flag has a kill condition: removed no later than one week post-cutover, in the same PR that deletes `test_migrations.js`'s v1 fixture (its reason to exist dies with SQLite). Flagless is better long-term but makes day-one rollback require an image retag; for a homelab you get exactly one week of the flag and not one more.

---

## 7. Test strategy post-move

- `tests/test_api.js` boots the app on PORT 8091 with `DB_PATH` tmpfile → gains a parallel mode: `DATABASE_URL=...` pointing at a throwaway PG (container started by CI or a local `docker run` before the script; reset via `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`). Keep SQLite mode running until the flag dies (§6).
- `tests/test_migrations.js` (the v1→v2 upgrade-path test born this week) becomes **dead weight on PG** — its whole premise is boot-time ALTERs. Its successor: a migrator with applied-version tracking (`migration(text name PRIMARY KEY, applied_at timestamptz default now())`) + `tools/migrate.js` that applies pending `.sql` files in order; test asserts "two consecutive runs = idempotent" and "a broken migration exits non-zero WITHOUT touching server startup". That's the class of failure that got you twice this week — don't lose it with SQLite.
- Seed helpers currently using `node:sqlite DatabaseSync` move to plain SQL files replayed into PG.

---

## 8. Runbook (copy-paste, Dave, on LilServ)

```bash
# 0) pull the migration branch/commit, review compose diff first
cd /home/chimera/homelab/bobs-apps-code && git fetch && git log --oneline origin/main -1
# 1) secrets (once): write pg.env mode 600 with POSTGRES_PASSWORD=<strong>, DATABASE_URL=... matching it
#    then copy compose additions (bobs-apps-db service + env/depends_on on app side) into the deployed compose.yml; diff them.
chmod 600 /home/chimera/homelab/bobs-apps-data/pg.env

docker compose up -d bobs-apps-db
until docker exec homelab-bobs-apps-db pg_isready -U bobsapps -d bobsapps; do sleep 2; done   # wait, don't guess

# 2) backup BEFORE touching anything (covers the migration itself):
docker exec homelab-bobs-apps pkill -f node || true   # freeze writes: stop app cleanly instead if you prefer `docker compose stop bobs-apps`
cp /home/chimera/homelab/bobs-apps-data/bobs-apps.db{,-pre-pg-$(date +%F)}

# 3) run migration from inside the app container (it has both DB mounts):
docker compose exec bobs-apps node tools/migrate-sqlite-to-pg.js
# prints per-table row counts + verification lines — all must match or STOP (see sideways)

# 4) flip + smoke:
docker compose up -d --build bobs-apps
curl -sf http://192.168.0.222/api/rag/sessions | head -c 300   # expect your "Older history" + recent sessions listed
curl -sf http://192.168.0.222/api/apps >/dev/null && echo apps-ok
docker compose exec bobs-apps-db psql -U bobsapps -d bobsapps -c 'select count(*) from rag_messages;'

# sideways:
#  • app can't resolve `bobs-apps-db`: same compose project? network spelling? (homelab convention applies here)
#  • auth failed / password mismatch: pg.env edited after first init — PG stores the original in pgdata; fix = docker compose down bobs-apps-db && rm -rf .../pgdata/* && up again, re-run §5 from the still-warm SQLite copy (PG empty = free reset)
#  • migration script aborts mid-table: transaction-per-table means nothing is half-written on PG; rerun after fixing rows — safe because inserts are keyed by preserved TEXT ids (rerunnable with ON conflict do update)
#  • pgdata dir root-owned after mount weirdness: chown -R 999:.../pgdata (alpine postgres uid), then up again
```

---

## 9. Ordered checklist

1. `git checkout -b feat/pg-migration` in repo; add `pg` dep, write §3 PG DDL as `migrations/0001_init.sql`.
2. `src/pg-adapter.js` + `DB_BACKEND=pg|sqlite` env switch (§4), `?`→`$n` shim for un-migrated routes.
3. `tools/migrate-sqlite-to-pg.js` with §5 verification output, dry-run by default (`--execute` to write).
4. Migrate routes file-by-file: `core.js`, `docs.js`, `rag.js`; per-file delete the shim usage; keep SQLite branch compiling until §6 done (kill condition set for one week post-cutover).
5. Tests: PG-mode for `test_api.js` (throwaway container), migrator tests replace `test_migrations.js` premise (§7).
6. Compose additions per §2 + pg.env; backup cron line added to LilServ crontab **before** cutover, not after.
7. Runbook end-to-end on real data during a freeze window; verify counts/JSON/FK lines all green before declaring victory.
8. One week later: delete `DB_BACKEND` branch, `initDB()` SQLite path, legacy fixture tests. Boring PR titled "SQLite is dead".

**Top 3 risks:** (1) migration ordering bugs — the failure that bricked your container twice this week; mitigated by explicit versioned migrations + idempotency test (§7), not the old boot-time statement list. (2) pg.env secret handling: env file with a live password inside a data dir backed up nightly = secrets in every backup copy; acceptable for homelab, say it out loud rather than pretend. (3) rollback drift: writes land in PG while stale SQLite tempts you back — rollback only safe by dump/restore (§6), so rehearse the restore drill once before cutover or don't claim a rollback plan exists.
