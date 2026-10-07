# RAG Implementation Plan — Bob's Apps Document Repository

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  Frontend (React)                                    │
│  ┌───────────────────────────────────────────────┐  │
│  │  DocumentRAG.jsx                               │  │
│  │  - Chat interface for asking questions         │  │
│  │  - Source citations from retrieved documents   │  │
│  │  - "Ask about my docs" entry point            │  │
│  └───────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────┤
│  Backend (Express, same port)                        │
│                                                      │
│  RAG Pipeline:                                       │
│  ┌──────────┐   ┌──────────┐   ┌──────────────┐    │
│  │ Extract  │→  │ Chunk &  │→  │ Embed &      │    │
│  │ text     │   │ Index    │   │ Store in     │    │
│  │ (pymupdf │   │ (500tok, │   │ ChromaDB     │    │
│  │ /docx)   │   │ 100ovlp) │   │              │    │
│  └──────────┘   └──────────┘   └──────┬───────┘    │
│                                       │             │
│  Query Pipeline:                       │             │
│  ┌──────────┐   ┌──────────┐   ┌──────▼───────┐    │
│  │ Embed    │←  │ Retrieve │←  │ LLM Generate │    │
│  │ query    │   │ top-k    │   │ with context │    │
│  │ (singleton)│ │ (k=5)    │   │ + citations  │    │
│  └──────────┘   └──────────┘   └──────────────┘    │
│                                                      │
│  Storage:                                            │
│  ├── SQLite (doc metadata, indexing status, queries) │
│  ├── ChromaDB persistent dir (vector embeddings)     │
│  └── Disk directory (source files)                   │
└─────────────────────────────────────────────────────┘
```

## Phase 1: Install Dependencies (~5 min)

**Python packages:**
- `sentence-transformers` — lightweight embedding model (~250MB, all-MiniLM-L6-v2)
- `chromadb` — embedded vector database with persistent storage (~50MB)
- `tiktoken` — accurate token counting for chunk sizing (critical fix: 500 tokens ≠ 500 words)

**Node packages:** None needed (uses existing React setup)

## Phase 2: Backend RAG Engine (~45 min)

### File Structure
```
rag/
├── __init__.py
├── engine.py        # Indexing pipeline + model singleton
├── query.py         # Query pipeline + LLM generation
└── chunker.py       # Text splitting utilities
```

### 2a. `rag/engine.py` — Core indexing pipeline

**Model singleton (P1 fix):** Load embedding model once at server startup, keep in memory:
```python
# rag/engine.py
from sentence_transformers import SentenceTransformer
import chromadb
import os

# Singleton — loaded once when module imports
_model = None
_chroma_client = None

def get_model():
    global _model
    if _model is None:
        print("[RAG] Loading embedding model (first time, ~5-10s)...")
        _model = SentenceTransformer('all-MiniLM-L6-v2')
        print("[RAG] Model loaded.")
    return _model

def get_chroma_client():
    global _chroma_client
    if _chroma_client is None:
        # P1 fix: persistent path, not ephemeral in-memory
        persist_dir = os.path.join(os.path.dirname(__file__), '..', 'chromadb_data')
        os.makedirs(persist_dir, exist_ok=True)
        _chroma_client = chromadb.PersistentClient(path=persist_dir)
    return _chroma_client

def get_or_create_collection():
    """Get existing collection or create new one. Handles restarts."""
    client = get_chroma_client()
    try:
        return client.get_collection("document_chunks")
    except Exception:
        return client.create_collection("document_chunks")
```

**Indexing function:**
- Scan documents table for `indexed=0` or `chunk_count=0`
- Extract text using existing pymupdf/python-docx preview logic
- Chunk text into 500-token segments with 100-token overlap (skip empty chunks)
- Generate embeddings via singleton model instance
- Store in ChromaDB collection named `document_chunks` with metadata: doc_id, title, filename, file_type, page_number, chunk_index, total_chunks
- Update SQLite to mark docs as indexed with chunk_count

**Error handling:**
- Corrupted PDF / no text layer → log warning, skip document, set `indexed=1` (no chunks)
- Scanned images without OCR → same treatment
- Empty chunks after splitting → skip silently
- ChromaDB write failure → rollback SQLite update, leave doc as unindexed

**Transaction-based error recovery:**
```python
conn.execute("BEGIN TRANSACTION")
try:
    chunk_count = index_document(...)
    conn.execute("UPDATE documents SET indexed=1, chunk_count=? WHERE id=?", (chunk_count, doc_id))
    conn.commit()
