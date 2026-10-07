// src/db.js — single source for DB connection, paths, and schema init.
// Every route module takes this object as a parameter (dependency injection),
// so tests can point DOCS_DIR/DB_PATH at temp dirs via env before requiring it.

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Repo root — everything is resolved relative to this, never /root/bobs-apps.
const ROOT = process.env.BOBS_ROOT || path.join(__dirname, '..');

const DOCS_DIR = process.env.DOCS_DIR || path.join(ROOT, 'documents');
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

// Slideshow photo originals (docs/archive/SLIDESHOW_PLAN.md). Separate dir from documents:
// different content types, different cache policy, and a show delete should
// never have to go hunting through the docs folder.
const SLIDESHOW_DIR = process.env.SLIDESHOW_DIR || path.join(ROOT, 'slideshow-photos');
if (!fs.existsSync(SLIDESHOW_DIR)) fs.mkdirSync(SLIDESHOW_DIR, { recursive: true });

// Downloaded background music (yt-dlp output), one dir per app like photos.
// Kept separate so photo budgets/deletes never touch audio and vice versa.
const SLIDESHOW_AUDIO_DIR = process.env.SLIDESHOW_AUDIO_DIR || path.join(ROOT, 'slideshow-audio');
if (!fs.existsSync(SLIDESHOW_AUDIO_DIR)) fs.mkdirSync(SLIDESHOW_AUDIO_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'bobs-apps.db');
const db = new sqlite3.Database(DB_PATH);
db.run('PRAGMA journal_mode=WAL');

// Apps that exist as frontend components. INSERT OR IGNORE keeps any rows a
// production DB already has (renames, disabled flags) untouched on re-seed.
const DEFAULT_APPS = [
  { name: 'project-hub', icon: '📋', description: 'Project management and tracking', entry_point: 'ProjectHub', sort_order: 1 },
  { name: 'calculator', icon: '🔢', description: 'Quick calculator', entry_point: 'Calculator', sort_order: 2 },
  { name: 'notes', icon: '📝', description: 'Simple notes app', entry_point: 'Notes', sort_order: 3 },
  { name: 'pomodoro', icon: '⏱️', description: 'Pomodoro timer', entry_point: 'Pomodoro', sort_order: 4 },
  { name: 'color-picker', icon: '🎨', description: 'Color picker tool', entry_point: 'ColorPicker', sort_order: 5 },
  { name: 'converter', icon: '🔄', description: 'Unit converter', entry_point: 'Converter', sort_order: 6 },
  { name: 'db-admin', icon: '🗄️', description: 'Database administration', entry_point: 'DBAdmin', sort_order: 7 },
  { name: 'document-repo', icon: '📄', description: 'Browse and download stored documents', entry_point: 'DocumentRepository', sort_order: 8 },
  // Previously missing from the registry, so the launcher could never open them.
  { name: 'document-rag', icon: '🔎', description: 'Ask questions across your documents (RAG)', entry_point: 'DocumentRAG', sort_order: 9 },
  { name: 'astro-engine', icon: '✨', description: 'Natal charts, transits, synastry', entry_point: 'AstroEngine', sort_order: 10 },
  { name: 'lunar-lander', icon: '🌙', description: 'Lunar Lander game', entry_point: 'LunarLander', sort_order: 11 },
];

function seedApp(app) {
  return new Promise((resolve) => {
    db.run(
      'INSERT OR IGNORE INTO app_registry (name, icon, description, entry_point, sort_order) VALUES (?, ?, ?, ?, ?)',
      [app.name, app.icon, app.description, app.entry_point, app.sort_order],
      () => resolve()
    );
  });
}

