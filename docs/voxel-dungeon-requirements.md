# Voxel Dungeon System — Requirements

**Status:** Draft v1 for review · **Owner:** Bob · **Related:** [voxel-dungeon-architecture.md](./voxel-dungeon-architecture.md)

## 1. Problem Statement

Tabletop groups playing D&D-style games remotely today must duct-tape together
multiple tools: a VTT for the battle map (Roll20, Foundry), a separate map maker
(Dungeon Scrawl, DunGen) that exports flat PNGs, voice chat (Discord), dice, and
character sheets. Map-making is 2D, static, and done alone *before* the session —
nobody can collaboratively build or reshape a dungeon live at the table, and
verticality (multi-level dungeons, ceilings, chandeliers, pits) simply doesn't exist
on a flat battle map.

We want one system where a group can **build voxel dungeons together in-browser and
play campaigns in them live**, with real 3D line-of-sight, lighting, and fog of war
that the engine enforces instead of trusting the GM to remember.

## 2. Goals & Non-Goals

### Goals (G)
- **G1.** Zero-install: everything runs in a modern browser on desktop (client and GM tooling).
- **G2.** A GM (or party) can build a dungeon from palette parts in minutes, not hours — "Dungeon Scrawl speed, 3D payload."
- **G3.** Live multiplayer editing of the same dungeon with multiple builders, no file-locking.
- **G4.** A play mode where the server is authoritative over what each player can see (FoW, LOS, lighting).
- **G5.** Campaign persistence: worlds survive between sessions; players reconnect to their characters and progress.
- **G6.** Easy remote play for a 3–6 person group with commodity internet; self-hostable on homelab hardware.

### Non-Goals (NG)
- **NG1.** Not a general game engine or MMO-scale world (target ≤8 concurrent per session, rooms of ≤128³ voxels per level).
- **NG2.** Not a rules-lawyer simulator: dice and simple 5e-style checks yes; full automated spell/feature implementation no. The GM adjudicates edge cases.
- **NG3.** No native mobile client in v1 (view-only web fallback later at most).
- **NG4.** No licensed content. SRD 5.1 (CC-BY-4.0) only for rules data; no "D&D" branding in user-facing text beyond "compatible with fifth edition" phrasing per the CC-BY guidance.
- **NG5.** Not a single-player creative sandbox — every feature passes the "does this help a group play?" filter.

## 3. Personas & Core User Journeys

| Persona | Wants |
|---|---|
| **GM/Builder** | Build dungeons fast, prep encounters, run sessions with god-view + reveal tools |
| **Player** | See what their character sees, move a token, roll dice, talk to the party |
| **Co-builder** | Friend helping decorate the dungeon pre-session; no GM powers needed |
| **Observer** | Spectates an ongoing session read-only (bard-cam) |

Core journeys:
1. **Build**: create world → place rooms/stairs/doors from parts or draw-and-extrude → co-edit live → save version.
2. **Run**: open session → players join by link → tokens spawn → party explores (FoW lifts per-LOS) → combat with initiative + dice → session state saved.
3. **Return**: next week, same world; characters, explored FoW, and door states persist.

## 4. Functional Requirements

Priority: **P0** = playable demo without it we'd be embarrassed · **P1** = real-campaign quality · **P2** = later.

### 4.1 Editor (build mode)
- **ED-1 (P0)** Voxel placement/erase/paint on a grid; brush sizes; drag-to-fill walls & floors.
- **ED-2 (P0)** Part palette: procedural kit pieces (room, corridor segment, staircase, door, arch, column, pit) placed as parametric objects, auto-meshing into the world — not hand-placing every cube for a 40×40 room.
- **ED-3 (P0)** Save/load dungeon to server; fork/duplicate; named versions with restore.
- **ED-4 (P0)** Multi-level support: vertically stacked levels connected by stair/ladder links; per-level grid; player view can hide the ceiling and floors above ("dollhouse" camera).
- **ED-5 (P1)** Collaborative editing: multiple builders in the same dungeon simultaneously with live cursors and per-region edit grants.
- **ED-6 (P1)** Terrain semantics tags: floor, wall, door (open/closed/locked), pit, difficult ground, climbable — consumed by play mode for movement & LOS.
- **ED-7 (P1)** Encounter dressing in play mode: place tokens, props, lighting sources without touching geometry.
- **ED-8 (P2)** Procedural generation helpers (room-graph dungeon generator, cave noise) that emit editable parts; regenerate-with-seed.
- **ED-9 (P2)** Import `.vox` (MagicaVoxel) as prop models; export built dungeons to glTF for external tools.

### 4.2 Play mode (the table)
- **PL-1 (P0)** Join by link + one-time name; GM assigns tokens/characters; observer role.
- **PL-2 (P0)** Token movement: click-to-move with grid pathing, server-validates walkability (walls solid, doors respected); 5 ft square grid overlay.
- **PL-3 (P0)** Fog of war + exploration memory **per player**, computed by the server from token position; GM reveals/hides regions manually.
- **PL-4 (P0)** Line-of-sight in true 3D: walls, floors above, and closed doors occlude; light sources per token/prop with bright/dim radius honoring 5e darkvision-style bands.
- **PL-5 (P0)** Chat + dice roller (`/r 2d6+4`, advantage/disadvantage, private GM rolls) visible as floating combat text or chat.
- **PL-6 (P1)** Initiative tracker (order, next-up, condition tags); simple HP/resource bars on tokens.
- **PL-7 (P1)** Character sheets: 5e-style stat block from SRD data (abilities, skills, saves, inventory list); attack-roll buttons with modifiers; not an automation rabbit hole.
- **PL-8 (P1)** Voice chat in-session.
- **PL-9 (P2)** Trigger/automation hooks: door-open → spawn monster; region-entered → GM whisper ("you feel a draft").