except Exception as e:
    conn.rollback()  # Doc stays unindexed, can retry later
```

### 2b. `rag/query.py` — Query pipeline + LLM generation

**Query function:**
1. Embed the user's question using the **same singleton model instance** (critical for vector comparability)
2. Search ChromaDB for top-k (k=5) most similar chunks
3. Return chunks with document source metadata for citation
4. Format context into LLM prompt:

```python
def build_llm_prompt(question, chunks):
    """Build structured prompt with explicit [DOC-N] citations."""
    
    # Build context with explicit source labels
    context_parts = []
    for i, chunk in enumerate(chunks):
        meta = chunk["metadata"]
        label = f"[DOC-{i+1}: {meta['title']} ({meta['filename']}, chunk {meta['chunk_index']+1}/{meta['total_chunks']})]"
        if meta.get('page_number'):
            label += f", page {meta['page_number']}"
        context_parts.append(f"{label}\n{chunk['text']}")
    
    context_text = "\n\n".join(context_parts)
    
    system_prompt = """You are a research assistant answering questions using ONLY the provided document snippets. 
Follow these rules:
1. Answer ONLY using the retrieved context. Do not use outside knowledge.
2. If the answer is not in the context, say "I couldn't find information about this in your documents."
3. Cite sources as [DOC-N] at the end of each sentence or claim.
4. Be concise but complete."""
    
    user_prompt = f"""Retrieved context:

{context_text}

Question: {question}

Please answer using the retrieved context and cite your sources with [DOC-N] labels."""
    
    return system_prompt, user_prompt
```

5. Send prompt + context to LM Studio via OpenAI-compatible API (same endpoint as current model)
6. Return both the LLM response and source citations

**Error handling:**
- No chunks found → return "No documents indexed yet" message
- ChromaDB query fails → fall back to SQLite full-text search on doc titles/descriptions
- LLM generation fails → return raw retrieved context without answer

### 2c. `rag/chunker.py` — Text splitting utilities (token-accurate)

```python
import tiktoken

# Use cl100k_base encoding (same as GPT-4)
ENCODING = tiktoken.get_encoding("cl100k_base")

def chunk_text(text: str, chunk_size: int = 500, overlap: int = 100) -> list[dict]:
    """Split text into overlapping chunks by TOKEN count, not word count."""
    if not text or len(text.strip()) == 0:
        return []
    
    # Tokenize the entire text
    tokens = ENCODING.encode(text)
    if len(tokens) <= chunk_size:
        return [{"text": text, "chunk_index": 0, "total_chunks": 1}]
    
    chunks = []
    start = 0
    total_chunks = (len(tokens) - overlap) // (chunk_size - overlap) + 1
    
    while start < len(tokens):
        end = min(start + chunk_size, len(tokens))
        chunk_tokens = tokens[start:end]
        chunk_text = ENCODING.decode(chunk_tokens)
        
        if chunk_text.strip():
            chunks.append({
                "text": chunk_text,
                "chunk_index": len(chunks),
                "total_chunks": total_chunks
            })
        start += (chunk_size - overlap)
    
    return chunks
```

### 2d. API Routes (in server.js)

| Route | Method | Description |
|-------|--------|-------------|
| `/api/rag/index` | POST | Trigger indexing of all/unindexed docs. Returns `{ status: "started" }`. Indexing runs synchronously (blocking) since it's a one-time setup operation. |
| `/api/rag/status` | GET | Check indexing stats: total docs, indexed count, chunk count, ChromaDB collection size. |
| `/api/rag/query` | POST | Submit question `{ query: "..." }`. Returns `{ answer: "...", sources: [{ title, filename, chunk_text }] }`. Blocking call (~2-5s for embedding + retrieval + LLM). |
| `/api/rag/reindex/:id` | POST | Re-index a single document by ID (after upload or edit). |

## Phase 3: Frontend UI (~20 min)

**Component:** `frontend/src/apps/DocumentRAG.jsx`

- Chat-style interface (messages from user + assistant)
- Input field for questions about documents
- Response area showing LLM-generated answer with inline source citations
- Citation cards linking back to original document in Document Repository (`/docs/:filename` with page anchor for PDFs)
- "Index Documents" button to trigger re-indexing after new uploads
- Status indicator showing indexing progress (poll `/api/rag/status`)
- Query history table (SQLite `rag_queries`) for revisiting past questions

**State management improvements:**
- Auto-scroll to bottom on new messages via `useRef` + `scrollIntoView`
- Loading skeletons during indexing/querying
- Disabled states prevent double-submit
- Error boundaries with user-friendly messages

## Phase 4: Integration (~10 min)

- Add RAG app entry to the launcher grid alongside Document Repository
- When a user views a document preview, add an "Ask about this doc" action
- On document delete from repo → remove its chunks from ChromaDB (by doc_id filter)
- On document re-upload → call `/api/rag/reindex/:id` for that specific document only

## SQLite Schema Additions

```sql
-- Track indexing status per document
ALTER TABLE documents ADD COLUMN indexed INTEGER DEFAULT 0;
ALTER TABLE documents ADD COLUMN chunk_count INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_docs_indexed ON documents(indexed);

