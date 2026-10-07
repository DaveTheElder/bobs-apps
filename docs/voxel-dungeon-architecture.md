# Voxel Dungeon System — Architecture Research & Proposal

**Status:** Draft v1 for review · **Owner:** Bob · **Related:** [voxel-dungeon-requirements.md](./voxel-dungeon-requirements.md)

This doc surveys the prior art, walks through the load-bearing decisions, compares
three candidate architectures, and recommends one with an ADR-style writeup per
decision. Requirement IDs (ED-x, PL-x, NF-x) reference the requirements doc.

---

## 1. Prior Art — what already exists and what to steal

| System | What it proves | What we take / reject |
|---|---|---|
| **Roll20 / Foundry VTT** | Browser VTT pattern works: SPA + WebSocket/Sockets.io room, GM-authoritative state, layers forFoW/dynamic lighting. Foundry's self-host pain (world dies when host's laptop sleeps) is exactly what NF-11 exists to avoid. | Take: per-player visibility filtering, bright/dim light bands, "reveal as token moves" FoW. Reject: client-moddable plugin runtime (scope), GM machine as server. |
| **Dungeon Scrawl** (now Roll20-owned) | Fast 2D dungeon sketching is a *solved UX* — drag room stamps, instant walls. Beloved because it's minutes-not-hours. | Take: stamp/part-first editing mindset (ED-2). Reject: PNG-only output — flat images can't carry verticality or semantics. |
| **MagicaVoxel `.vox`** | De-facto interchange format for voxel models; trivially simple chunked binary (`SIZE`/`XYZI`/`RGBA`, 256-palette, RIFF-ish). Well-documented (ephtracy spec, Paul Bourke). | Take: import/export target for props (ED-9). Reject as *native* format: 8-bit coords per model, no semantics, no chunk streaming — wrong shape for a live world. |
| **buildingblock** (chh-ay) and similar browser voxel sandboxes | three.js + greedy-meshed 32³ chunks + worker meshing achieves interactive editing in-browser; palette-compressed storage; even zero-server P2P collab via WebRTC works at small scale. | Take: chunk + greedy mesher + worker pool architecture wholesale (the single most valuable pattern we found). Reject P2P-only for *play* mode — play needs server authority for hidden info (NF-8). |
| **ChainVoxel / list-CRDT 3D editing research** | Voxel-set edits can be made commutative (add-wins/LWW tombstones), so concurrent modeling converges without central ordering. | Take: the *insight* that per-voxel ops need little merge machinery. Reject full P2P CRDT for v1 — Figma-style server-authoritative LWW gets 95% of it with far less math (see ADR-4). |
| **Figma multiplayer** | The industry-settled answer: a *tree of objects with per-property last-writer-wins registers, ordered by one central server*; optimistic client edits reconciled on ack. Complexity only exists in decentralized CRDTs; a server makes it unnecessary. | Take as the sync model for both dungeon structure and session state (ADR-4). |
| **Colyseus / Nakama / PartyKit** | Room-based authoritative game servers with automatic state diffing exist off-the-shelf (MIT/Apache, self-hostable). Colyseus = Node rooms + schema-diffed sync; Nakama = heavier Go backend w/ matchmaking+social we don't need. | Shortlist Colyseus as the "buy" option in Option B below; keep transport abstracted either way. |
| **5e-database / SRD 5.1 (CC-BY-4.0)** | The complete rules corpus (spells, items, monsters) is legally usable machine-readable JSON under CC-BY with an attribution blurb. Foundry's dnd5e system (MIT) proves the data model. | Take: seed content from a vendored SRD dataset; license gate for C2 solved — but keep it in one `data/srd/` leaf so legal can grep it out. |

**Gap this product fills:** every VTT treats maps as *artwork you import*; every voxel
editor treats the world as *a model you sculpt*. Nobody we found merges "Dungeon Scrawl
speed" + "server-enforced 3D FoW/LOS at the table" in the browser.

---

## 2. Load-Bearing Decisions

### ADR-1 — Rendering: three.js, greedy-meshed chunks, meshing in workers

**Decision.** Voxel world stored as sparse palette-compressed chunks (recommend 32³);
each chunk rendered by a binary greedy mesher running in a worker pool; the main thread
only receives typed-array geometry via transferable buffers. Progressive WebGPU path
later behind a capability check; WebGL2 is the floor (NF-1).

**Why.** One mesh per cube dies at draw-call budget ~10k voxels (every hobby voxel
editor that skipped greedy meshing learns this twice). Greedy meshing on 32³ chunks
measures sub-millisecond per chunk in prior art, which makes *interactive* edits
feasible when remesh happens off-thread. Chunk-locality also scopes the blast radius:
one edit remeshes ≤ a handful of chunks (plus edge neighbors for face culling).

