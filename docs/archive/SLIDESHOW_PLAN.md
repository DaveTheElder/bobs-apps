# Photo Slideshow App — Plan

Status: APPROVED DIRECTION (Dave, 9/23; revised same day — **standalone link, not launcher**). Backend Phase 1 COMPLETE in bobs-apps (`src/routes/slideshows.js`, 22 tests in `npm test`). Frontend ships as its own repo → `http://192.168.0.222/pages/slideshow/` is the link she gets. Next: scaffold frontend repo, Phase 2 editor UI.
Owner: Bob (build), Dave (approval)
Related: DOCUMENT_REPO_PLAN.md (upload pattern this reuses), IMPROVEMENT_PLAN.md

## Locked decisions (answer the Open Questions; these supersede anything later in this doc)

1. **YouTube only for now.** No Spotify driver, no OAuth plumbing, no config flags — the `AudioDriver` seam stays so Spotify can arrive someday, but nothing Spotify-shaped ships.
2. **Playback target: laptop on HDMI.** Fullscreen API + one-click gesture works exactly as ADR-2 describes; no Android TV / D-pad / Safari-quirk fight in Phase 3. Player is keyboard-friendly (space = pause, arrows = prev/next) since the laptop has one.
3. **Tens of photos on a loop.** Loop mode graduates to **P0** (`loop` column, player restarts show + playlist at the end). Server-side downscale stays out: client re-encodes uploads through canvas (also kills HEIC — iPhone camera roll otherwise uploads JPEG-in-name-only), and tens of files can't fill the volume.

---

## Overview

A slideshow app for Dave's wife: create a show, upload photos from her phone
or laptop, attach a music playlist from YouTube or Spotify, and press play —
ideally on the living-room TV. Ships as a new module inside bobs-apps
(SPA route + Express routes), not a separate repo/service.

One sentence: **photos are ours to store; audio is always someone else's iframe.**
We never host, proxy, or transcode audio. That keeps ToS clean and the backend boring.

---

## Goals / Non-Goals

**Goals**
1. G1: Create/edit/delete multiple named slideshows that persist across sessions.
2. G2: Upload photos from phone (Safari + Chrome) and desktop; drag to reorder.
3. G3: Attach music by pasting a YouTube URL or playlist URL — playback starts with the same click that starts the show.
4. G4: Slide advance on a per-show timer, optionally on track change ("one slide per song").
5. G5: Fullscreen TV-friendly player (big touch targets, auto-advance, no editor chrome).

**Non-Goals**
1. NG1: No accounts/auth. LAN-only app, same trust model as the rest of bobs-apps.
2. NG2: No user-uploaded audio files, no streaming proxies, no YouTube/Spotify download. Iframes only.
3. NG3: No frame-level audio sync (karaoke-style lyric timing, "show photo X at 0:47"). Spotify's developer terms explicitly prohibit synchronizing their content to external timelines; we won't get cute about it.
4. NG4: No mobile-native app. Player is a web page you open on whatever screen has an HDMI or a browser.
5. NG5: No video clips in slides, no collaborative editing, no public share links (password-gated guest viewing is P2 at most).

---

## Personas & journeys

**Wife (primary).** Opens bobs-apps on her phone → Slideshows → "New show" →
selects 40 photos from her camera roll (multi-select works in iOS/Android file
pickers) → pastes a YouTube playlist link → sets 5 s per slide, crossfade on →
names it "Emma's Birthday". Later, taps the show on the TV browser, hits ▶, app
goes fullscreen, music and photos run unattended.

**Dave (secondary).** Fixes the order from a real keyboard, deletes bad shots,
changes duration once instead of per-photo. Also the person who reboots the
container when I break it.

---

## The hard part: music integration

This is where the app lives or dies, so the plan starts here.

### Options compared

