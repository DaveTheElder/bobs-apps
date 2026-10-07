import React, { useState, useEffect } from 'react';
import { apiFetch, apiUrl } from '../api';

export default function DBAdmin() {
  const [tables, setTables] = useState([]);
  const [selectedTable, setSelectedTable] = useState('');
  const [columns, setColumns] = useState([]);
  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [search, setSearch] = useState('');
  const [editingRow, setEditingRow] = useState(null);
  const [newRow, setNewRow] = useState({});
  const [sqlQuery, setSqlQuery] = useState('SELECT * FROM projects LIMIT 10');
  const [queryResults, setQueryResults] = useState([]);
  const [activeTab, setActiveTab] = useState('browser');

  useEffect(() => {
    apiFetch('/api/db/tables')
      .then(r => r.json())
      .then(setTables);
  }, []);

  useEffect(() => {
    if (selectedTable) loadTableData();
  }, [selectedTable, pagination.page, search]);

  const loadTableData = () => {
    const params = new URLSearchParams({
      page: pagination.page,
      limit: 50,
      ...(search && { search })
    });
    
    apiFetch(`/api/db/tables/${selectedTable}?${params}`)
      .then(r => r.json())
      .then(data => {
        setColumns(data.columns);
        setRows(data.rows);
        setPagination(data.pagination);
      });
  };

  const handleEdit = (row) => {
    setEditingRow({ ...row });
  };

  const saveRow = () => {
    apiFetch(`/api/db/tables/${selectedTable}/rows/${editingRow.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingRow)
    }).then(() => {
      setEditingRow(null);
      loadTableData();
    });
  };

  const deleteRow = (id) => {
    if (!confirm('Delete this row?')) return;
    apiFetch(`/api/db/tables/${selectedTable}/rows/${id}`, { method: 'DELETE' })
      .then(() => loadTableData());
  };

  const addRow = () => {
    apiFetch(`/api/db/tables/${selectedTable}/rows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newRow)
    }).then(() => {
      setNewRow({});
      loadTableData();
    });
  };

  const runQuery = () => {
    apiFetch('/api/db/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: sqlQuery })
    })
      .then(r => r.json())
      .then(data => setQueryResults(data.rows || []));
  };

  const downloadBackup = () => {
    window.open(apiUrl("/api/db/backup"), "_blank");
  };

  return (
    <div style={{ maxWidth: '1200px', margin: '20px auto' }}>
      <h2>🗄️ Database Admin</h2>
      
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        {['browser', 'sql'].map(tab => (
          <button
            key={tab}
            className={`btn ${activeTab === tab ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'browser' ? 'Table Browser' : 'SQL Console'}
          </button>
        ))}
        <button className="btn btn-ghost" onClick={downloadBackup}>
          💾 Backup
        </button>
      </div>

      {activeTab === 'browser' ? (
        <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', gap: '16px' }}>
          {/* Table List */}
          <div style={{ background: '#f0f1f3', padding: '16px', borderRadius: '8px' }}>
            <h4>Tables</h4>
            {tables.map(table => (
              <button
                key={table}
                className={`btn ${selectedTable === table ? 'btn-primary' : 'btn-ghost'}`}
                style={{ width: '100%', marginBottom: '4px', textAlign: 'left' }}
                onClick={() => setSelectedTable(table)}
              >
                {table}
              </button>
            ))}
          </div>

          {/* Table Data */}
          <div>
            {selectedTable ? (
              <>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                  <input
                    type="text"
                    placeholder="Search..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    style={{ flex: 1, padding: '8px' }}
                  />
                </div>

                <div style={{ overflowX: 'auto', background: 'white', borderRadius: '8px', border: '1px solid #e2e4ea' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#f0f1f3' }}>
                        {columns.map(col => (
                          <th key={col.name} style={{ padding: '8px', textAlign: 'left', borderBottom: '1px solid #e2e4ea' }}>
                            {col.name}
                          </th>
                        ))}
                        <th style={{ padding: '8px' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(row => (
                        <tr key={row.id}>
                          {columns.map(col => (
                            <td key={col.name} style={{ padding: '8px', borderBottom: '1px solid #f0f1f3' }}>
                              {editingRow?.id === row.id ? (
                                <input
                                  value={editingRow[col.name] || ''}
                                  onChange={e => setEditingRow({ ...editingRow, [col.name]: e.target.value })}
                                  style={{ width: '100%' }}
                                />
                              ) : (
                                String(row[col.name] || '')
                              )}
                            </td>
                          ))}
                          <td style={{ padding: '8px' }}>
                            {editingRow?.id === row.id ? (
                              <>
                                <button className="btn btn-primary" onClick={saveRow}>Save</button>
                                <button className="btn btn-ghost" onClick={() => setEditingRow(null)}>Cancel</button>
                              </>
                            ) : (
                              <>
                                <button className="btn btn-ghost" onClick={() => handleEdit(row)}>Edit</button>
                                <button className="btn btn-ghost" onClick={() => deleteRow(row.id)}>Del</button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'space-between' }}>
                  <span>Page {pagination.page} of {pagination.pages} ({pagination.total} rows)</span>
                  <div>
                    <button className="btn btn-ghost" disabled={pagination.page === 1} onClick={() => setPagination(p => ({ ...p, page: p.page - 1 }))}>
                      Prev
                    </button>
                    <button className="btn btn-ghost" disabled={pagination.page === pagination.pages} onClick={() => setPagination(p => ({ ...p, page: p.page + 1 }))}>
                      Next
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <p>Select a table to browse</p>
            )}
          </div>
        </div>
      ) : (
        <div>
          <textarea
            value={sqlQuery}
            onChange={e => setSqlQuery(e.target.value)}
            style={{ width: '100%', height: '120px', fontFamily: 'monospace', padding: '8px' }}
          />
          <button className="btn btn-primary" onClick={runQuery} style={{ marginTop: '8px' }}>
            Run Query
          </button>
          
          {queryResults.length > 0 && (
            <div style={{ marginTop: '16px', overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {Object.keys(queryResults[0]).map(key => (
                      <th key={key} style={{ padding: '8px', background: '#f0f1f3', borderBottom: '1px solid #e2e4ea' }}>
                        {key}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {queryResults.map((row, i) => (
                    <tr key={i}>
                      {Object.values(row).map((val, j) => (
                        <td key={j} style={{ padding: '8px', borderBottom: '1px solid #f0f1f3' }}>
                          {String(val || '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
