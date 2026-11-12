# Tests for rag/extract_text.py against fixture files in tests/fixtures/.
import sys, os
ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.join(ROOT, "rag"))

from extract_text import extract_text_from_file


def test_pdf_extracts():
    fp = os.path.join(ROOT, "tests", "fixtures", "test-report.pdf")
    r = extract_text_from_file(fp, "Test Report")
    assert r and "error" not in r
    assert r["page_count"] >= 1
    assert "Test document" in r["text"] or "test" in r["text"].lower()
    assert isinstance(r.get("blocks"), list)


def test_docx_extracts():
    fp = os.path.join(ROOT, "tests", "fixtures", "test-guide.docx")
    r = extract_text_from_file(fp, "RAG Guide")
    assert r and "error" not in r, f"docx extraction failed: {r}"
    assert len(r["text"]) > 100
    # The doc is about RAG — sanity check the text actually came from it.
    assert "retrieval" in r["text"].lower()


def test_unsupported_extension():
    assert extract_text_from_file("whatever.txt", "x") is None


if __name__ == "__main__":
    test_pdf_extracts()
    test_docx_extracts()
    test_unsupported_extension()
    print("extract_text: all tests passed")
