# Bob's Apps RAG CLI — single entry point spawned by the Node server.
#
# Why a real script instead of inline `python3 -c "..."` strings:
#   * values arrive via argv/env, never interpolated into source (no quote bugs)
#   * one importable module to unit-test directly
#   * output contract: exactly ONE JSON object on stdout; logs go to stderr

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _emit(payload):
    """Print the single JSON result. flush so execFile sees it promptly."""
    print(json.dumps(payload), flush=True)


def cmd_extract(args):
    from rag.extract_text import extract_text_from_file

    result = extract_text_from_file(args.file_path, args.title)
    if not result:
        _emit({"title": args.title, "error": f"unsupported file type: {args.file_path}"})
        return 1
    _emit(result)
    return 0 if "error" not in result else 1


def cmd_index_all(args):
    from rag.engine import index_all_documents

    _emit(index_all_documents(args.db_path))
    return 0


def cmd_reindex_one(args):
    """Re-extract + re-embed a single document. Works for pdf AND docx —
    the old inline script hard-coded pymupdf and broke on .docx."""
    from rag.engine import delete_document_chunks, index_document
    from rag.extract_text import extract_page_text, extract_text_from_file

    file_path = args.file_path
    if not os.path.exists(file_path):
        _emit({"success": False, "error": f"File not found on disk: {args.filename}"})
        return 1

    result = extract_text_from_file(file_path, args.title)
    if not result or not (result.get("text") or "").strip():
        delete_document_chunks(args.doc_id)
        _emit({"success": True, "chunk_count": 0, "note": "no meaningful text"})
        return 0

    total = 0
    if args.file_type == "pdf" and result.get("page_count", 0) > 1:
        for page_num in range(1, int(result["page_count"]) + 1):
            pr = extract_page_text(file_path, args.title, page_num)
            if pr and (pr.get("text") or "").strip():
                total += index_document(args.doc_id, args.title, args.filename,
                                        pr["text"], page_number=page_num)
    else:
        total = index_document(args.doc_id, args.title, args.filename, result["text"])

    _emit({"success": True, "chunk_count": total})
    return 0


def cmd_delete_chunks(args):
    from rag.engine import delete_document_chunks

    delete_document_chunks(args.doc_id)
    _emit({"success": True})
    return 0


def cmd_query(args):
    from rag.query import query_documents

    _emit(query_documents(
        args.query, model=args.model, k=args.k, max_tokens=args.max_tokens,
        temperature=args.temperature, reasoning_effort=args.reasoning_effort))
    return 0


def main():
    p = argparse.ArgumentParser(prog="rag-cli")
    sub = p.add_subparsers(dest="command", required=True)

    e = sub.add_parser("extract"); e.add_argument("file_path"); e.add_argument("title")
    e.set_defaults(func=cmd_extract)

    i = sub.add_parser("index-all"); i.add_argument("db_path")
    i.set_defaults(func=cmd_index_all)

    r = sub.add_parser("reindex-one")
    r.add_argument("doc_id"); r.add_argument("file_path")
    r.add_argument("title"); r.add_argument("filename"); r.add_argument("file_type", choices=["pdf", "docx"])
    r.set_defaults(func=cmd_reindex_one)

    d = sub.add_parser("delete-chunks"); d.add_argument("doc_id")
    d.set_defaults(func=cmd_delete_chunks)

    q = sub.add_parser("query")
    q.add_argument("query")
    # LM Studio model id; omit -> server uses whatever is loaded (legacy behavior)
    q.add_argument("--model", default=None)
    # Generation knobs from the app's settings menu; omit -> module/env defaults.
    q.add_argument("--k", type=int, default=None, help="retrieval top-k")
    q.add_argument("--max-tokens", dest="max_tokens", type=int, default=None)
    q.add_argument("--temperature", type=float, default=None)
    q.add_argument("--reasoning-effort", dest="reasoning_effort", default=None,
                   choices=["low", "medium", "high"])
    q.set_defaults(func=cmd_query)

    args = p.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
