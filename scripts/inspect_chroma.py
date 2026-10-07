import chromadb
c = chromadb.PersistentClient(path="/home/marvin/bobs-apps/chromadb_data")
for col in c.list_collections():
    n = col.count()
    print("collection:", col.name, "count:", n)
    if n:
        s = col.peek(3)
        for i, (doc, meta) in enumerate(zip(s["documents"], s["metadatas"])):
            print(f"  [{i}] {meta} :: {doc[:100]!r}")
