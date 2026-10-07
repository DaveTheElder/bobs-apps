# Bob's Apps RAG Module - Text Chunking Utilities

import tiktoken

# Use cl100k_base encoding (same as GPT-4) for accurate token counting
ENCODING = tiktoken.get_encoding("cl100k_base")


def chunk_text(text: str, chunk_size: int = 500, overlap: int = 100) -> list[dict]:
    """Split text into overlapping chunks by TOKEN count, not word count.
    
    Args:
        text: Input text to split
        chunk_size: Maximum tokens per chunk (default 500)
        overlap: Token overlap between chunks (default 100)
        
    Returns:
        List of dicts with 'text', 'chunk_index', and 'total_chunks' keys
    """
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
        chunk_text_str = ENCODING.decode(chunk_tokens)
        
        if chunk_text_str.strip():
            chunks.append({
                "text": chunk_text_str,
                "chunk_index": len(chunks),
                "total_chunks": total_chunks
            })
        start += (chunk_size - overlap)
    
    return chunks
