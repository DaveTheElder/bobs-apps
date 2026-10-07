# Document Repository App — Plan

## Overview

A document repository app for Bob's Apps where Hermes can store, browse, view, and download documents/reports it creates. Documents are stored on disk with metadata in SQLite, served via Express, and managed through a React UI component.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Frontend (React SPA)                       │
│  ┌───────────────────────────────────────┐  │
│  │  DocumentRepository.jsx               │  │
│  │  - Browse grid/list                   │  │
│  │  - Search/filter                      │  │
│  │  - Preview (PDF/DOCX text)            │  │
│  │  - Download                           │  │
│  └───────────────────────────────────────┘  │
├─────────────────────────────────────────────┤
│  Backend (Express, port 8080)               │
│  ┌───────────────────────────────────────┐  │
│  │  API Routes:                          │  │
│  │  GET    /api/docs          - list      │  │
│  │  POST   /api/docs        - create      │  │
│  │  GET    /api/docs/:id      - metadata  │  │
│  │  DELETE /api/docs/:id      - delete    │  │
│  │  GET    /api/docs/:id/preview - text   │  │
│  │  GET    /docs/:filename  - download    │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  Storage:                                   │
│  ├── bobs-apps.db (SQLite metadata)         │  │
│  └── documents/   (PDF/DOCX files on disk)  │  │
└─────────────────────────────────────────────┘
```

---

## Database Schema

Add to `server.js` initDB():

```sql
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    filename TEXT NOT NULL UNIQUE,
    file_type TEXT NOT NULL CHECK(file_type IN ('pdf', 'docx')),
    file_size INTEGER DEFAULT 0,
    category TEXT DEFAULT 'general',
    tags TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_docs_category ON documents(category);
CREATE INDEX IF NOT EXISTS idx_docs_created ON documents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_docs_tags ON documents(tags);

-- Trigger for updated_at (same pattern as projects table)
CREATE TRIGGER IF NOT EXISTS update_documents_timestamp 
    AFTER UPDATE ON documents
    BEGIN
        UPDATE documents SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;
```

---

## File Storage

- Directory: `/root/bobs-apps/documents/` (created on server start)
- Files stored as: `{id}.{ext}` (e.g., `a1b2c3d4.pdf`)
- Serve via Express static route at `/docs/:filename`
- No CDN needed — served directly from Express

---

## API Endpoints

### GET /api/docs
List all documents with optional filters.

**Query params:**
- `category` — filter by category (e.g., "report", "analysis", "summary")
- `search` — search title, description, tags
- `sort` — "newest" | "oldest" | "name" (default: newest)

**Response:** Array of document metadata objects.

### POST /api/docs
Create a new document entry and upload file.

**Body (multipart):**
- `title` (required)
- `description` (optional)
- `file_type` — "pdf" or "docx"
- `category` (default: "general")
- `tags` (comma-separated, optional)
- `file` — the actual file

**Response:** Created document object with id and filename.

### GET /api/docs/:id
Get metadata for a single document.

### DELETE /api/docs/:id
Delete a document (removes from DB and disk).

### GET /api/docs/:id/preview
Extract and return text content for preview in the browser.

- For PDFs: use pymupdf to extract text
- For DOCX: use python-docx to extract text
- Returns `{ title, text, page_count }`

### GET /docs/:filename
Serve/download the actual file. Uses Express `res.download()`.

---

## React Component (DocumentRepository.jsx)

Located at: `/root/bobs-apps/frontend/src/apps/DocumentRepository.jsx`

**UI Layout:**

1. **Header bar** — "📄 Documents" title, search input, category filter dropdown
2. **Stats row** — total documents, total size, categories breakdown
3. **Document grid** — cards showing:
   - Document icon (📄 for PDF, 📝 for DOCX)
   - Title and description (truncated)
   - Category badge
   - File size and date
   - Tags as small pills
   - Preview button → opens modal with extracted text
   - Download button → triggers file download
4. **Empty state** — when no documents exist, show message: "No documents yet. Ask Hermes to create a report and it will be stored here."

**Interactions:**
- Clicking preview opens an overlay/modal showing the document's extracted text content (scrollable)
- Download button calls `/docs/:filename` directly
- Search filters in real-time (client-side from loaded list)
- Category filter dropdown with auto-detected categories
- Delete with confirmation

**Design:** Light theme, consistent with existing Bob's Apps aesthetic. Cards with subtle shadows, rounded corners.

---

## Hermes Integration — How Hermes Creates & References Documents

### Creating Documents

When the user asks Hermes to create a document (report, analysis, summary), Hermes:

1. Generates the content using its skills (`pdf_create.py`, `docx_create.py`)
2. Saves the file to `/root/bobs-apps/documents/` with a UUID filename
3. Registers it in the database via `POST /api/docs`
4. Returns metadata to the user including: title, category, download link

**Example workflow:**
```
User: "Write a market analysis report on AI startups and save it"
Hermes: 
  1. Creates report.pdf using pdf_create.py
  2. POST /api/docs with {title: "AI Startup Market Analysis", file_type: "pdf", category: "report"}
  3. Returns: "Created document: [link to preview/download]"
