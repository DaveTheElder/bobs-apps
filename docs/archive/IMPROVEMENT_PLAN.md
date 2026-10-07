# Bob's Apps - Improvement Plan

## Overview
Comprehensive plan to address code review issues for Bob's Apps launcher platform. Prioritized by impact vs effort.

**Current State:** Working MVP with 6 apps, SQLite backend, React frontend, Express server
**Target State:** Production-ready modular app platform with persistence, reliability, and extensibility

---

## Phase 1: Critical Fixes (Do First)

### 1.1 Fix App Registry Data Loss
**Problem:** `app_registry` table is dropped/recreated on every server start, losing any runtime changes.

**Current:**
```js
db.run('DROP TABLE IF EXISTS app_registry');
db.run(`CREATE TABLE app_registry (...)`);
```

**Fix:**
```js
// server.js initDB()
db.run(`CREATE TABLE IF NOT EXISTS app_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  icon TEXT NOT NULL,
  description TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  entry_point TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Seed defaults with INSERT OR IGNORE (already done)
```

**Files:** `server.js`, `server_debug.js`, `simple-server.js`, `debug-server2.js`
**Effort:** 15 min
**Impact:** High - prevents data loss

### 1.2 Fix App Ordering
**Problem:** API returns apps ordered by name, not sort_order.

**Current:**
```js
db.all('SELECT * FROM app_registry WHERE enabled=1 ORDER BY name', ...)
```

**Fix:**
```js
db.all('SELECT * FROM app_registry WHERE enabled=1 ORDER BY sort_order, name', ...)
```

**Files:** `server.js`
**Effort:** 2 min
**Impact:** High - UX

### 1.3 Fix initDB Race Condition
**Problem:** Async DB operations not properly sequenced.

**Fix:** Use serialize callbacks or Promises for all DB setup steps.

**Files:** `server.js`
**Effort:** 20 min
**Impact:** Medium - reliability

---

## Phase 2: Data & Persistence

### 2.1 Persist Notes App
**Problem:** Notes stored in React state only, lost on refresh.

**Plan:**
1. Create `notes` table:
```sql
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```
2. Add API routes: GET/POST/PUT/DELETE `/api/notes`
3. Update `Notes.jsx` to use API instead of state

**Files:** `server.js`, `frontend/src/apps/Notes.jsx`
**Effort:** 45 min
**Impact:** High - data durability

### 2.2 Add Database Indexes
**Problem:** Project queries will scan full table.

**Fix:**
```sql
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_priority ON projects(priority);
CREATE INDEX IF NOT EXISTS idx_projects_created ON projects(created_at DESC);
```

**Files:** `server.js` initDB
**Effort:** 10 min
**Impact:** Medium - performance

### 2.3 Fix updated_at Trigger
**Problem:** SQLite doesn't auto-update timestamp.

**Fix:**
```sql
CREATE TRIGGER IF NOT EXISTS update_projects_timestamp 
AFTER UPDATE ON projects
BEGIN
  UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
