# Bob's Apps backend — single image, two runtimes (node + python).
# Built FROM one base to keep the image small; node installs deps before copying
# sources so layer caching works. The venv is built in-image; rag/cli.py runs
# against it via /opt/bobs/.venv/bin/python3.

FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip build-essential git curl ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/bobs

# ---- node deps (cached layer) --------------------------------------------
# BUST is a cache-bust knob: pass --build-arg BUST=$(date +%s) to force this layer
# to re-run after fixing a native dep (e.g. sqlite3 prebuilt binary vs glibc).
ARG BUST=1
COPY package.json ./
RUN echo "deps-layer build ${BUST}" \
 && npm install --omit=dev --no-audit --no-fund \
 # sqlite3 ships a prebuilt .node built against a newer glibc than bookworm-slim;
 # rebuild it from source so it links this image's libm. Needs make/g++/python (above).
 && npm_config_build_from_source=true npm rebuild sqlite3

# ---- python venv for the RAG pipeline -------------------------------------
RUN python3 -m venv .venv \
 && ./.venv/bin/pip install --no-cache-dir \
      pymupdf python-docx chromadb sentence-transformers tiktoken requests \
      yt-dlp  # slideshow background-music downloads (src/audio.js)

# ---- sources ----------------------------------------------------------------
COPY server.js ./
COPY src ./src
COPY astro-engine.js ./astro-engine.js
COPY rag ./rag

ENV PORT=8080 \
    DOCS_DIR=/data/docs \
    DB_PATH=/data/bobs-apps.db \
    CHROMA_DIR=/data/chromadb_data \
    YTDL_BIN=/opt/bobs/.venv/bin/yt-dlp \
    PYTHONUNBUFFERED=1

VOLUME ["/data"]
EXPOSE 8080

# Healthcheck probes the same endpoint Caddy will use for upstream checks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -sf http://localhost:8080/health || exit 1

CMD ["node", "server.js"]
