/**
 * frontend/src/apps/DeskTab.jsx — Newsroom Desk: reporter roster + per-beat chat.
 *
 * Contract: standalone component fetching /api/news/beats (roster with runs/
 * leads/memories) and /api/news/beats/:beat/messages (chat transcript). The
 * POST returns the reporter's answer inline (the route blocks on one model
 * call), so no polling is needed for the send path; a background poll every
 * 30s picks up messages from other tabs while the pane sits open.
 * Visual skin: reuses newsroom.css tokens (scoped under .desk-* classes).
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch, apiJSON } from '../api';

// ── §1: Roster ───────────────────────────────────────────────────────

function ReporterCard({ desk, active, onClick }) {
  return (
    <button className={`desk-card${active ? ' desk-card-active' : ''}`} onClick={onClick}>
      <span className="desk-card-name">🗞 {desk.name}</span>
      <span className="desk-card-beat">{desk.beat}</span>
      <span className="desk-card-meta">
        {desk.last_run ? `${desk.last_run.n_leads} leads` : 'no runs yet'}
        {desk.open_threads ? ` · ${desk.open_threads} threads` : ''}
      </span>
    </button>
  );
}

// ── §2: Chat pane ────────────────────────────────────────────────────

function ChatPane({ desk }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const logRef = useRef(null);
  const cursor = '';   // always load full history on beat switch (transcripts are short)

  const load = useCallback(async (replace) => {
    try {
      const data = await apiJSON(`/api/news/beats/${desk.beat}/messages`);
      setMessages(prev => replace ? data.messages : mergeById(prev, data.messages));
    } catch (e) { /* keep last good transcript; a flaky read isn't worth a red pane */ }
  }, [desk.beat]);

  useEffect(() => { setMessages([]); load(true); }, [load]);

  // Poll for messages arriving elsewhere while the pane is open.
  useEffect(() => {
    const t = setInterval(() => load(false), 30000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages]);

  async function send(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true); setError('');
    // Optimistic echo so typing feels answered instantly; server copy replaces it.
    const local = { id: `local-${Date.now()}`, role: 'editor', text, created_at: new Date().toISOString() };
    setMessages(prev => [...prev, local]);
    setDraft('');
    try {
      const res = await apiFetch(`/api/news/beats/${desk.beat}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'send failed');
      setMessages(prev => prev.filter(m => m.id !== local.id)
        .concat([data.editor, data.beat]).sort(byTime));
    } catch (err) {
      setError(err.message);
      setMessages(prev => prev.filter(m => m.id !== local.id));
      setDraft(text); // don't lose the editor's words to a transport hiccup
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="desk-chat">
      <div className="desk-chat-head">
        <strong>{desk.name}</strong>
        <span>{desk.beat} · {desk.memories?.length || 0} standing notes</span>
      </div>
      <div className="desk-log" ref={logRef}>
        {messages.length === 0 && (
          <p className="desk-empty">No correspondence yet. Ask {desk.name} about the beat, or give a standing instruction.</p>
        )}
        {messages.map(m => (
          <div key={m.id} className={`desk-msg desk-msg-${m.role}`}>
            <div className="desk-msg-who">{m.role === 'editor' ? 'Editor' : desk.name}</div>
            <div className="desk-msg-text">{m.text}</div>
          </div>
        ))}
        {sending && <div className="desk-msg desk-msg-pending"><em>{desk.name} is typing…</em></div>}
      </div>
      {error && <div className="desk-error">{error}</div>}
      <form className="desk-compose" onSubmit={send}>
        <input type="text" value={draft} onChange={(e) => setDraft(e.target.value)}
          placeholder={`Tell ${desk.name} something…`} maxLength={2000} />
        <button type="submit" disabled={sending || !draft.trim()}>
          {sending ? 'Filing…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

// ── §3: Tab shell ────────────────────────────────────────────────────

export default function DeskTab() {
  const [desks, setDesks] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    apiJSON('/api/news/beats')
      .then(d => { if (!cancelled) { setDesks(d.beats || []); if (d.beats?.length) setSelected(d.beats[0].beat); } })
      .catch(e => { if (!cancelled) setError(e.message || 'Desk unavailable'); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <div className="desk-wrap"><p className="desk-error">{error}</p></div>;
  if (!desks) return <div className="desk-wrap"><p className="desk-empty">Opening the desk…</p></div>;
  if (desks.length === 0) return (
    <div className="desk-wrap"><p className="desk-empty">
      No reporters on staff yet — the beat desk files its roster with the 5:15am run.
    </p></div>
  );

  const active = desks.find(d => d.beat === selected);
  return (
    <div className="desk-wrap">
      <div className="desk-roster">
        {desks.map(d => (
          <ReporterCard key={d.beat} desk={d} active={d.beat === selected}
            onClick={() => setSelected(d.beat)} />
        ))}
      </div>
      {active && <ChatPane desk={active} key={active.beat} />}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────

function byTime(a, b) {
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1
    : (a.id < b.id ? -1 : 1);
}

function mergeById(oldList, fresh) {
  const map = new Map(oldList.map(m => [m.id, m]));
  for (const m of fresh) map.set(m.id, m);
  return [...map.values()].sort(byTime);
}