**Alternatives rejected.**
- *InstancedMesh per voxel* — fine for MagicaVoxel-scale models, wrong for 100k+ built dungeons; loses ambient occlusion & fused faces.
- *Babylon.js* — viable engine, smaller voxel community/patterns; three.js has the mindshare and prior art we can crib (see buildingblock). Either is fine; pick by team familiarity. Three.js wins on available reference implementations.
- *Custom WebGL/WebGPU from scratch* — this is a dungeon product, not a graphics portfolio.

**Consequences.** Chunk format + mesher become core IP-quality modules → they live in a
pure `packages/voxel-core` (no DOM, no three.js imports) so headless tests and the
server can both use it (NF-12).

### ADR-2 — World model: semantic parts layered on raw voxels

**Decision.** Two-tier world. Tier 1 is the voxel grid (what you see/mesh). Tier 2 is a
sparse entity/semantics layer co-indexed to grid coordinates: doors, stairs/ladders with
level links, light sources, spawn points, terrain tags, regions (rooms). Parts (ED-2)
are *parametric objects* that stamp voxels into tier 1 but stay editable as objects
until "baked."

**Why.** Play mode doesn't care about voxel color; it cares that (12,3,7) is a closed
door and (12,3,9) is up-stairs to level 2. Flat voxel grids force the engine to
re-derive semantics by heuristics — fragile. This is also where per-level dollhouse
view (ED-4) and pathing (PL-2) come from cheaply.

**Rejected.** Pure voxels + heuristics ("dark voxel = wall?"); scene-graph-only
approach with no grid (breaks the 5 ft tactical grid players expect).

### ADR-3 — Visibility: server computes per-player FoW/LOS; clients render what they're told

**Decision.** The room server owns an occlusion graph derived at build/save time from
semantics (walls, doors, floors/ceilings between levels) plus runtime state (open/closed
doors). On token move / door toggle / light change it recomputes visibility per affected
player: explored-region bitset (FoW memory, PL-3) + currently-visible region set with
light bands. Recompute is **region/graph-based (portal-ish regions), not per-ray voxel
traversal** — rooms are natural portal nodes; corridors are edges with occlusion masks.

**Why.** Per-recipient filtering is the *only* way hidden info stays hidden when the
server is also the sync engine (NF-8): monster tokens in a player's non-visible set are
simply never serialized into that client's delta. A graph over rooms keeps the recompute
in the NF-5 CPU budget; voxel raycasts stay on the *client* purely as eye-candy
(soft shadow edges), never as truth.

**Rejected.** Client-side FoW (the classic VTT mistake — everything ships to the browser
and a devtools wizard sees the ambush room); server raycasting every frame (CPU doom).

### ADR-4 — Sync: server-authoritative op-log with per-property LWW (Figma pattern), CRDT later if ever

**Decision.** Both editor and play mode sync via **operations through the server**:
client applies optimistic local echo, sends intent, server serializes per room, applies
(validator first), broadcasts diffs ordered by server seq. Conflict rule: per-voxel /
per-property last-writer-wins keyed on server order. Voxel add/remove is naturally
commutative at cell level; structural parts (moving a whole room while someone paints
it) use region leases only as a *soft* courtesy hint, not a lock.

**Why.** This is the Figma conclusion: with one server in the loop you don't need
vector clocks or Yjs's merge machinery — the server's sequence *is* the order. Full CRDT
(Yjs/Automerge) buys offline-first P2P we explicitly don't need for play (ADR-3 needs a
server anyway; split-brain editor state would desync from play state). Prior art
(collab-voxel with Yjs) proves CRDT voxel editing works but pays in payload size and
undo-history complexity for benefits outside our scope.

