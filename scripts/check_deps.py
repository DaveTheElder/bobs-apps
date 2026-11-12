# scripts/check_deps.py — smoke-check that the Python deps the RAG pipeline
# needs import cleanly. Run inside .venv after any dependency change.
import importlib, sys
for mod in ["pymupdf", "docx", "chromadb", "sentence_transformers", "requests"]:
    try:
        m = importlib.import_module(mod)
        print(f"OK   {mod} {getattr(m, '__version__', '')}")
    except ImportError as e:
        print(f"MISS {mod}: {e.name}")