```

**Files:** `server.js` initDB
**Effort:** 10 min
**Impact:** Low - correctness

---

## Phase 3: Frontend Reliability

### 3.1 Add Error Boundaries
**Problem:** App crashes unmount whole window.

**Plan:**
Create `ErrorBoundary.jsx`:
```jsx
class ErrorBoundary extends React.Component {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    return this.state.hasError 
      ? <div>App crashed. <button onClick={() => window.location.reload()}>Reload</button></div>
      : this.props.children;
  }
}
```

Wrap dynamic app rendering in `App.jsx`.

**Files:** `frontend/src/ErrorBoundary.jsx`, `frontend/src/App.jsx`
**Effort:** 20 min
**Impact:** Medium - UX

### 3.2 Fix ProjectHub Filter Race
**Problem:** Filter change triggers load with stale debounced search.

**Fix:** Remove manual `loadProjects()` from select onChange, rely on useEffect dependencies only.

**Files:** `frontend/src/apps/ProjectHub.jsx`
**Effort:** 5 min
**Impact:** Low - correctness

### 3.3 Centralize Stats Fetching
**Problem:** Stats fetched manually after each mutation.

**Fix:** Use React Query or simple context with refetch on project changes.

**Quick fix:** Add `projects` to stats useEffect dependency via custom hook.

**Files:** `frontend/src/apps/ProjectHub.jsx`
**Effort:** 30 min
**Impact:** Medium - consistency

---

## Phase 4: Code Quality

### 4.1 Remove Dead Code
**Files to delete:**
- `api.js` (unused)
- All test servers: `test-*.js`, `minimal-server.js`, `simple-server.js`
- Debug servers: `debug-server.js`, `server_debug.js`, `debug-server2.js`
- Start scripts with wrong paths

**Keep:** `server.js`, `start-server.js`

**Effort:** 10 min
**Impact:** Low - cleanliness

### 4.2 Add Input Validation
**Problem:** API trusts client input.

**Fix:** Add validation middleware:
```js
function validateProject(req, res, next) {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  next();
}
```

**Files:** `server.js`
**Effort:** 30 min
**Impact:** Medium - robustness

### 4.3 Standardize Server Entry Point
**Problem:** Multiple server files with drift.

**Fix:**
- Keep only `server.js` as canonical
- Use env var `DEBUG=true` for verbose logging
- Update all start scripts to use correct path `/root/bobs-apps`

**Files:** All start scripts
**Effort:** 15 min
**Impact:** Low - maintainability

---

## Phase 5: UX Improvements

### 5.1 Calculator Fixes
- Fix `=` operator handling
- Add decimal precision control
- Add visual feedback for operations

**Files:** `frontend/src/apps/Calculator.jsx`
**Effort:** 30 min

### 5.2 Pomodoro Off-by-One
**Fix:** Increment sessions before calculating next mode.

**Files:** `frontend/src/apps/Pomodoro.jsx`
**Effort:** 5 min

### 5.3 ColorPicker Feedback
Add toast notification on copy success.

**Files:** `frontend/src/apps/ColorPicker.jsx`
**Effort:** 15 min

### 5.4 Converter Layout
Fix From/To column heights to match.

**Files:** `frontend/src/apps/Converter.jsx`
**Effort:** 10 min

---

## Phase 6: Developer Experience

### 6.1 Environment Configuration
Add `.env` support:
```
PORT=8080
DB_PATH=/root/bobs-apps/bobs-apps.db
NODE_ENV=production
```

Use `dotenv` package.

**Files:** `server.js`, `package.json`
**Effort:** 20 min

### 6.2 Add Health Check Endpoint
```js
app.get('/health', (req, res) => {
  db.get('SELECT 1', [], () => res.json({ status: 'ok', db: 'connected' }));
});
```

**Files:** `server.js`
**Effort:** 5 min

### 6.3 Logging
Replace console.log with structured logger (pino or winston).

**Effort:** 30 min

---

## Implementation Order

**Week 1:**
1. Phase 1 (Critical Fixes) - 1 hour
2. Phase 2.1 (Notes persistence) - 45 min
3. Phase 4.1 (Clean dead code) - 10 min

**Week 2:**
4. Phase 2.2-2.3 (Indexes & triggers)
5. Phase 3.1 (Error boundaries)
6. Phase 4.2 (Validation)

**Week 3:**
7. Phase 5 (UX fixes)
8. Phase 6 (DX improvements)

---

## Quick Wins Checklist

- [ ] Fix app ordering in API
- [ ] Stop dropping app_registry table
- [ ] Remove dead code files
- [ ] Fix ProjectHub filter race
- [ ] Persist Notes to DB
- [ ] Add DB indexes

These 6 items give 80% of value for ~2 hours work.

---

## Testing Plan

After each phase:
1. Restart server: `node server.js`
2. Test launcher loads apps in correct order
3. Create/edit/delete project
4. Create/edit/delete note (after Phase 2.1)
5. Open each app, verify no console errors
6. Check DB integrity

---

## Future Enhancements (Out of Scope)

- User authentication
- App marketplace / dynamic loading from URL
- WebSocket for real-time updates
- App versioning
- Backup/restore
- Docker compose setup
- CI/CD pipeline
- E2E tests with Playwright

---

## Files Reference

**Backend:**
- `server.js` - Main server (canonical)
- `bobs-apps.db` - SQLite database

**Frontend:**
- `frontend/src/App.jsx` - Launcher
- `frontend/src/apps/` - Individual apps
- `frontend/src/App.css` - Styles

**Scripts:**
- `scripts/new-app.js` - App scaffolding

---

*Plan created: 2026-08-14*
*Last updated: Based on code review findings*
