// src/api.js — single API client for the whole frontend.
// Why: 16 absolute '/api/...' URLs were scattered across 7 components; deploying
// under /pages/bobs-apps/ would have broken every one of them. Everything now
// goes through apiFetch(), and the base is resolved in ONE place, at runtime —
// no build-time env magic needed.
//
// Base resolution (first hit wins):
//   1. window.__BOBS_API_BASE__ — explicit override (escape hatch / tests).
//   2. We're served from under /pages/<anything>/  → API is same-origin on :80
//      (Caddy routes /api/* to the backend container).
//   3. Same-origin relative '' — standalone :8080 deployment where Express
//      serves both SPA and API from one origin.

function apiBase() {
  try {
    if (typeof window !== 'undefined' && window.__BOBS_API_BASE__) return window.__BOBS_API_BASE__;
    if (typeof location !== 'undefined') {
      // Host-only base: every caller passes '/api/...' paths already, so the
      // base must NOT end in /api (that produced /api/api/apps → 404). Pages and
      // API share origin :80 behind Caddy, so a protocol-relative host is enough.
      const m = location.pathname.match(/^\/pages\/[^/]+\//);
      if (m) return `${location.protocol}//${location.host}`;
    }
  } catch {}
  return '/';
}

// path is like '/docs/123' or '/downloads/file.pdf' — must start with '/'.
export async function apiFetch(path, options = {}) {
  const url = (apiBase().replace(/\/$/, '')) + path;
  return await fetch(url, options);
}

// Convenience: JSON in, JSON out. Throws Error carrying the server's message on !ok.
export async function apiJSON(path, options) {
  const res = await apiFetch(path, options);
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

export function apiUrl(path) {
  // For window.open / anchor hrefs (DB backup download, doc downloads).
  return apiBase().replace(/\/$/, '') + path;
}
