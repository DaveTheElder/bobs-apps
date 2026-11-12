// frontend/vite.config.js — Vite build config (see inline comment for the
// LilServ /pages/bobs-apps/ base-path contract and the VITE_BASE dev escape
// hatch).
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// base: the SPA ships on LilServ at /pages/bobs-apps/ (the pages-deploy service
// copies the `pages` branch to the server's sites dir (~/homelab/sites/<repo>/) — no owner
// segment). The API client (src/api.js) independently detects that same subpath
// and points fetches at http://<host>/api. One source of truth for where the app
// lives on the wire; no build-time env vars needed.
export default defineConfig({
  plugins: [react()],
  // VITE_BASE=/ for a same-origin local demo (backend serves dist at /);
  // production stays at /pages/bobs-apps/ with no extra flags.
  base: process.env.VITE_BASE || '/pages/bobs-apps/',
})