**Rejected.** OT (transform-matrix explosion, no benefit over LWW here); P2P WebRTC
authoritative editor (can't enforce visibility/roles; good demo, bad product spine).

**Migration path.** If local-first offline editing ever matters, the op-log we keep for
persistence is already replayable — a Yjs backend can be swapped under the same op
schema without touching UI. That's the insurance premium we're paying instead of buying
it up front.

### ADR-5 — Persistence: SQLite + chunk store + periodic checkpoint with op-log tail

**Decision.** One process, one disk layout: SQLite for accounts/campaigns/registry/chat/
dice log; content-addressed gzip/zstd chunk files (`worlds/<id>/<rev>/<chunk>.bin`) plus
a per-world append-only op-log. Checkpoint = compact new chunk snapshot every N ops or
T seconds (NF-7's ≤10 s), then truncate the log. Session runtime state (tokens, HP, FoW
bitsets) lives in SQLite rows updated on change-debounce; a crashed room reloads from
the last checkpoint + session rows and clients rejoin by room code.

**Why.** NF-3/NF-9/NF-11: homelab-viable single container (C3), no Postgres/Redis tax at
our scale, durability trivially verifiable (`kill -9`, restart, compare). Chunk files
give cheap versioning/forking (CM-4: copy the directory) and dedupe.

**Rejected.** Postgres+Redis+"scale later" stack — correct for 10⁵ CCU, absurd for a
game night; **Colyseus's default persistence model has the same crash-holes we need to
own anyway**, so persistence is ours regardless of ADR-6 outcome.

### ADR-6 — Transport & room server: hand-rolled WS rooms now, Colyseus as fallback if it stops being fun

**Decision.** Node/TypeScript monolith behind Caddy: `/api/*` REST (accounts, world CRUD)
+ one WebSocket endpoint per room carrying a small binary framed protocol
(`msgpack-lite` or length-prefixed JSON v0). Room = in-process actor with its own op-log
(ADR-4); reconnect token resumes membership. Transport abstracted behind an interface so
WebTransport (HTTP/3 datagrams — browser support is mainstream now, server ecosystem
isn't) can land later without touching game logic.

**Why.** Our room model is unusual: per-player *filtered* state deltas (ADR-3) are the
opposite of "broadcast schema-diffed room state to everyone," which is what Colyseus's
automatic sync optimizes for. We'd fight its state layer more than we'd use it, and the
pieces we'd keep (room lifecycle, presence) are ~a weekend. One process = one thing to
deploy on LilServ (C3). If matchmaking/lobby scale ever arrives, PartyKit/Colyseus is a
credible "buy" retrofit — protocol stays ours either way.

**Rejected.** Nakama (operational weight of Go+etcd+Postgres for 8-person rooms);
Socket.IO (abstraction tax over plain `ws` we don't need; Foundry pays this bill too).

### ADR-7 — Voice: WebRTC mesh via LiveKit SFU only if/when we take PL-8 seriously

**Decision.** MVP ships text chat. When voice lands, it's **LiveKit (self-hostable,
Apache-2.0, TURN included)** or an equivalent SFU container wired to the session service
via short-lived JWTs — not hand-rolled WebRTC mesh.

**Why.** Mesh is fine at 4 voices and a lie at 8 with NAT; every "we'll just do WebRTC"
project rediscovers TURN hosting. SFU also gates future features (GM whisper channels,
later video) for free. Keeping it as a separate container keeps the game room process
out of media plumbing.

### ADR-8 — Content & licensing: SRD 5.1 dataset vendored behind one gate

**Decision.** Seed rules data from SRD 5.1 (CC-BY-4.0, e.g. via the 5e-database JSON) in
`server/data/srd/` with a NOTICE file carrying the required attribution string; UI copy
says "fifth-edition compatible," never trademarked branding. Engine code MIT.

**Why.** C2/OQ answered preemptively: legal path exists and other projects (Foundry dnd5e,
CC-SRD conversions) proved it. The gate keeps auditors happy with one folder to inspect.

---

## 3. Three Candidate Architectures Compared

### Option A — Server-authoritative monolith (**recommended**)

```
┌──────────────── Browser (SPA: React + three.js) ────────────────┐
│ edit mode            play mode              shared             │
│ ├ stamp/part tools   ├ dollhouse cam 3D     ├ op-dispatch ws    │
│ ├ live cursors       ├ token/ping move      ├ local echo+undo   │
│ └ worker mesh pool   └ FoW/light overlay     └ chat/dice UI     │
└───────────── HTTPS/WSS (Caddy TLS) ────────────┬───────────────-┘
                                                 │
┌────────────────────────────────────────────────▼───────────────-┐
│ Node/TS container  (one compose service)                        │
│  api/        accounts, worlds, assets, share links              │
│  roomsrv/    room actor: op-log(LWW) → validate → apply → fan   │
│  visibility/ region graph: FoW bitsets + per-client delta filter│
│  rules/      pure fns: pathing, LOS assist, dice, initiative    │
│  persist/    SQLite + chunk store + checkpoint worker (ADR-5)   │
└───────┬───────────────────────────────-─────────────────────────┘
        │ (only when PL-8 ships)
   livekit container ── voice SFU, JWT from roomsrv
```

- ✅ Matches C3/NF-11: `docker compose up`, one data volume, checkpoint/restore story.
- ✅ Full control of per-client filtering (our differentiator).
- ⚠️ We own room lifecycle/reconnect code (~small, but ours).
- ⚠️ Single process per node; rooms are isolated actors so a bad mesher can't corrupt another table — scale-out later shards *rooms across processes*, not rewrites anything.

### Option B — Colyseus rooms + custom state layer

- ✅ Off-the-shelf room lifecycle, presence, matchmaking primitives.
- ❌ Its headline feature (auto-synced shared room state) is the part we can't use unfiltered; fighting it for per-player deltas costs more than A's hand-rolled ws loop.
- Verdict: keep as fallback if roomsrv balloons; interface seams (ADR-6 transport, ADR-5 persistence external to server) preserve that option.

### Option C — P2P/WebRTC-mesh editor-first (the "no backend" seductive wrong turn)

- ✅ Zero hosting for building together; genuinely elegant demo (buildingblock ships it).
- ❌ Play mode needs an untrusted-party referee: hidden state, dice integrity, persistence when the GM's laptop closes. You end up bolting on a server and now you have two sync models.
- Verdict: steal its tricks (worker meshing, gzipped URL share codes for read-only dungeon links) — reject as spine.

---

## 4. Recommended Stack Summary

| Layer | Pick | Notes |
|---|---|---|
| Renderer | three.js (WebGL2 floor, WebGPU opt-in) + custom greedy mesher in worker pool | ADR-1; mesher in framework-free package |
| World storage | 32³ palette-compressed chunks, zstd; chunk dir per world revision | `.vox`/glTF import-export at the edges (ED-9) |
| Semantics | sparse entity index keyed to grid coords + level graph | ADR-2 |
| Sync | ws binary frames; server seq order; optimistic echo; per-property LWW | ADR-4 |
| Visibility | region-graph recompute on events; per-client serializer filters entities/FoW | ADR-3 |
| Backend | Node 20+/TS, Fastify (REST) + `ws`; single container behind Caddy | fits bobs-apps homelab pattern exactly |
| Data | SQLite (better-sqlite3) + chunk files; checkpoint+op-log | ADR-5; tests pin migration order like src/db.js lesson |
| Voice | LiveKit SFU container, phase 2 | ADR-7 |
| Rules data | vendored SRD 5.1 JSON, CC-BY attribution NOTICE | ADR-8 |
| Auth | email+password (argon2id), session cookies; join-links carry single-use invite codes for anonymous players | NF-8 |

## 5. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Region-graph FoW mispredicts on weird geometry (floating rooms, bridges) | Players see/hear things; immersion, rule number one breaker | Conservative graph edges (assume occluded); GM manual reveal/hide as escape hatch day one (PL-3); client LOS is cosmetic only |
| Greedy mesh + worker pool jank on low-end GPUs | NF-6 fails for half the audience | Chunk-of-work budgeting, quality slider (render distance, AO off), dollhouse culling above/below party level |
| Editor op-log churn during stamp-drag (10k voxel ops) | Bandwidth/log bloat | Batch strokes client-side into one `StampPart`/`BoxFill` macro-op before send; per-voxel ops are the fallback, not the default |
| Undo semantics across LWW merges (my stroke partially overwritten) | "You lost my work" bug class | Per-user undo of *own* ops replayed against current state; document that co-edit undo is local-only (Figma does exactly this and survives) |
| Scope creep toward full 5e automation | Never ship | NG2 + MVP cut in requirements §7 is the law; rules module stays "dice + math," GM adjudicates |

## 6. Suggested Milestones (post-approval, no work started yet)

1. **M0 spike:** headless `voxel-core` — chunk store, greedy mesher, golden-file tests; browser demo loading a test dungeon at 60 fps. Proves ADR-1 with numbers.
2. **M1 editor:** stamp parts + paint + save/fork (ED-1..4 solo); single-builder ws sync.
3. **M2 table:** join link, tokens+pathing, region FoW, dice/chat (PL-1..5) → *this is the MVP gate (§7 acceptance test).*
4. **M3 persistence hardening:** checkpoint/crash-recovery drill + campaign registry (CM-1/2, NF-7).
5. **M4 collab build + semantics** (ED-5/6), then voice decision per OQ-1.

## 7. References

- ephtracy MagicaVoxel `.vox` format spec; Paul Bourke vox notes — interchange target
- buildingblock (chh-ay): three.js greedy-meshed collaborative voxel sandbox, worker meshing patterns
- Figma multiplayer engineering write-ups: server-ordered per-property LWW registers
- ChainVoxel paper (IEEE/ACM) + list-CRDT 3D editing literature — commutative voxel ops exist if we ever need P2P
- collab-voxel (Yjs+three.js) — proof CRDT voxel editors work, and payload cost of that choice
- Foundry VTT lighting/FoW docs; Roll20 Advanced FoW docs — product parity checklist for PL-3/PL-4
- Colyseus vs Nakama comparisons; Figma-vs-Yjs production pattern surveys (server-authoritative LWW dominance 2022→)
- SRD 5.1 CC-BY-4.0: dnd.wizards.com SRD page, 5e-bits/5e-database, Tabyltop/CC-SRD
