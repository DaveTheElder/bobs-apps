# Bob's Apps

A self-hosted suite of small daily-driver web apps running on one Node server
and one SQLite file. Built for a home lab, deployed with docker-compose, no
external services required.

![stack](https://img.shields.io/badge/Node-Express-green) ![db](https://img.shields.io/badge/DB-SQLite-blue) ![ui](https://img.shields.io/badge/UI-React%20%2B%20Vite-61dafb)

## The apps

| App | What it does |
|---|---|
| **Documents** | Upload/serve PDF & DOCX with inline preview (pdf.js), full-text blocks, read-aloud via local TTS |
| **Project Hub** | Lightweight project tracker: status, priority, progress, notes, linked resources |
| **Notes** | Server-backed sticky notes |
| **RAG** | Local retrieval-augmented chat over the document store (ChromaDB + sentence-transformers + any OpenAI-compatible local model) |
| **News Room** | Feed ingestion with local-LLM beat summarization |
| **Astro** | Natal charts, transits, synastry (pure ephemeris math via astronomy-engine) |
| **Slideshows** | Photo slideshows with server-rendered music tracks, ordering, captions |
| **Yard Map** | Survey maps: point capture with sequence ordering |
| **DB Admin** | Dev-only SQLite browser + SQL runner |
| **Utilities** | Calculator, unit converter, paint color picker, pomodoro timer |

## Architecture

```
src/server.js          thin bootstrap: env, logging, route mounting
src/routes/*.js        one module per route group (core/docs/rag/news/slideshows/…)
src/db.js              single DB connection + versioned migrations
rag/                   Python RAG pipeline (index, embed, query) driven via CLI
frontend/              React SPA (Vite); one component per app, registry-driven nav
tests/                 self-booting integration tests (temp DB, stub upstreams)
```

- **Backend**: Node + Express, SQLite (WAL). All state in one portable file.
- **Frontend**: Vite React SPA, built to `frontend/dist`, served by the same
  origin behind a reverse proxy or at a `/pages/<repo>/` subpath.
- **RAG**: Python sidecar invoked as a CLI (argv only — no shell-string
  escaping); embeddings via sentence-transformers, vectors in ChromaDB.
- **AI features** (RAG answers, news beats, read-aloud TTS) point at any
  OpenAI-compatible local model server via env vars — nothing leaves your
  network by default.

## Quick start

```bash
cp .env.example .env            # defaults work for local dev
npm install
npm run build                   # frontend -> frontend/dist
node server.js                  # http://localhost:8080
```

Or with Docker:

```bash
docker compose up
```

RAG features need the Python extras (see `Dockerfile` / `scripts/check_deps.py`).
Model endpoints are configured through `RAG_PROVIDERS` / `LM_STUDIO_URL` /
`BEAT_MODEL_URL` — see `src/routes/rag.js` header comments.

## Tests

Every test file boots the real server against a temp DB and stub upstreams —
no network, no fixtures to seed:

```bash
node tests/test_api.js
node tests/test_slideshows.js
node tests/test_tts.js
```

## Conventions

See [CONTRIBUTING.md](CONTRIBUTING.md) — file purpose headers, why-comments,
TOC blocks on long files, split-before-bloat. The rules there are the ones
this repo actually runs.

## License

MIT — see [LICENSE](LICENSE).
