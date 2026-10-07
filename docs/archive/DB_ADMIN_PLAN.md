# DB Admin App - Implementation Plan

## Overview
Add a database administration app to Bob's Apps for managing SQLite databases directly from the UI.

**App Name:** Database Admin
**Icon:** 🗄️
**Entry Point:** `DBAdmin`
**Sort Order:** 7 (after Converter)

## Features

### Phase 1: Core Database Browser
- [ ] List all tables in bobs-apps.db
- [ ] View table schema (columns, types)
- [ ] Browse table data with pagination
- [ ] Search/filter rows
- [ ] Sort by columns

### Phase 2: Data Operations
- [ ] View single row details
- [ ] Edit cell values inline
- [ ] Add new rows
- [ ] Delete rows
- [ ] Bulk delete

### Phase 3: SQL Console
- [ ] Execute custom SQL queries
- [ ] Results viewer with syntax highlighting
- [ ] Query history
- [ ] Export results to CSV/JSON

### Phase 4: Database Management
- [ ] Vacuum database
- [ ] Backup database (download .db file)
- [ ] Restore from upload
- [ ] Table statistics (row counts, sizes)

## Technical Design

### Backend API Routes
```
GET    /api/db/tables              # List tables
GET    /api/db/tables/:name        # Get table schema + data
POST   /api/db/tables/:name/rows   # Insert row
PUT    /api/db/tables/:name/rows/:id # Update row
DELETE /api/db/tables/:name/rows/:id # Delete row
POST   /api/db/query               # Execute custom SQL
GET    /api/db/backup              # Download backup
POST   /api/db/restore             # Upload restore
```

### Frontend Component Structure
```
DBAdmin.jsx
├── TableListView
├── TableBrowserView
│   ├── SchemaViewer
│   ├── DataGrid (with pagination)
│   └── RowEditor
└── SQLConsole
```

### Security Considerations
- Read-only mode toggle for production
- Confirm dialogs for destructive operations
- Limit query execution time
- Sanitize table/column names

## Implementation Steps

1. **Backend** - Add DB admin routes to server.js
2. **Frontend** - Create DBAdmin.jsx component
3. **Register** - Add to app_registry
4. **Test** - Verify with existing tables (projects, notes)

## Estimated Effort
- Phase 1: 2 hours
- Phase 2: 3 hours  
- Phase 3: 2 hours
- Phase 4: 1 hour

Total: ~8 hours for full feature set