```

### Referencing Documents in Responses

Hermes can reference stored documents by ID or title in chat responses. The system supports:

1. **Direct links** — Hermes includes `/docs/:filename` URLs in responses for download
2. **Preview snippets** — Hermes calls `GET /api/docs/:id/preview` to show excerpts inline
3. **Document search** — User can ask "what reports do you have?" and Hermes queries the API

### Automatic Document Registration (Optional Enhancement)

A cron job or file watcher could:
- Monitor `/root/bobs-apps/documents/` for new files
- Auto-register them in the database with metadata extracted from filename/content
- This catches documents created outside the UI

---

## Implementation Steps

### Phase 1: Backend (server.js changes)
1. Add `documents` table schema to `initDB()`
2. Create `/root/bobs-apps/documents/` directory on startup
3. Implement all API endpoints (`/api/docs/*`, `/docs/:filename`)
4. Add file upload handling (use `multer` or manual stream parsing)
5. Add text extraction for preview (pymupdf + python-docx)

### Phase 2: Frontend Component
1. Create `DocumentRepository.jsx` in `frontend/src/apps/`
2. Implement browse grid, search, category filter
3. Implement preview modal with extracted text
4. Implement download and delete actions
5. Style to match Bob's Apps theme

### Phase 3: Register App & Build
1. Add document-repo entry to default apps in `server.js` initDB()
2. Rebuild frontend (`npm run build`)
3. Restart server

### Phase 4: Hermes Workflow Integration
1. Create a helper script or function for "create and register" documents
2. Document the pattern so Hermes follows it when generating reports
3. Test end-to-end: create doc → browse → preview → download

---

## Dependencies to Install

```bash
pip install pymupdf python-docx  # Already installed via pdf/docx skills
npm install multer               # For file upload handling in Express
```

Check if `multer` is already available; if not, add it.

---

## File Structure After Implementation

```
/root/bobs-apps/
├── documents/                    ← New: stored PDF/DOCX files
│   ├── a1b2c3d4-e5f6-7890.pdf
│   └── ...
├── server.js                     ← Modified: new routes + schema
├── frontend/src/apps/
│   └── DocumentRepository.jsx    ← New: React component
├── bobs-apps.db                  ← Modified: new documents table
└── package.json                  ← May need multer added
```

---

## Future Enhancements (Not Phase 1)

- **Upload via UI** — drag-and-drop file upload in the React app
- **Versioning** — track document revisions, keep history
- **Categories management** — CRUD categories from UI
- **Full-text search** — index extracted text for better search
- **Embedding** — render PDFs inline using browser's built-in viewer (`<embed src="/docs/file.pdf">`)
- **Sharing** — generate public links with expiration
- **Tags system** — separate tags table instead of comma-separated string
- **Document analytics** — view/download counts, most accessed docs

---

## Notes & Decisions

1. **Why SQLite + disk files vs. storing BLOBs in DB?** 
   - Disk storage is simpler for file serving and preview extraction
   - Easier for Hermes to write directly to the filesystem
   - File size won't bloat the database
   - Can be backed up independently if needed

2. **Why not store in localStorage?**
   - Consistent with user preference (SQLite over localStorage)
   - Documents persist across sessions and devices (via server)
   - Supports binary files (PDF/DOCX), not just text

3. **Preview approach:** Extract text via pymupdf/python-docx rather than embedding PDF viewers. This keeps the UI lightweight and works for both PDF and DOCX uniformly.

4. **File naming:** UUID-based filenames prevent collisions and don't expose original names. Original filename stored in DB metadata.

5. **Security:** Basic — filename sanitization, path traversal protection on `/docs/:filename`, optional auth could be added later.
