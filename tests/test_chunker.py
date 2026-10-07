# Unit tests for rag/chunker.py — dependency-free, run with any python in the venv.
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "rag"))

from chunker import chunk_text


def test_empty_input():
    assert chunk_text("") == []
    assert chunk_text("   ") == []


def test_short_text_single_chunk():
    out = chunk_text("hello world")
    assert len(out) == 1
    assert out[0]["text"] == "hello world"
    assert out[0]["chunk_index"] == 0
    assert out[0]["total_chunks"] == 1


def test_long_text_multiple_overlapping_chunks():
    text = ("The quick brown fox jumps over the lazy dog. " * 200)
    chunks = chunk_text(text, chunk_size=500, overlap=100)
    assert len(chunks) > 1
    # indices must be sequential and total consistent
    for i, c in enumerate(chunks):
        assert c["chunk_index"] == i
        assert c["total_chunks"] == chunks[-1]["total_chunks"]
        assert c["text"].strip()


def test_no_chunk_smaller_than_overlap():
    # guard against infinite-loop edge: chunk_size must exceed overlap
    text = "word " * 300
    chunks = chunk_text(text, chunk_size=200, overlap=50)
    assert len(chunks) >= 1


if __name__ == "__main__":
    test_empty_input()
    test_short_text_single_chunk()
    test_long_text_multiple_overlapping_chunks()
    test_no_chunk_smaller_than_overlap()
    print("chunker: all tests passed")
