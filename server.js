// Bob's Apps — server entry point.
// Thin on purpose: wiring + middleware only. Routes live in src/routes/,
// DB/schema in src/db.js, RAG pipeline in rag/ (Python), astro math in astro-engine.js.

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const { db, DB_PATH, DOCS_DIR, SLIDESHOW_DIR, SLIDESHOW_AUDIO_DIR, initDB } = require('./src/db');
const coreRoutes = require('./src/routes/core');
const docsRoutes = require('./src/routes/docs');
const ragRoutes = require('./src/routes/rag');
const astroRoutes = require('./src/routes/astro');
const ttsRoutes = require('./src/routes/tts');
const slideshowRoutes = require('./src/routes/slideshows');
const { AudioJobs } = require('./src/audio');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ---- routes ---------------------------------------------------------------
const audioJobs = new AudioJobs({ db, audioDir: SLIDESHOW_AUDIO_DIR });
app.use(coreRoutes({ db, DB_PATH }));
app.use(docsRoutes({ db, DOCS_DIR }));
app.use(ragRoutes({ db, DOCS_DIR, DB_PATH }));
app.use(astroRoutes());
app.use(ttsRoutes({ DOCS_DIR }));
app.use(slideshowRoutes({ db, SLIDESHOW_DIR, audioJobs }));

// Health check — also what start.sh should probe.
app.get('/health', (req, res) => {
  db.get('SELECT 1 as ok', [], (err) => {
    if (err) return res.status(500).json({ status: 'error', db: 'disconnected' });
    res.json({
      status: 'ok',
      db: 'connected',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  });
});

// ---- static SPA ------------------------------------------------------------
const DIST_PATH = path.join(__dirname, 'frontend', 'dist');
app.use(express.static(DIST_PATH));

// SPA fallback: non-API routes without a file extension serve index.html.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api') && !path.extname(req.path)) {
    return res.sendFile(path.join(DIST_PATH, 'index.html'));
  }
  next();
});

// ---- start -----------------------------------------------------------------
initDB().then(() => {
  const PORT = process.env.PORT || 8080;

  // Docker PID 1 doesn't get signals unless we handle them.
  if (process.pid === 1) {
    process.on('SIGTERM', () => { db.close(); process.exit(0); });
    process.on('SIGINT', () => { db.close(); process.exit(0); });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Bob's Apps running on http://localhost:${PORT}`);
    console.log(`Database: ${DB_PATH}`);
    console.log(`Documents: ${DOCS_DIR}`);
  });

  server.on('close', () => {
    db.close();
    process.exit(0);
  });
}).catch((err) => {
  console.error('FATAL — could not initialize database:', err.message);
  process.exit(1);
});
