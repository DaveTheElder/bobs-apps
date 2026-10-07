// src/routes/docs.js — Document repository API.
// Contract (unchanged from the old monolith): list/create/get/delete/preview + /docs/:filename download.
// Changes in this rebuild:
//   * registration validates the file exists on disk and computes size server-side
//     (the separate POST /api/docs/:id/size endpoint is kept for back-compat but no longer needed)
//   * preview runs rag/cli.py extract — one code path, real argv, no inline Python

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Transform, pipeline } = require('stream');

module.exports = function docsRoutes({ db, DOCS_DIR }) {
  const router = express.Router();
  const CLI = path.join(__dirname, '..', '..', 'rag', 'cli.py');
  // Resolve the project venv's interpreter directly — no PATH games.
  const VENV_PY = path.join(__dirname, '..', '..', '.venv', 'bin', 'python3');
  const PY = process.env.PYTHON || (fs.existsSync(VENV_PY) ? VENV_PY : 'python3');

  const safeFilename = (name) => String(name).replace(/[^a-zA-Z0-9._-]/g, '');

  // ---- list ----------------------------------------------------------------
  router.get('/api/docs', (req, res) => {
    const { category, search, sort } = req.query;
    let query = 'SELECT * FROM documents WHERE 1=1';
    const params = [];

    if (category && category !== 'all') { query += ' AND category = ?'; params.push(category); }
    if (search) {
      query += ' AND (title LIKE ? OR description LIKE ? OR tags LIKE ?)';
      const s = `%${search}%`; params.push(s, s, s);
    }

    const sortOrder = sort === 'oldest' ? 'ASC' : sort === 'name' ? 'ASC' : 'DESC';
    const sortBy = sort === 'name' ? 'title' : 'created_at';
    query += ` ORDER BY ${sortBy} ${sortOrder}`;

    db.all(query, params, (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      db.all('SELECT DISTINCT category FROM documents WHERE category != "general"', [], (catErr, catRows) => {
        res.json({ docs: rows, categories: catErr ? [] : catRows.map(r => r.category) });
      });
    });
  });

  // ---- create --------------------------------------------------------------
  router.post('/api/docs', (req, res) => {
    const { title, description, file_type, category, tags, filename } = req.body;

    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });
    if (!filename) return res.status(400).json({ error: 'Filename is required' });
    if (!['pdf', 'docx'].includes(file_type)) {
      return res.status(400).json({ error: "file_type must be 'pdf' or 'docx'" });
    }

    const fn = safeFilename(filename);
    const filePath = path.join(DOCS_DIR, fn);

    // Hard rule the old API skipped: the file MUST exist on disk before we claim to have it.
    if (!fs.existsSync(filePath)) {
      return res.status(400).json({ error: `File not found in documents directory: ${fn}` });
    }

    const id = crypto.randomUUID();
    const cat = category || 'general';
    const tagStr = tags ? (Array.isArray(tags) ? tags.join(',') : String(tags)) : '';
    const size = fs.statSync(filePath).size;

    db.run(`INSERT INTO documents (id, title, description, filename, file_type, file_size, category, tags)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, String(title).trim(), description || '', fn, file_type, size, cat, tagStr],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        db.get('SELECT * FROM documents WHERE id = ?', [id], (e2, row) => {
          if (e2) return res.status(500).json({ error: e2.message });
          res.json(row);
        });
      }
    );
  });

  // ---- upload ----------------------------------------------------------------
  // Raw-bytes upload: POST /api/docs/upload?title=...&category=...&tags=a,b
  // body = the file itself, Content-Type application/pdf | application/vnd.openxmlformats-officedocument.wordprocessingml.document (or octet-stream + ext param).
  // Why raw stream instead of multipart/multer: zero new deps, one code path for
  // browser fetch and curl alike. Metadata travels in query params; the server
  // names the file <uuid>.<ext> so two uploads can never collide or path-escape.
  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
  const MIME_EXT = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  };

  router.post('/api/docs/upload', (req, res) => {
    const title = String(req.query.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title query param is required' });

    let ext = MIME_EXT[req.headers['content-type']];
    if (!ext && req.query.ext) {
      ext = ['pdf', 'docx'].includes(req.query.ext) ? req.query.ext : undefined;
    }
    if (!ext) return res.status(400).json({ error: 'Unsupported Content-Type; send application/pdf or docx (or ?ext=)' });

    // Enforce the cap mid-stream: bail before the disk fills, not after.
    let received = 0, capped = false;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        if (received > MAX_UPLOAD_BYTES && !capped) { capped = true; return cb(new Error('upload too large')); }
        cb(null, chunk);
      },
    });

    const id = crypto.randomUUID();
    const filename = `${id}.${ext}`;
    const dest = path.join(DOCS_DIR, filename);
    fs.mkdirSync(DOCS_DIR, { recursive: true });

    pipeline(req, limiter, fs.createWriteStream(dest), (err) => {
      const cleanup = () => fs.rm(dest, { force: true }, () => {});
      if (err) {
        cleanup();
        const status = String(err.message).includes('too large') ? 413 : 500;
        return res.status(status).json({ error: err.message === 'upload too large'
          ? `File exceeds ${MAX_UPLOAD_BYTES} bytes` : 'Upload failed: ' + err.message });
      }
      const size = fs.statSync(dest).size;
      if (size === 0) { cleanup(); return res.status(400).json({ error: 'Empty upload' }); }

      const cat = req.query.category || 'general';
      const tags = req.query.tags ? String(req.query.tags) : '';
      db.run(`INSERT INTO documents (id, title, description, filename, file_type, file_size, category, tags)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, title, '', filename, ext, size, cat, tags],
        function (dbErr) {
          if (dbErr) { cleanup(); return res.status(500).json({ error: dbErr.message }); }
          db.get('SELECT * FROM documents WHERE id = ?', [id], (e2, row) => {
            if (e2) return res.status(500).json({ error: e2.message });
            res.json(row);
          });
        });
    });
  });

  // ---- size patch (back-compat; new clients compute it at register time) ---
  router.post('/api/docs/:id/size', (req, res) => {
    const { size } = req.body;
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
      return res.status(400).json({ error: 'size must be a non-negative number' });
    }
    db.run('UPDATE documents SET file_size = ? WHERE id = ?', [size, req.params.id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(404).json({ error: 'Document not found' });
      db.get('SELECT * FROM documents WHERE id = ?', [req.params.id], (e2, row) => {
        if (e2) return res.status(500).json({ error: e2.message });
        res.json(row);
      });
    });
  });

  // ---- get -----------------------------------------------------------------
  router.get('/api/docs/:id', (req, res) => {
    db.get('SELECT * FROM documents WHERE id = ?', [req.params.id], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Document not found' });
      res.json(row);
    });
  });

  // ---- delete --------------------------------------------------------------
  router.delete('/api/docs/:id', (req, res) => {
    db.get('SELECT filename FROM documents WHERE id = ?', [req.params.id], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Document not found' });

      const filePath = path.join(DOCS_DIR, safeFilename(row.filename));
      fs.unlink(filePath, (fileErr) => {
        if (fileErr && fileErr.code !== 'ENOENT') console.error('Failed to delete document file:', fileErr.message);
        db.run('DELETE FROM documents WHERE id = ?', [req.params.id], function(err2) {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({ success: true });
        });
      });
    });
  });

  // ---- preview -------------------------------------------------------------
  router.get('/api/docs/:id/preview', (req, res) => {
    db.get('SELECT * FROM documents WHERE id = ?', [req.params.id], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Document not found' });

      const filePath = path.join(DOCS_DIR, safeFilename(row.filename));
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

      execFile(PY, [CLI, 'extract', filePath, row.title], {
        encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 60000
      }, (err, output) => {
        if (err) return res.status(500).json({ error: 'Failed to extract text: ' + err.message });
        try {
          const result = JSON.parse(output.trim());
          if (result.error && !result.text) return res.status(500).json(result);
          res.json(result);
        } catch (parseErr) {
          res.status(500).json({ error: 'Malformed extraction output', raw_output: output.trim().slice(0, 2000) });
        }
      });
    });
  });

  // ---- download ------------------------------------------------------------
  router.get('/docs/:filename', (req, res) => {
    const filename = safeFilename(req.params.filename);
    const filePath = path.join(DOCS_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    res.download(filePath, filename);
  });

  return router;
};
