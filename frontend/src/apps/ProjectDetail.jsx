// ProjectDetail.jsx — expandable phase/task panel for one Project Hub row.
// Inline forms only: window.prompt/confirm block CDP and are invisible on
// mobile (slideshow lesson, 2026-10), so every edit is a visible input or select.

import React, { useState } from 'react';
import { apiFetch } from '../api';

const TASK_CYCLE = { todo: 'doing', doing: 'done', done: 'blocked', blocked: 'todo' };

// Module scope on purpose: defining input subcomponents inside the parent
// remounts them on every keystroke and steals focus.
function TaskNote({ task, onSave, onCancel, disabled }) {
  const [text, setText] = useState(task.notes || '');
  return (
    <div className="task-note">
      <textarea
        autoFocus
        value={text}
        rows={2}
        placeholder="note: context, why it's blocked, links…"
        onChange={(e) => setText(e.target.value)}
      />
      <button className="btn btn-sm btn-primary" disabled={disabled} onClick={() => onSave(text)}>Save</button>
      <button className="btn btn-sm btn-ghost" onClick={onCancel}>Cancel</button>
    </div>
  );
}

/** Links ride the wire as `label|url[, label2|url2]`; each entry may carry a
 * third segment — `label|url|what it is`. Anything off the shape (or a
 * non-http scheme) is dropped — never hand untrusted strings to href. */
export function parseLinks(s) {
  return (s || '').split(',').map((part) => {
    const [label, url, ...rest] = part.trim().split('|');
    const ok = url && /^https?:\/\//i.test(url.trim());
    return ok ? {
      label: label.trim() || url.trim(),
      url: url.trim(),
      desc: rest.join(' ').trim(),
    } : null;
  }).filter(Boolean);
}

export default function ProjectDetail({ project, onChanged, onClose }) {
  const [newTask, setNewTask] = useState({});       // phaseId -> draft text
  const [newPhase, setNewPhase] = useState('');
  const [notes, setNotes] = useState(project.notes || '');
  const [notesDirty, setNotesDirty] = useState(false);
  const [openTask, setOpenTask] = useState(null);   // taskId with notes open
  const [busy, setBusy] = useState(false);
  const links = parseLinks(project.links);

  async function call(url, method, body) {
    setBusy(true);
    try {
      const res = await apiFetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error((await res.json()).error || `API ${res.status}`);
      await onChanged();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  const addPhase = () => {
    if (!newPhase.trim()) return;
    call(`/api/projects/${project.id}/phases`, 'POST', { name: newPhase.trim() });
    setNewPhase('');
  };
  const addTask = (phaseId) => {
    const text = (newTask[phaseId] || '').trim();
    if (!text) return;
    call(`/api/phases/${phaseId}/tasks`, 'POST', { title: text });
    setNewTask({ ...newTask, [phaseId]: '' });
  };

  const saveNotes = () => {
    const { id, name, description, status, priority, progress, deadline, owner, tags } = project;
    call(`/api/projects/${id}`, 'PUT', { name, description, status, priority, progress, deadline, owner, tags, notes });
    setNotesDirty(false);
  };

  const saveTaskNotes = (task, text) => {
    call(`/api/tasks/${task.id}`, 'PUT', { title: task.title, status: task.status, notes: text });
    setOpenTask(null);
  };

  return (
    <div className="phase-panel">
      {/* header always available: adding the first note shouldn't need a modal */}
      <div className="proj-head">
        {project.description && <div className="proj-desc">{project.description}</div>}
        {links.length > 0 && (
          <table className="links-table">
            <thead><tr><th>Link</th><th>Description</th></tr></thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.url}>
                  <td><a href={l.url} target="_blank" rel="noreferrer">{l.label}</a></td>
                  <td className="link-desc">{l.desc || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
          <textarea
            className="proj-notes"
            value={notes}
            placeholder="Project notes — state, blockers, context…"
            rows={3}
            onChange={(e) => { setNotes(e.target.value); setNotesDirty(true); }}
          />
          {notesDirty && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={saveNotes}>Save notes</button>
          )}
      </div>
      {project.phases.length === 0 && (
        <div className="phase-empty">No phases yet — add milestones (M0, M1…), then tasks under each.</div>
      )}
      {project.phases.map((phase, i) => (
        <div className="phase-block" key={phase.id}>
          <div className="phase-head">
            <span className={`badge badge-${phase.status === 'done' ? 'completed' : phase.status === 'active' ? 'in-progress' : phase.status === 'blocked' ? 'on-hold' : 'not-started'}`}>
              {phase.status}
            </span>
            <strong>{phase.name}</strong>
            <span className="phase-count">{phase.done_count || 0}/{phase.task_count || 0} tasks</span>
            <span className="phase-actions">
              <button className="btn btn-sm btn-ghost" disabled={busy || i === 0}
                onClick={() => call(`/api/phases/${phase.id}/move`, 'POST', { dir: 'up' })}>↑</button>
              <button className="btn btn-sm btn-ghost" disabled={busy || i === project.phases.length - 1}
                onClick={() => call(`/api/phases/${phase.id}/move`, 'POST', { dir: 'down' })}>↓</button>
              <select className="filter-select" value={phase.status} disabled={busy}
                onChange={(e) => call(`/api/phases/${phase.id}`, 'PUT', { name: phase.name, status: e.target.value })}>
                <option value="pending">pending</option>
                <option value="active">active</option>
                <option value="done">done</option>
                <option value="blocked">blocked</option>
              </select>
              <button className="btn btn-sm btn-danger" disabled={busy}
                onClick={() => call(`/api/phases/${phase.id}`, 'DELETE')}>×</button>
            </span>
          </div>
          <div className="task-list">
            {phase.tasks.map((task) => (
              <div className={`task-row task-${task.status}`} key={task.id}>
                <button
                  className={`task-check ${task.status === 'done' ? 'checked' : ''}`}
                  title="click to advance status"
                  disabled={busy}
                  onClick={() => call(`/api/tasks/${task.id}`, 'PUT',
                    { title: task.title, status: TASK_CYCLE[task.status] })}>
                  {task.status === 'done' ? '✓' : task.status === 'doing' ? '▶' : task.status === 'blocked' ? '⛔' : '○'}
                </button>
                <span className={`task-title ${task.status === 'done' ? 'strike' : ''}`}>{task.title}</span>
                <button
                  className={`btn btn-sm btn-ghost ${task.notes ? 'has-notes' : ''}`}
                  title={task.notes ? 'edit note' : 'add note'}
                  disabled={busy}
                  onClick={() => setOpenTask(openTask === task.id ? null : task.id)}>
                  📝
                </button>
                <button className="btn btn-sm btn-danger" disabled={busy}
                  onClick={() => call(`/api/tasks/${task.id}`, 'DELETE')}>×</button>
                {openTask === task.id && (
                  <TaskNote task={task} onSave={(t) => saveTaskNotes(task, t)}
                    onCancel={() => setOpenTask(null)} disabled={busy} />
                )}
              </div>
            ))}
            <div className="task-add">
              <input
                value={newTask[phase.id] || ''}
                placeholder="+ task (Enter)"
                disabled={busy}
                onChange={(e) => setNewTask({ ...newTask, [phase.id]: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && addTask(phase.id)}
              />
            </div>
          </div>
        </div>
      ))}
      <div className="phase-add">
        <input
          value={newPhase}
          placeholder="+ phase, e.g. M2: play mode (Enter)"
          disabled={busy}
          onChange={(e) => setNewPhase(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addPhase()}
        />
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={addPhase}>Add phase</button>
        <button className="btn btn-sm btn-ghost" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
