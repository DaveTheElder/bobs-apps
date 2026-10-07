"""Reconstruct `documents` rows from ChromaDB metadata + files on disk."""
import os, sqlite3, json
import chromadb

ROOT = "/home/marvin/bobs-apps"
db_path = os.path.join(ROOT, "bobs-apps.db.restored")

client = chromadb.PersistentClient(path=os.path.join(ROOT, "chromadb_data"))
col = client.get_collection("document_chunks")
n = col.count()
data = col.get(include=["metadatas"], limit=n)

docs = {}
for meta in data["metadatas"]:
    doc_id = meta.get("doc_id")
    if not doc_id:
        continue
    d = docs.setdefault(doc_id, {
        "id": doc_id, "title": meta.get("title", ""), "filename": meta.get("filename", ""),
        "file_type": meta.get("file_type"), "chunk_count": 0,
    })
    try:
        total = int(meta.get("total_chunks") or 1)
    except (TypeError, ValueError):
        total = 1
    d["chunk_count"] = max(d["chunk_count"], total)

print(f"recovered {len(docs)} docs from chroma ({n} chunks)")

docs_dir = os.path.join(ROOT, "documents")
for d in docs.values():
    fp = os.path.join(docs_dir, d["filename"])
    d["file_size"] = os.path.getsize(fp) if os.path.exists(fp) else 0
    d["missing_file"] = not os.path.exists(fp)

if os.path.exists(db_path):
    os.remove(db_path)
conn = sqlite3.connect(db_path)
c2 = conn.cursor()
c2.execute("""CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '',
    filename TEXT NOT NULL UNIQUE, file_type TEXT NOT NULL CHECK(file_type IN ('pdf','docx')),
    file_size INTEGER DEFAULT 0, category TEXT DEFAULT 'general', tags TEXT DEFAULT '',
    indexed INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)""")
for d in sorted(docs.values(), key=lambda x: x["id"]):
    c2.execute(
        "INSERT INTO documents (id,title,filename,file_type,file_size,indexed,chunk_count) VALUES (?,?,?,?,?,?,?)",
        (d["id"], d["title"], d["filename"], d["file_type"], d["file_size"], 1 if not d["missing_file"] else 0, d["chunk_count"]))
conn.commit()

for r in c2.execute("SELECT id,title,filename,file_type,file_size,indexed,chunk_count FROM documents"):
    print(r)
print("\nrestored db at:", db_path)