-- Query logging for debugging relevance (P2)
CREATE TABLE IF NOT EXISTS rag_queries (
    id TEXT PRIMARY KEY,
    query_text TEXT NOT NULL,
    results_count INTEGER DEFAULT 0,
    response_time_ms INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## ChromaDB Collection Schema

Each chunk stored in ChromaDB with:
- **embedding:** 384-dim vector from all-MiniLM-L6-v2
- **metadata:** `{ doc_id, title, filename, file_type, page_number, chunk_index, total_chunks }`
- **id:** `"${doc_id}_chunk_${chunk_index}"` (deterministic for dedup)

**Metadata fields explained:**
- `file_type`: 'pdf' or 'docx' — different extraction quality
- `page_number`: For PDFs, which page the chunk came from (enables page-specific citations)
- `total_chunks`: Total chunks in document (for progress tracking)

## Key Design Decisions (Updated)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Embedding model | `all-MiniLM-L6-v2` | Small (~250MB), fast CPU inference, 384-dim vectors |
| Vector DB | ChromaDB persistent (`chromadb_data/`) | No server needed, survives restarts (P1 fix) |
| Model loading | Singleton at module import time | Avoids ~5-10s cold start per request |
| Chunk size | 500 tokens / 100 overlap | Balance context window vs retrieval precision |
| Top-k | 5 chunks | Enough context without overwhelming LLM prompt |
| Persistence path | `rag/../chromadb_data/` (relative to app dir) | Survives container restarts, co-located with app data |

## Pitfalls & Mitigations

1. **ChromaDB persistence (P1)** — Must use `PersistentClient(path=...)`, NOT default ephemeral client. Data lost on restart otherwise.
2. **Model singleton** — Load once at server startup. Same instance for indexing AND querying, or vectors are incomparable.
3. **Concurrent writes** — ChromaDB isn't fully thread-safe during bulk inserts. Index sequentially; queries can read concurrently.
4. **Large document indexing** — A 100-page PDF could generate hundreds of chunks. Process in order with progress logging.
5. **Vite rebuild after adding new app** — Run `npm run build` and kill old node processes before testing.
6. **Text extraction failures** — Corrupted PDFs, scanned images without OCR → log warning, skip doc (don't crash indexing).
7. **Empty chunks** — Filter out zero-length or whitespace-only chunks before embedding.
8. **LM Studio API format** — Use same OpenAI-compatible endpoint as current model; construct proper chat completion request with system prompt + context.
9. **Token vs word counting** — 500 tokens ≠ 500 words. Use tiktoken for accurate chunk sizing to avoid LLM context overflow.

## Alternative Approaches Considered

- **BM25 first, vectors second:** For short local corpora (<100 docs), SQLite FTS5 might outperform vector search on keyword queries. Could add hybrid: BM25 for initial filtering, then rerank with embeddings. (P3)
- **SQLite VSS extension:** Instead of ChromaDB, use SQLite's built-in vector search (newer versions). Single storage backend, no separate persistence concerns. Worth evaluating if ChromaDB proves heavy.
- **Lazy indexing:** Don't pre-index all docs; index on first query against a document. Saves initial setup time but adds latency to first question per doc. Could be added as an optimization later.

## Estimated Total Time: ~80 minutes (was 60-90, +15 for error handling & model singleton)