| Option | What it proves | Take / reject |
|---|---|---|
| YouTube IFrame Player API (`youtube.com/embed/<id>` + `listType=list`) | Full JS control without any account, key, or OAuth: load playlist, `playVideo()`, and — the part we need — `onStateChange` fires `ENDED` per track. Autoplay with sound requires a user gesture; our ▶ button IS that gesture (calling `playVideo()` inside a click handler is allowed, unmuted). | **TAKE for MVP.** Zero credentials, works free-tier, playlist-native, event-driven slide advance for free. |
| Spotify Web Playback SDK + Web API | Browser becomes a Spotify Connect device; total playback control via OAuth + PKCE. | **Premium-only** (full Premium — Lite/Mobile plans don't count), needs app registration and a redirect URI on the Caddy host. Take as P1 *if* wife has full Premium; it's the only way to get track-change events from Spotify. |
| Spotify bare embed iframe (`open.spotify.com/embed/playlist/<id>`) | Renders a mini player, no auth at all. | Playback starts only on user click inside Spotify's own UI (two clicks to start a show), full tracks still need Premium, and the postMessage API gives limited control — enough to *see* the track change, clunky to drive playback programmatically. Fallback for non-Premium Spotify: music plays in its own widget, slideshow runs on timer beside it. |
| Local audio files (wife MP3s via our server) | Trivially syncable. | Rejected from MVP as a *music source* — but note this is the ONLY path where sync rules are fully ours. If YouTube embeds annoy us later, `<audio>` + local files is the escape hatch; keep the player's audio layer behind one interface so it stays swappable. |
| yt-dlp / stream extraction | People do it. | Rejected: ToS violation and a maintenance tar pit. Not happening. |

### ADR-1: Audio = pluggable driver, YouTube driver ships first

**Decision.** Player talks to an `AudioDriver` interface (`load(source)`,
`play()`, `next()`, `onTrackEnd(cb)`, `setVolume(v)`). MVP implements it with
the YouTube IFrame API. Spotify drivers slot in later without touching the
slideshow engine.

**Why.** The two providers have opposite capability profiles (YT: free, no auth,
great JS API; Spotify: auth + Premium gate, worse iframe). Sharing one seam
means neither decision is permanent.

**Rejected:** building directly against YT calls everywhere — then a Spotify
change becomes a rewrite. **Consequences:** tiny interface tax up front; we
own whichever driver breaks when Google churns the embed (they rarely do).

### ADR-2: Start with one gesture, autoplay everything after

Browsers block unmuted autoplay until user interaction; iOS is strictest. The
▶ "Play show" button click gives us the gesture budget for the session — from
there YouTube plays unmuted and slides tick on timers without further taps.
Design consequence: **the player always begins at a visible ▶ screen** (also
doubles as the TV "press play with me" moment). No pretending we can autoplay
from a cold page load; that's fighting platform policy and losing.

### ADR-3: Sync model = timer primary, track-change optional

Default per-show mode `timed`: each slide shows N seconds (per-slide override),
music runs independently. Mode `track` : advance on driver `onTrackEnd`.
Per-track sync is fine (advancing a photo at a song boundary isn't the kind of
"synchronization" Spotify's terms prohibit — but we deliberately stop there,
see NG3). Iframe hiccups must never stall the show: slide timer and audio are
loosely coupled; losing audio mid-show logs to console and keeps advancing photos.

---

## Architecture (revised: standalone frontend, shared backend)

**Why not a separate service:** photos need a server that receives uploads and a data volume that survives rebuilds — bobs-apps has both, same host. **Why standalone frontend:** Dave wants one link for his wife; `/pages/<repo>/` gives it for free with zero Caddy edits. The launcher tile was removed from the registry seed.

```
┌──────────────────────────────────────────────────────────────┐
│  repo: slideshow  →  Forgejo Pages  →  /pages/slideshow/     │
│  Vanilla ES modules, NO build step (source == deployable;    │
│  publish = push static files to the `pages` branch).         │
│  Hash routing — no SPA fallback needed, routes live in '#'.  │
│  ├── Library screen   #/            grid of shows            │
│  ├── Editor           #/edit/<id>   upload/reorder/music     │
│  └── Player           #/play/<id>   fullscreen, YT driver    │
├──────────────────────────────────────────────────────────────┤
│  Backend — src/routes/slideshows.js, mounted in server.js     │
│  GET    /api/slideshows                  list                 │
│  POST   /api/slideshows                  create (JSON meta)   │
│  GET/PATCH/DELETE /api/slideshows/:id    read/update/delete   │
│  PUT    /api/slideshows/:id/order        reorder photos       │
│  POST   /api/slideshows/:id/photos       raw-bytes upload     │
│  DELETE /api/slideshows/photos/:pid      remove one photo     │
│  GET    /api/slideshow-photos/:filename  serve inline (img)   │
├──────────────────────────────────────────────────────────────┤
│  Storage on existing volume — zero new Caddy routes:          │
│  bobs-apps.db: slideshows, slideshow_photos                   │
│  /data/slideshow-photos/<uuid>.<ext>                          │
└──────────────────────────────────────────────────────────────┘
```

Everything rides the existing `/api/*` Caddy route and the `bobs-apps:8080`
container. No compose or Caddyfile edits — deliberate, that's where the pain is.

**Upload reuses the docs.js pattern verbatim**: raw request body, Content-Type
whitelist (`image/jpeg|png|webp|gif`), mid-stream size cap (50 MB/photo like
docs; per-show total cap 1 GB), server names files `<uuid>.<ext>` so nothing
path-escapes or collides. EXIF rotation: modern browsers honor
`image-orientation: from-image`, and we additionally bake orientation in on
upload with the browser's own `createImageBitmap(..., {imageOrientation:'from-image'})`
canvas re-encode before upload — server side stays pixel-blind (no sharp dep).

### Schema (add to src/db.js as new CREATEs; no ALTERs on existing tables)

```sql
CREATE TABLE IF NOT EXISTS slideshows (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    music_source TEXT DEFAULT 'youtube' CHECK(music_source IN ('youtube','spotify','none')),
    music_url TEXT DEFAULT '',            -- canonical URL; driver parses ID/playlist
    mode TEXT DEFAULT 'timed' CHECK(mode IN ('timed','track')),
    per_slide_seconds INTEGER DEFAULT 5,
    transition TEXT DEFAULT 'crossfade',   -- crossfade | cut | kenburns
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS slideshow_photos (
    id TEXT PRIMARY KEY,
    slideshow_id TEXT NOT NULL REFERENCES slideshows(id) ON DELETE CASCADE,
    filename TEXT NOT NULL UNIQUE,        -- <uuid>.<ext> on disk
    caption TEXT DEFAULT '',
    position INTEGER NOT NULL,
    duration_override REAL,               -- NULL → show default
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_slideshows_created ON slideshows(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sphotos_show ON slideshow_photos(slideshow_id, position);
```

Reorder = one `PUT /order` with the new id array in a transaction. Deleting a
photo deletes its row and unlinks the file (row first; orphaned files are
log-spam, not corruption).

### Player engine (the only genuinely stateful client code)

Plain state machine: `idle → playing ⇄ paused → done`. A single `setTimeout`
drives slide advance in `timed`; driver `onTrackEnd` advances in `track` mode.
Fullscreen via the Fullscreen API on the ▶ click (same gesture budget as audio).
Preload next image with `new Image()` so crossfades never flash empty. YouTube
iframe stays mounted at z-index 0, sized off-screen-but-rendered (display:none
pauses some mobile browsers); a mute/volume control rides in the player corner.

---

## Requirements

**Photos** — P0 upload multi-select from phone/desktop, jpg/png/webp/gif; server-side naming + validation; grid view with delete; drag-reorder persists. P1 captions overlay (bottom gradient). P2 auto-advance thumbnails via lazy `loading="lazy"` gallery pagination >200 photos.
**Shows** — P0 CRUD, title required, empty-show guard on play ("add photos first", not a blank fullscreen). P1 duplicate show.
**Music** — P0 paste YouTube watch/playlist/share link → parsed and previewed ("▶ test"); player plays playlist from ▶ click; volume + skip-track + next-slide controls in player; music optional (silent slideshow legal). P1 Spotify via bare embed (two-click start, documented as such); track-change mode for YouTube playlists. P2 Spotify Web Playback SDK driver behind config flags (`SPOTIFY_CLIENT_ID/SECRET`, PKCE) — only if full Premium confirmed.
**Player** — P0 fullscreen on ▶ click, crossfade + cut transitions, pause/resume, exit-to-library; survives phone screen-lock mid-show (audio pauses by policy; resume button restores). P1 Ken Burns. P2 sleep-timer / loop show.

## NFRs (concrete)

| Item | Number |
|---|---|
| Photo upload cap | 50 MB/file, 1 GB/show, server-enforced mid-stream |
| Player memory | ≤ ~40 full-res images resident on a 4 GB Android TV box at 300 photos (LRU: keep current + preloaded next + 2 trailing) |
| Slide advance jank | < 50 ms dropped frames on crossfade, 1080p JPEGs ≤ 6 MB, wired-LAN laptop class hardware |
| Photo first-paint over LAN | p95 < 300 ms for a 4 MB photo from `/api/slideshow-photos/` (LAN, warmed FS cache) |
| Data loss bound on crash mid-upload | that one photo; show metadata is committed independently |

---

## Phases (each one ships something wife can use)

**Phase 1 — Backend.** `src/routes/slideshows.js` + schema + tests
(`tests/test_slideshows.js`, same harness as test_api.js: CRUD, reorder,
upload happy path, bad Content-Type → 400, oversize → stream abort, delete
unlinks file). Wire `SLIDESHOW_PHOTOS_DIR` next to DOCS_DIR.
**Phase 2 — Editor.** Library + editor screens; upload grid (sequential fetch
of raw bytes with progress), reorder, music URL field with parse preview.
**Phase 3 — Player.** YT driver, timed mode, fullscreen, crossfade/cut, volume.
**→ this is the MVP acceptance test:** *on a phone browser, create a 20-photo
show with a real YouTube playlist; on the TV browser, hit ▶ once and watch all
20 photos advance to music without another tap.*
**Phase 4 — Track mode + Spotify embed fallback.** **Phase 5 (conditional) —
Spotify Web Playback SDK if Premium.**

Deploy per phase = the existing ritual: tests → `npm run build` →
`scripts/publish_pages.sh` for SPA; backend by Dave via
`git pull --ff-only && docker compose build bobs-apps && docker compose up -d bobs-apps`.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| YouTube embed refuses to play (kids-flagged videos, embed-disabled uploads) — a playlist dies mid-show | Driver surfaces `onError` → toast "track unavailable", auto-skip to next; show never stalls on audio |
| iOS Safari kills background audio when phone locks | Documented behavior; player is TV/tablet-first, phone is the remote/editor. Resume button exists for this exact moment |
| Playlist permdeleted/privated between edit and show day | Resolve playlist title + track count at load; clear error state with "re-paste link" affordance |
| Spotify ToS drift on embed capabilities | Driver seam (ADR-1); worst case Spotify drops to "timer mode only, music widget plays itself" |
| 300 iPhone photos ≈ 60–90 GB of originals someday | Per-show byte budget enforced at upload; P2 server-side downscale requires revisiting the no-sharp decision — flag, don't preempt |

## Open Questions — answers change the architecture, so

1. **Does your wife have full Spotify Premium** (not mobile-only)? Yes → Web Playback SDK is a real P1 with full control. No → Spotify means "embed widget + timer-mode slideshow", and YouTube carries the dream features. This is the one that decides whether OAuth plumbing exists at all.
2. **TV playback target**: laptop-on-HDMI, an old Android TV box, or the Apple TV/Safari thing you've got? Determines how hard I fight with fullscreen/autoplay quirks in Phase 3 (Android TV wants a D-pad-friendly UI; Safari is the strict one).
3. **Photo scale: tens or hundreds per show, and keep originals?** If "hundreds + phone photos", I'd pull the P2 thumbnail/downscale work into Phase 1 as browser-side canvas downscale-on-upload — that's cheap now, annoying to retrofit after a year of 8 MB uploads eating the data volume.
