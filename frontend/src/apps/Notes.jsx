import React, { useState, useEffect } from 'react';
import { apiFetch } from '../api';

export default function Notes() {
  const [notes, setNotes] = useState([]);
  const [editingNote, setEditingNote] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchNotes();
  }, []);

  async function fetchNotes() {
    try {
      const res = await apiFetch('/api/notes');
      const data = await res.json();
      setNotes(data);
    } catch (err) {
      console.error('Failed to fetch notes:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(noteData) {
    try {
      if (noteData.id) {
        const res = await apiFetch(`/api/notes/${noteData.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(noteData)
        });
        const updated = await res.json();
        setNotes(notes.map(n => n.id === updated.id ? updated : n));
      } else {
        const res = await apiFetch('/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(noteData)
        });
        const created = await res.json();
        setNotes([created, ...notes]);
      }
      setShowModal(false);
    } catch (err) {
      console.error('Failed to save note:', err);
      alert('Failed to save note');
    }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this note?')) return;
    try {
      await apiFetch(`/api/notes/${id}`, { method: 'DELETE' });
      setNotes(notes.filter(n => n.id !== id));
    } catch (err) {
      console.error('Failed to delete note:', err);
      alert('Failed to delete note');
    }
  }

  if (loading) return <div style={{ padding: '20px' }}>Loading notes...</div>;

  return (
    <div style={{ maxWidth: '800px', margin: '20px auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '16px' }}>
        <h3>📝 Your Notes</h3>
        <button className="btn btn-primary" onClick={() => { setEditingNote(null); setShowModal(true); }}>+ New Note</button>
      </div>

      {notes.length === 0 ? (
        <div className="empty-state">
          <p>No notes yet. Click "+ New Note" to get started!</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '12px' }}>
          {notes.map(note => (
            <div key={note.id} style={{ background: '#fff', border: '1px solid #e2e4ea', borderRadius: '8px', padding: '16px' }}>
              <h4 style={{ margin: '0 0 8px 0' }}>{note.title}</h4>
              <p style={{ color: '#6b7080', fontSize: '14px', whiteSpace: 'pre-wrap' }}>{note.content}</p>
              <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                <button className="btn btn-sm btn-ghost" onClick={() => { setEditingNote(note); setShowModal(true); }}>Edit</button>
                <button className="btn btn-sm btn-danger" onClick={() => handleDelete(note.id)}>×</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <NoteForm note={editingNote} onSave={handleSave} onClose={() => setShowModal(false)} />
      )}
    </div>
  );
}
function NoteForm({ note, onSave, onClose }) {
  const [title, setTitle] = useState(note?.title || '');
  const [content, setContent] = useState(note?.content || '');

  function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim()) return alert('Title is required');
    onSave({ id: note?.id, title, content });
  }

  return (
    <div className="modal-overlay active" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{note ? 'Edit Note' : 'New Note'}</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Title</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Content</label>
            <textarea rows={6} value={content} onChange={(e) => setContent(e.target.value)} />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">{note ? 'Update' : 'Create'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
