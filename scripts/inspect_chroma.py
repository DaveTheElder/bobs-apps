# scripts/inspect_chroma.py — dev probe: list RAG collections with counts and
# a 3-document peek each against the local chromadb_data store.
import os
import chromadb
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
c = chromadb.PersistentClient(path=os.path.join(ROOT, "chromadb_data"))
for col in c.list_collections():
    n = col.count()
    print("collection:", col.name, "count:", n)
    if n:
        s = col.peek(3)
        for i, (doc, meta) in enumerate(zip(s["documents"], s["metadatas"])):
            print(f"  [{i}] {meta} :: {doc[:100]!r}")