### 4.3 Campaign & world management
- **CM-1 (P0)** Accounts, campaigns (a run of sessions against one world), party membership, roles (GM / player / co-builder / observer).
- **CM-2 (P0)** Session persistence: positions, HP, FoW state, door states, chat log, rolls — durable within ~10s.
- **CM-3 (P1)** Asset library per campaign: reusable parts, props, token images with upload quotas.
- **CM-4 (P1)** Share/export dungeon as a self-contained file; import from file.
- **CM-5 (P2)** Public module browser / community sharing of dungeons (opt-in, rate-limited).

### 4.4 Communication
- **CO-1 (P0)** Text chat with party channel and GM-only channel.
- **CO-2 (P1)** Voice: push-to-talk optional; reconnect must rejoin voice without page reload.
- **CO-3 (P2)** Integrated video later is an explicit non-goal for v1 — "bring your own Discord/Meet" is the honest interim, and CO-2 exists to remove that dependency.

## 5. Non-Functional Requirements

| ID | Requirement | Target / verification |
|---|---|---|
| NF-1 | Browser support | Latest evergreen Chrome/Firefox/Safari (last 2 majors); WebGL2 baseline, WebGPU progressive enhancement; no SharedArrayBuffer requirement (keeps hosting simple — COOP/COEP headers become optional, not mandatory) |
| NF-2 | Session size | ≤8 concurrent clients per session room; editor rooms ≤4 builders |
| NF-3 | World size | Target: 1 campaign level fits in a bounded voxel space; chunked storage so memory scales with *built* volume, not bounding box. Soft cap ~500k occupied voxels/level (editor warns past it) |
| NF-4 | Edit latency | Local echo ≤50 ms perceived; remote builder edits visible p95 < 250 ms on 100 ms RTT links |
| NF-5 | Play-mode sync | Token moves propagate p95 < 300 ms; FoW updates per player computed server-side, budgeted so a lighting/LOS recompute on one token move stays under ~50 ms of CPU (see ADR-3) |
| NF-6 | Framerate | ≥30 fps on integrated GPU (Iris Xe class) at typical built dungeon; 60 fps target on discrete. Greedy-meshed chunk rendering with worker-based remeshing so edits never stall the render thread |
| NF-7 | Persistence durability | Committed world/session state survives server restart; crash between checkpoints loses ≤10 s of edits (checkpoint + op-log, see ADR-5) |
| NF-8 | Security | Server-authoritative game truth: clients send intents only. Player-facing tokens must never carry hidden-state payloads (no leaking monster positions in shared state — visibility is per-recipient filtering). Standard web hygiene: argon2/bcrypt passwords, HTTPS/WSS only, CSRF on cookie auth, upload size/type limits, CSP on the SPA |
| NF-9 | Privacy | Accounts = email + password; no third-party analytics; homelab self-host first-class (single docker-compose up) |
| NF-10 | Asset budget | Initial page load ≤ 2 MB gzipped core bundle incl. render engine; world payloads compressed (palette-compressed chunks, zstd/gzip in transit) |
| NF-11 | Availability posture | Self-hosted single node is the product; a crashed session should auto-resume from checkpoint without manual DB surgery ("Foundry hosting pain" is the cautionary tale: if the host dies, players reconnect to the *server*, not to someone's laptop) |
| NF-12 | Testability | Rules math (LOS, pathing, dice, meshing) as pure modules unit-testable headless; protocol handlers testable without a browser |

## 6. Constraints & Assumptions

- **C1.** Build target is web-first (three.js-class stack), not Unity/Unreal — the "no download" requirement kills native engines for this product.
- **C2.** Rules content limited to SRD 5.1 under CC-BY-4.0 with required attribution ("This work includes material taken from the System Reference Document 5.1…"); branding stays generic ("fifth-edition compatible").
- **C3.** Self-hosting on consumer hardware (our homelab is the reference: single box, Docker, Caddy) must stay viable — rules out architectures that need Redis + Postgres + NATS + a Kubernetes sermon to run four friends.
- **A1.** Players have broadband (≥5 Mbps down). Voice is ~30 kbps/person; world payload for a typical dungeon should stay in the low single-digit MB.

## 7. MVP Scope Cut

**Playable demo (MVP) = ED-1..ED-4, PL-1..PL-5, CM-1..CM-2, CO-1 + NF-1/2/3/6/7/8.**
Everything else is post-MVP. The demo acceptance test: 1 GM + 3 players, one three-level dungeon built in under an hour from parts, session survives a server restart mid-fight, and no player sees the ambush room before they should.

## 8. Open Questions (for Dave)

- **OQ-1.** Voice in MVP vs "BYO Discord" for v0? (PL-8 is P1 by choice — voice is table stakes but plumbing-heavy.)
- **OQ-2.** Is co-editing *during the session* a real need, or is pre-session collaborative building enough? Changes how hard we push on CRDT machinery vs simple presence.
- **OQ-3.** Vertical scale: do we want full free-form voxel terrain (dig anywhere), or level-slabs with stair links? Level-slabs are cheaper to reason about for FoW/LOS and map 1:1 to "the dungeon has floors."
