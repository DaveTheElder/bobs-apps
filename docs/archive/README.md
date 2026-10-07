# Archive — historical planning docs

Plans for features that have since shipped (or, in one case, been explicitly
rejected). Kept for the "why is it built this way" archaeology; do not treat
anything here as current requirements — the code and CONTRIBUTING.md win.

| Doc | Shipped as | Status |
|---|---|---|
| `IMPROVEMENT_PLAN.md` | various (Aug 2026 sweep) | done/dead |
| `DOCUMENT_REPO_PLAN.md` | Documents app (`src/routes/docs.js`) | shipped |
| `rag-plan.md` | RAG pipeline (`rag/`, `src/routes/rag.js`) | shipped |
| `DB_ADMIN_PLAN.md` | DB admin panel (`/api/db/*`) | shipped |
| `DEPLOY_STATE.md` | — (superseded by bobs-apps-deploy skill + DEPLOY.md) | stale snapshot |
| `TTS_PLAN.md` | TTS routes (`src/routes/tts.js`) | shipped |
| `SLIDESHOW_PLAN.md` | Slideshow API (`src/routes/slideshows.js`) — still cited in code comments as the phase-1 spec | reference |
| `postgres-migration-plan.md` | nothing — plan argued itself out of existing; SQLite stays | rejected on purpose |
