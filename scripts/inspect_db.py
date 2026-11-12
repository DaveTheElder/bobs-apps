# scripts/inspect_db.py — dev probe: dump table list and row counts for the
# core app tables of bobs-apps.db.
import sqlite3, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
db = os.path.join(ROOT, "bobs-apps.db")
conn = sqlite3.connect(db)
cur = conn.cursor()
tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")]
print("TABLES:", tables)
for t in ["documents", "projects", "notes", "app_registry", "rag_queries"]:
    if t in tables:
        n = cur.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        print(f"{t}: {n} rows")
print("\nDOCUMENTS:")
for r in cur.execute("SELECT id, title, filename, file_type, indexed, chunk_count FROM documents"):
    print("  ", r)
print("\nchromadb_data:", os.listdir(os.path.join(ROOT, "chromadb_data")))