// Creates all tables/indexes/triggers idempotently and seeds the app registry.
// Resolves when safe to accept requests. Rejects only on a hard first-boot error.
async function initDB() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
      status TEXT DEFAULT 'not-started', priority TEXT DEFAULT 'medium',
      progress INTEGER DEFAULT 0, deadline TEXT DEFAULT '', owner TEXT DEFAULT '',
      tags TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)`,
    `CREATE INDEX IF NOT EXISTS idx_projects_priority ON projects(priority)`,
    `CREATE INDEX IF NOT EXISTS idx_projects_created ON projects(created_at DESC)`,
    `CREATE TRIGGER IF NOT EXISTS update_projects_timestamp
      AFTER UPDATE ON projects
      BEGIN UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`,

    `CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,

    `CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '',
      filename TEXT NOT NULL UNIQUE, file_type TEXT NOT NULL CHECK(file_type IN ('pdf', 'docx')),
      file_size INTEGER DEFAULT 0, category TEXT DEFAULT 'general', tags TEXT DEFAULT '',
      indexed INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS idx_docs_category ON documents(category)`,
    `CREATE INDEX IF NOT EXISTS idx_docs_created ON documents(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_docs_tags ON documents(tags)`,
    `CREATE TRIGGER IF NOT EXISTS update_documents_timestamp
      AFTER UPDATE ON documents
      BEGIN UPDATE documents SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`,

    // Legacy DBs created before RAG shipped may lack these columns.
    'ALTER TABLE documents ADD COLUMN indexed INTEGER DEFAULT 0',
    'ALTER TABLE documents ADD COLUMN chunk_count INTEGER DEFAULT 0',

    `CREATE TABLE IF NOT EXISTS rag_queries (
      id TEXT PRIMARY KEY, query_text TEXT NOT NULL, results_count INTEGER DEFAULT 0,
      response_time_ms INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,

    // Chat sessions ("new chat" model): each session is a thread of Q/A pairs that
    // survives reloads/browser switches/container restarts. Legacy rows predating this
    // feature get backfilled into one 'legacy' session below so old research isn't lost.
    `CREATE TABLE IF NOT EXISTS rag_sessions (
      id TEXT PRIMARY KEY,
      title TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS rag_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT REFERENCES rag_sessions(id),
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      model TEXT,
      llm_offline INTEGER DEFAULT 0,
      sources_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    // Order matters on upgrade: v1 DBs have rag_messages WITHOUT session_id, so the
    // index over that column must come after the ALTER — creating it first kills boot
    // with 'no such column' (regression-pinned in tests/test_migrations.js).

    // Migrations for DBs created by the first history ship (messages existed, no sessions).
    // Duplicate-column errors are already tolerated below.
    'ALTER TABLE rag_messages ADD COLUMN session_id TEXT REFERENCES rag_sessions(id)',
    // Fold pre-session messages into one visible 'legacy' thread so old research survives.
    `INSERT OR IGNORE INTO rag_sessions (id, title)
     SELECT 'legacy', 'Older history' WHERE EXISTS (SELECT 1 FROM rag_messages WHERE session_id IS NULL)`,
    `UPDATE rag_messages SET session_id = 'legacy' WHERE session_id IS NULL`,
    'CREATE INDEX IF NOT EXISTS idx_rag_messages_session ON rag_messages(session_id)',

    `CREATE TABLE IF NOT EXISTS app_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, icon TEXT NOT NULL,
      description TEXT DEFAULT '', enabled INTEGER DEFAULT 1, entry_point TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,

    // ---- slideshows (docs/archive/SLIDESHOW_PLAN.md) ------------------------
    // loop defaults ON: this app exists to run unattended on a TV.
    `CREATE TABLE IF NOT EXISTS slideshows (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, music_url TEXT DEFAULT '',
      mode TEXT DEFAULT 'timed' CHECK(mode IN ('timed','track')),
      per_slide_seconds INTEGER DEFAULT 5,
      transition TEXT DEFAULT 'crossfade' CHECK(transition IN ('crossfade','cut','kenburns')),
      loop INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS idx_slideshows_created ON slideshows(created_at DESC)`,
    `CREATE TRIGGER IF NOT EXISTS update_slideshows_timestamp
      AFTER UPDATE ON slideshows
      BEGIN UPDATE slideshows SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`,
    // file_size is server-computed at upload (mid-stream counter), never trusted from the client.
    `CREATE TABLE IF NOT EXISTS slideshow_photos (
      id TEXT PRIMARY KEY,
      slideshow_id TEXT NOT NULL REFERENCES slideshows(id) ON DELETE CASCADE,
      filename TEXT NOT NULL UNIQUE, caption TEXT DEFAULT '',
      position INTEGER NOT NULL, duration_override REAL, file_size INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS idx_sphotos_show ON slideshow_photos(slideshow_id, position)`,

    // ---- slideshow audio (post-EmbedGate redesign, see src/audio.js) ----------
    // music_url stays the user's intent (YouTube link). The columns below track
    // the local render of it: status machine none→downloading→ready|error.
    "ALTER TABLE slideshows ADD COLUMN audio_status TEXT DEFAULT 'none'",
    "ALTER TABLE slideshows ADD COLUMN audio_error TEXT DEFAULT ''",
    `CREATE TABLE IF NOT EXISTS slideshow_tracks (
      id TEXT PRIMARY KEY,
      slideshow_id TEXT NOT NULL REFERENCES slideshows(id) ON DELETE CASCADE,
      filename TEXT NOT NULL UNIQUE, title TEXT DEFAULT '', duration REAL,
      position INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS idx_stracks_show ON slideshow_tracks(slideshow_id, position)`,
  ];

  for (const sql of statements) {
    await new Promise((resolve, reject) => {
      db.run(sql, (err) => {
        // "duplicate column" is expected on the two ALTERs when columns exist.
        if (err && !/duplicate column/i.test(err.message)) return reject(err);
        resolve();
      });
    });
  }

  await Promise.all(DEFAULT_APPS.map(seedApp));
}

module.exports = { db, DB_PATH, DOCS_DIR, SLIDESHOW_DIR, SLIDESHOW_AUDIO_DIR, ROOT, initDB };
