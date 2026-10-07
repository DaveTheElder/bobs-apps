import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// base: the SPA ships on LilServ at /pages/bobs-apps/ (the pages-deploy service
// copies the `pages` branch to /home/chimera/homelab/sites/<repo>/ — no owner
// segment). The API client (src/api.js) independently detects that same subpath
// and points fetches at http://<host>/api. One source of truth for where the app
// lives on the wire; no build-time env vars needed.
export default defineConfig({
  plugins: [react()],
  base: '/pages/bobs-apps/',
})
