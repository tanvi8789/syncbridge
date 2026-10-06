# SyncBridge — Project Overview & Presentation Guide

> A desktop LAN peer-to-peer file transfer and folder synchronization platform,
> built to make the *networking protocol itself* visible and explainable.

This document is the single reference for understanding SyncBridge end to end:
what it does, what it is built with, how data moves through it, how the work is
split across four people for a presentation/demo, and what remains to be built.

---

## 1. What SyncBridge Is

SyncBridge lets two or more computers on the same local network find each other
automatically, connect directly to one another, and move files between them —
with no cloud service, no internet connection, and no account. Think AirDrop,
but cross-platform, open, and with the protocol exposed to the user.

Its distinguishing feature is **observability**: every step of the networking
stack (discovery broadcast → TCP handshake → metadata exchange → chunk transfer
→ checksum verification → completion) is emitted as a structured event,
correlated into a per-session timeline, and replayable in the UI. The project is
as much a *teaching/visualization tool for computer networks* as it is a file
transfer utility.

### Core capabilities (implemented today)

| Capability | Status |
|---|---|
| Automatic LAN device discovery (UDP broadcast) | ✅ Working |
| Persistent device identity across restarts | ✅ Working |
| TCP connection handshake with accept/reject + session IDs | ✅ Working |
| Length-prefixed message framing over TCP | ✅ Working |
| Chunked file transfer with per-chunk acknowledgement | ✅ Working |
| Pause / resume / cancel a live transfer | ✅ Working |
| SHA-256 end-to-end integrity verification | ✅ Working |
| Stall detection + chunk retry watchdog | ✅ Working |
| Two-way folder synchronization with baselines & manifests | ✅ Working |
| Sync conflict detection (keeps both copies) | ✅ Working |
| Live protocol event stream to the UI (SSE) | ✅ Working |
| Per-session protocol timeline + replay | ✅ Working |
| Session export (JSON / Markdown / Mermaid) | ✅ Working |
| Explain mode — plain-English protocol annotations | ✅ Working |
| Real-time chunk-grid transfer visualizer | ✅ Working |
| Shared clipboard across connected peers | ✅ Working |
| Drag-and-drop files onto the window to send | ✅ Working |
| Adaptive discovery cadence (backs off once connected) | ✅ Working |
| Device pairing / trust / authentication | ❌ Not built (auto-accept today) |
| Encryption of data in transit | ❌ Not built |
| Persistent transfer history (SQLite) | ✅ Working |
| Analytics dashboard (throughput / RTT / retries) | ✅ Working |
| Packaged installers | ❌ Not built |

---

## 2. Technology Stack

### Languages & core runtime
- **TypeScript** — every line of application code, across all three apps.
- **Node.js** — runtime for the networking engine and local API.
- **Electron 44** — desktop shell (main process, preload, renderer).
- **React 19** — UI, using hooks only (no state-management library).
- **Vite 8** — dev server and renderer bundler.

### Build & tooling
- **npm workspaces** — monorepo (`apps/*`, `packages/*`), no Lerna/Nx/Turbo.
- **tsx** — TypeScript execution with watch mode for `api` and `networking`.
- **`tsc` project references** — per-app `tsconfig` extending `tsconfig.base.json`.
- **concurrently** — runs networking build watch + API + Vite together (`npm run dev`).
- **oxlint** — linting for the desktop app.

### Node standard-library modules doing the real work
The project deliberately uses **zero third-party networking dependencies**. All
protocol work is built directly on Node's standard library:

| Module | Used for |
|---|---|
| `node:dgram` | UDP socket, broadcast, discovery |
| `node:net` | TCP server + TCP client sockets |
| `node:crypto` | `randomUUID()` for IDs, `createHash("sha256")` for checksums |
| `node:sqlite` | Durable transfer history and analytics (`DatabaseSync`) |
| `node:fs` | File read/write, folder scanning, baseline persistence |
| `node:os` | Hostname, network interface enumeration, netmask → broadcast address |
| `node:path` | Path resolution and path-traversal safety checks |
| `node:events` | `EventEmitter` — the engine's event bus |
| `node:http` | The local control-plane API server |

### What is *not* used (and why it matters when presenting)
- **No WebRTC, no libp2p, no Socket.IO** — raw UDP and TCP.
- **No database yet** — everything is in memory except device identity and sync
  baselines, which are plain JSON files under `~/.syncbridge/` and
  `~/SyncBridge/sync-state/`.
- **No Spring Boot / MySQL** — the original roadmap planned them; the project
  converged on a Node control plane instead. Treat roadmap mentions of Spring
  Boot as historical.
- **`packages/protocol/`** exists as scaffolding from Phase 0 but is **not
  imported by any running code**. The live message definitions are in
  `apps/networking/src/`. Mention it as legacy if asked.

---

## 3. Protocols & Ports

### Ports

| Port | Protocol | Purpose |
|---|---|---|
| `41234` | UDP | Device discovery (broadcast + unicast responses) |
| `41235` | HTTP | Local control-plane API (bound to `127.0.0.1` only) |
| `41236` | TCP | Peer-to-peer data connection (handshake, transfer, sync) |
| `5173` | HTTP | Vite dev server for the React renderer |

### Transport layer choices

**UDP for discovery.** Discovery is a "who's out there?" question with no
reliability requirement — a lost broadcast is simply retried on the next
10-second interval. Broadcast addresses are computed per network interface from
the IPv4 address and netmask (`ip | ~mask`), falling back to `255.255.255.255`.
Devices ignore their own broadcasts by comparing `deviceId`.

**TCP for everything else.** Connection setup, file data and sync control all
travel over one long-lived TCP connection per peer, so ordering and delivery are
guaranteed by the transport.

### Message framing

TCP is a byte stream, not a message stream, so SyncBridge defines its own frame:

```
┌────────────────────────┬──────────────────────────────┐
│ 4 bytes, uint32 BE     │ UTF-8 JSON payload           │
│ = payload length       │ (the protocol message)       │
└────────────────────────┴──────────────────────────────┘
```

`MessageFramer` buffers incoming data and emits complete messages only, which
correctly handles both **fragmentation** (one message split across TCP segments)
and **coalescing** (several messages arriving in one segment). A single frame is
capped at **16 MiB**; anything larger, or any invalid JSON, is reported as a
`MALFORMED_MESSAGE` protocol event and the buffer is reset.

*Implementation:* [framing.ts](../apps/networking/src/connection/framing.ts)

### Message catalogue

**Discovery (UDP, unframed JSON datagrams)**
- `DISCOVER` — broadcast, carries `deviceId` and version
- `DISCOVER_RESPONSE` — unicast reply, carries `deviceId`, `deviceName`, `ip`, `platform`

**Connection (TCP, framed)**
- `CONNECT_REQUEST` — `requestId`, `messageId`, `sequence`, `sessionId`, device info
- `CONNECT_ACCEPT` — confirms the session
- `CONNECT_REJECT` — with a typed reason: `DUPLICATE_CONNECTION`,
  `VERSION_MISMATCH`, `SELF_CONNECTION`, `CONNECTION_TIMEOUT`, `BUSY`,
  `UNKNOWN_ERROR`

**File transfer (TCP, framed — prefix `FILE_`)**
- `FILE_TRANSFER_REQUEST` / `FILE_TRANSFER_ACCEPT` / `FILE_TRANSFER_REJECT`
- `FILE_METADATA` — filename, size, total chunks, SHA-256 checksum
- `FILE_CHUNK` / `FILE_CHUNK_ACK`
- `FILE_TRANSFER_COMPLETE` / `FILE_TRANSFER_ACK`
- `FILE_TRANSFER_PAUSE` / `FILE_TRANSFER_RESUME`
- `FILE_TRANSFER_CANCEL` / `FILE_TRANSFER_ERROR`

**Clipboard (TCP, framed — prefix `CLIPBOARD_`)**
- `CLIPBOARD_UPDATE` — text payload plus a SHA-256 `contentHash` that both
  sides de-duplicate on, so an incoming clipboard written to the local OS
  clipboard is never echoed back around the mesh

**Folder sync (TCP, framed — prefix `SYNC_`)**
- `SYNC_PAIR_REQUEST` / `SYNC_PAIR_ACCEPT` / `SYNC_PAIR_REJECT`
- `SYNC_MANIFEST` — one-shot inventory exchange after pairing
- `SYNC_DELETE` — propagates a local deletion
- `SYNC_UNPAIR`

Routing is by **message-type prefix**: `ConnectionManager.handleMessage()` sends
anything starting with `FILE_` to `TransferManager`, `SYNC_` to `SyncEngine`,
`CLIPBOARD_` to `ClipboardManager`, and handles `CONNECT_*` itself. This keeps
the subsystems decoupled while sharing one socket — adding clipboard sync
needed no change to the connection layer beyond one more prefix branch.

### Chunking parameters

| Parameter | Value | Rationale |
|---|---|---|
| `CHUNK_SIZE` | 64 KiB | Conservative, because chunk bytes are Base64-encoded inside JSON (~33% overhead) |
| `CHUNK_ACK_TIMEOUT_MS` | 5000 ms | Ack silence beyond this marks in-flight chunks as stalled |
| Watchdog interval | 1000 ms | How often the sender checks for a stall |
| `PROGRESS_EVENT_INTERVAL_MS` | 250 ms | Throttles UI progress events (not one per chunk) |
| Sync scan tick | 5000 ms | How often an active sync pair re-scans its folder |
| Discovery broadcast (searching) | 10 s | While no peer is connected, find one quickly |
| Discovery broadcast (connected) | 60 s | Once connected, stop flooding the LAN and the event log |
| Stale device timeout | 3 × broadcast interval | Derived, so backing off can't evict peers prematurely |
| Clipboard poll | 1000 ms | Electron main samples the OS clipboard (no change event exists) |
| Max clipboard payload | 256 KiB | Keeps a runaway paste from stalling the connection |

---

## 4. Architecture

### Three processes, one device

```
┌──────────────────────────────────────────────────────────┐
│  Electron Main Process                                   │
│  • BrowserWindow • native file/folder pickers (IPC)      │
│  • Reveal-in-folder                                      │
└──────────────────────┬───────────────────────────────────┘
                       │ contextBridge (preload.cts)
┌──────────────────────▼───────────────────────────────────┐
│  Renderer — React 19 + Vite                              │
│  App.tsx · TransferVisualizer.tsx · ProtocolTimeline.tsx │
└──────────────────────┬───────────────────────────────────┘
                       │ HTTP REST (fetch) + SSE (EventSource)
                       │ http://127.0.0.1:41235
┌──────────────────────▼───────────────────────────────────┐
│  Local API — Node http server (apps/api)                 │
│  Control plane. Owns exactly one NetworkingEngine.       │
└──────────────────────┬───────────────────────────────────┘
                       │ direct in-process method calls
┌──────────────────────▼───────────────────────────────────┐
│  Networking Engine (apps/networking) — EventEmitter      │
│  ┌────────────┬───────────────┬──────────┬────────────┐  │
│  │ Discovery  │ Connection    │ Transfer │ Sync       │  │
│  │ (UDP)      │ Manager (TCP) │ Manager  │ Engine     │  │
│  └────────────┴───────────────┴──────────┴────────────┘  │
│  SessionStore — correlates all three event streams       │
└──────────────────────┬───────────────────────────────────┘
                       │ UDP :41234  ·  TCP :41236
                  ═════▼═════  Local Network  ═════════════
```

**Key architectural decision:** the API process — *not* Electron — owns the
`NetworkingEngine`. Electron only supplies native UI affordances (file picker,
folder picker, reveal-in-folder) over IPC. This guarantees exactly one engine per
device, and lets the whole networking stack run headless for testing.

### Event flow

The engine is an `EventEmitter` publishing three independent streams:

| Event name | Emitted by | Example types |
|---|---|---|
| `protocol-event` | Discovery, ConnectionManager, framing | `DISCOVER_SENT`, `DEVICE_DISCOVERED`, `CONNECT_ACCEPTED`, `MALFORMED_MESSAGE` |
| `transfer-event` | TransferSender / TransferReceiver | `CHUNK_SENT`, `CHUNK_ACKED`, `CHUNK_RETRY`, `TRANSFER_PROGRESS`, `TRANSFER_VERIFIED`, `TRANSFER_COMPLETED` |
| `sync-event` | SyncEngine | `PAIR_CREATED`, `SCAN_COMPLETE`, `FILE_QUEUED`, `FILE_DELETED`, `CONFLICT` |
| `clipboard-event` | ClipboardManager | `CLIPBOARD_SENT`, `CLIPBOARD_RECEIVED`, `CLIPBOARD_BLOCKED` |

The API fans all four out to the browser over a **single SSE endpoint**
(`GET /api/events`), tagged by event name. In parallel, `SessionStore` consumes
the protocol/transfer/sync streams in-process and threads every event onto its
`sessionId`, building a replayable timeline. This matters because SSE has no
history — a UI opened after a transfer finished would otherwise see nothing.

### REST API surface (`127.0.0.1:41235`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/api/device` | This device's ID, name, platform |
| GET | `/api/events` | **SSE** stream of protocol / transfer / sync events |
| GET | `/api/devices` | Discovered peers |
| GET | `/api/connections` | Active connections |
| POST | `/api/connections` | Connect to a device |
| POST | `/api/connections/disconnect`, DELETE `/api/connections` | Disconnect |
| GET | `/api/transfers` | All transfers (sent + received) |
| POST | `/api/transfers` | Start a transfer |
| POST | `/api/transfers/:id/pause\|resume\|cancel` | Transfer control |
| GET | `/api/sync-pairs` | List sync pairs |
| POST | `/api/sync-pairs` | Create a sync pair |
| POST | `/api/sync-pairs/:id/sync-now` | Force a scan |
| DELETE | `/api/sync-pairs/:id` | Unpair |
| GET | `/api/sessions` | Recent session summaries |
| GET | `/api/sessions/:id/timeline` | Full correlated timeline for replay |
| GET | `/api/sessions/:id/export` | Self-contained session record: summary, stats, timeline |
| GET | `/api/clipboard` | Sharing state, latest entry, recent history |
| POST | `/api/clipboard` | Share text with connected peers (de-duplicated by hash) |
| POST | `/api/clipboard/enabled` | Turn clipboard sharing on or off |
| GET | `/api/history/transfers` | Saved transfers; `limit`/`offset`/`since`/`direction`/`peerDeviceId`/`search` |
| GET | `/api/analytics` | Aggregates over saved history; optional `since` |
| DELETE | `/api/history` | Erase all saved history |

Security posture of the API: bound to loopback only, CORS restricted to the Vite
dev origins, request bodies capped at 1 MiB.

---

## 5. End-to-End Workflow

### A. Discovery
1. On start, each device loads or creates a UUID `deviceId`, persisted to
   `~/.syncbridge/identity.json` (mode `0600`) so it survives restarts.
2. UDP socket binds `:41234` with `reuseAddr` and broadcast enabled.
3. Every 10 s the device broadcasts `DISCOVER` to every interface's computed
   broadcast address.
4. A peer receiving `DISCOVER` replies with a unicast `DISCOVER_RESPONSE`
   advertising **its own** IPv4 (not the sender's) — a subtle but important bug
   class the code explicitly guards against.
5. The responder's details enter the in-memory `DeviceRegistry` with a
   `lastSeen` timestamp. Entries unseen for 30 s are evicted.
6. Self-broadcasts are filtered twice — once on `deviceId` at receive, once
   again on registration.

### B. Connection
1. The user clicks *Connect*; the UI POSTs to `/api/connections`.
2. `ConnectionManager` generates a `sessionId`, opens a TCP socket to the peer's
   advertised IP on `:41236`, with a 5 s timeout.
3. It sends a framed `CONNECT_REQUEST` (`requestId`, `messageId`, monotonic
   `sequence`, `sessionId`, device info).
4. The receiving side validates the message, checks for duplicates and version
   mismatch, and replies `CONNECT_ACCEPT` or a `CONNECT_REJECT` with a typed
   reason.
5. Both sides record the connection as `CONNECTED` and keep the socket open.
   Socket errors, `close`, and `end` all funnel into one termination handler
   that cleans up both the `deviceId → Connection` and `socket → deviceId` maps.

> ⚠️ There is **no authentication step** today. Any device on the LAN that
> completes the handshake is trusted. This is the single biggest known gap.

### C. File transfer
1. Sender: `FILE_TRANSFER_REQUEST` with `transferId` (UUID) and filename.
2. Receiver: registers a placeholder transfer so it appears in the UI
   immediately, then **auto-accepts** with `FILE_TRANSFER_ACCEPT`.
3. Sender reads the file, computes its SHA-256, and sends `FILE_METADATA`
   (size, `totalChunks`, checksum).
4. Sender loops the file in 64 KiB chunks, Base64-encoding each into a
   `FILE_CHUNK`. It honours **socket backpressure** — if `socket.write()`
   returns `false` it awaits the `drain` event before continuing — and pauses
   cooperatively when asked.
5. Receiver stores chunks in an index-keyed `Map`, de-duplicates re-sent chunks
   (but re-acks them, in case the original ack was lost), and returns
   `FILE_CHUNK_ACK`.
6. A 1 s **watchdog** on the sender resends in-flight chunks if no ack has
   arrived within 5 s, emitting `CHUNK_RETRY`.
7. Sender sends `FILE_TRANSFER_COMPLETE`.
8. Receiver reassembles chunks in index order, then verifies **both** the byte
   length against metadata **and** the SHA-256 digest. Only on a match does it
   write to disk and emit `TRANSFER_VERIFIED`.
9. Destination: `~/SyncBridge/` for manual transfers (filename reduced to its
   basename to prevent path injection), or inside the sync pair's folder for
   sync-tagged transfers.
10. Receiver sends `FILE_TRANSFER_ACK`; both sides mark the transfer
    `COMPLETED`.

### D. Folder synchronization
1. User creates a pair: local folder + peer + name. Initiator picks the
   `pairId`; `SYNC_PAIR_REQUEST` → `SYNC_PAIR_ACCEPT`.
2. Each side sends a one-shot `SYNC_MANIFEST` — every file's relative path,
   size, mtime and SHA-256 — so files already identical on both ends seed the
   baseline instead of being re-transferred.
3. The **baseline** (the last state both sides agreed on) is persisted as JSON
   at `~/SyncBridge/sync-state/<pairId>.json`.
4. Every 5 s an active pair re-scans its folder and diffs against the baseline.
   The diff is **cheap**: a file is only hashed if its size *or* mtime changed,
   and if the hash then matches the baseline (a `touch`, a checkout) it is not
   treated as a change.
5. Changed files are queued through `TransferManager` tagged with
   `syncPairId` + `relativePath`; deletions send `SYNC_DELETE`.
6. If the peer is offline, nothing is sent and the baseline does not move — so
   the change naturally retries on reconnect. Retry logic for free.
7. **Conflict policy:** if an incoming sync file's destination already holds a
   file modified *more recently* than the sender's copy, both sides diverged.
   Rather than overwrite, the incoming file is written alongside as
   `name (sync conflict from <peerId>).ext` and a `CONFLICT` event is raised.
8. **Path safety:** incoming `relativePath` values are resolved and checked to
   ensure they cannot escape the sync folder via `../` segments.

### E. Visualization
- `TransferVisualizer` renders a **chunk grid on an HTML canvas**, redrawn in a
  `requestAnimationFrame` loop from a mutable ref (so per-chunk events don't
  trigger React re-renders). Cells colour by state as chunks are sent, acked and
  retried, alongside live speed, ETA and a plain-English narration of the
  current protocol step.
- `ProtocolTimeline` (`SessionReplay`) fetches
  `/api/sessions/:id/timeline` and steps through the correlated event list stage
  by stage: discovery → connection → authentication → metadata → chunk-transfer
  → verification → completion (+ sync). The *authentication* stage is
  deliberately rendered as empty, honestly reflecting that it isn't implemented.

---

## 6. Repository Map

```
syncbridge/
├─ apps/
│  ├─ networking/              ← the engine (no UI, no HTTP)
│  │  └─ src/
│  │     ├─ networking-engine.ts   Facade + EventEmitter; wires everything
│  │     ├─ public-api.ts          What the API app is allowed to import
│  │     ├─ protocol-event.ts      Protocol event vocabulary
│  │     ├─ discovery/             socket · device-identity · device-registry · discovery
│  │     ├─ connection/            framing · tcp-server · connection-manager · connection-state
│  │     ├─ transfer/              transfer-manager · -sender · -receiver · -messages · -state · -config · -event
│  │     ├─ sync/                  sync-engine · sync-scanner · sync-state · sync-messages · sync-event
│  │     ├─ clipboard/             clipboard-manager · clipboard-messages · clipboard-event
│  │     ├─ history/               history-store   (SQLite: transfers, sessions, devices)
│  │     └─ session/               session-store   (event correlation + export)
│  ├─ api/src/index.ts         ← REST + SSE control plane (802 lines, single file)
│  └─ desktop/
│     ├─ electron/             main.ts (window, IPC) · preload.cts (contextBridge)
│     └─ src/                  App.tsx · TransferVisualizer.tsx · ProtocolTimeline.tsx
│                                AnalyticsDashboard.tsx · TransferHistory.tsx · charts.tsx
│                                api.ts · explain.ts · session-export.ts
│                                sync-activity.ts · format.ts
├─ packages/protocol/          ← Phase-0 scaffold, currently unused
├─ docs/
│  ├─ architecture/ARCHITECTURE.md
│  ├─ protocol/messages.md
│  ├─ patent/PRIOR_ART.md
│  └─ PROJECT_OVERVIEW.md      ← this file
├─ roadmap.md · changelog.md · README.md
└─ package.json                ← npm workspaces root
```

**Scale:** ~12,000 lines of TypeScript. Largest files: `App.tsx` (1108),
`connection-manager.ts` (891), `transfer-manager.ts` (870), `api/index.ts` (802),
`sync-engine.ts` (773).

### Running it

```bash
npm install
npm run dev              # builds networking, watches it, runs API + Vite
npm run desktop:electron # in a second terminal: build + launch Electron
npm run check            # typecheck every workspace
```

There are also standalone harnesses inside the engine
(`test-peer.ts`, `test-tcp-peer.ts`, `test-connection-lifecycle.ts`,
`test-file-transfer*.ts`, `test-session-timeline.ts`) that exercise each layer
headlessly, without Electron. These are manual scripts, **not** an automated
test suite.

---

## 7. Four-Way Module Split

Each module is a genuinely separable slice: its own files, its own concepts, its
own demo moment. Roughly balanced in depth, and ordered so the presentation
follows a packet's own journey through the system.

---

### Module 1 — Discovery & Device Layer
**"How do two computers find each other with nobody telling them where to look?"**

**Owns:**
- `apps/networking/src/discovery/` — `socket.ts`, `discovery.ts`,
  `device-identity.ts`, `device-registry.ts`
- `apps/networking/src/networking-engine.ts` (the facade / composition root)
- `apps/networking/src/index.ts` (process bootstrap, graceful shutdown)
- Harness: `discovery/test-peer.ts`

**Must be able to explain:**
- UDP vs TCP, and why discovery is the one place unreliability is acceptable
- Broadcast vs unicast; why the *response* is unicast
- Computing a per-interface broadcast address from IP and netmask
  (`ip | ~mask`), and why `255.255.255.255` is only a fallback
- `reuseAddr`, `setBroadcast(true)`, and why a device hears its own broadcasts
- Self-filtering by `deviceId` (twice — at receive and at registration)
- Why the responder must advertise its *own* IP, not `remote.address`
- Soft state: the 10 s refresh / 30 s eviction model, and why it's a heartbeat
- Persisting identity to `~/.syncbridge/identity.json` at mode `0600`, and why
  a random per-boot ID would break everything downstream
- The `EventEmitter` design of `NetworkingEngine` and why it's a facade

**Demo:** Two machines. Start both, watch `[DISCOVERY] Broadcasting DISCOVER`
and each appearing in the other's device list. Kill one; watch it age out of the
registry 30 s later.

---

### Module 2 — Connection Layer & Wire Protocol
**"TCP gives you a stream of bytes. Where does one message end and the next begin?"**

**Owns:**
- `apps/networking/src/connection/` — `framing.ts`, `tcp-server.ts`,
  `connection-manager.ts`, `connection-state.ts`
- `apps/networking/src/connection-messages.ts`, `message-types.ts`
- `docs/protocol/messages.md`
- Harnesses: `connection/test-tcp-peer.ts`, `connection/test-connection-lifecycle.ts`

**Must be able to explain:**
- **The framing problem** — this is the module's headline. TCP is a byte stream;
  a single `write()` can arrive as three `data` events, and three `write()`s can
  arrive as one. Demonstrate the 4-byte big-endian length prefix and how
  `MessageFramer` handles both fragmentation and coalescing.
- Why 16 MiB is capped, and what happens on a malformed frame
- The handshake: `CONNECT_REQUEST` → `CONNECT_ACCEPT` / `CONNECT_REJECT`, the
  typed reject reasons, and the 5 s connection timeout
- The roles of `requestId` (correlates request↔response), `messageId`
  (identifies one message), `sequence` (monotonic ordering), `sessionId`
  (issued on accept, threads everything downstream together)
- The connection state machine: `DISCONNECTED → CONNECTING → CONNECTED /
  FAILED / REJECTED`
- **Prefix-based message routing** — `FILE_*` → TransferManager, `SYNC_*` →
  SyncEngine, `CONNECT_*` handled locally. One socket, three subsystems, no
  coupling.
- Dual bookkeeping (`deviceId → Connection` and `socket → deviceId`) and why
  socket teardown must clean both
- **Honest gap:** no authentication. Any LAN device that completes the
  handshake is trusted.

**Demo:** Run `test-connection-lifecycle.ts`; show a successful handshake, then
a duplicate-connection reject. Optionally send a deliberately bad frame and show
the `MALFORMED_MESSAGE` event surfacing in the UI.

---

### Module 3 — File Transfer Engine
**"Moving a gigabyte reliably, resumably, and provably intact."**

**Owns:**
- `apps/networking/src/transfer/` — `transfer-manager.ts`, `transfer-sender.ts`,
  `transfer-receiver.ts`, `transfer-messages.ts`, `transfer-state.ts`,
  `transfer-config.ts`, `transfer-event.ts`
- Harnesses: `test-file-transfer.ts`, `test-file-transfer-sender.ts`,
  `test-file-transfer-peer.ts`

**Must be able to explain:**
- The full handshake: `REQUEST → ACCEPT → METADATA → CHUNK×N ↔ ACK×N →
  COMPLETE → verify → ACK`
- Why 64 KiB chunks, and the **Base64-in-JSON tradeoff**: ~33% wire overhead in
  exchange for a single uniform framed-JSON message format. This is the most
  interesting design critique in the whole project — own it, don't hide it.
- **Backpressure**: `socket.write()` returning `false` means the kernel buffer
  is full; the sender awaits `drain` rather than ballooning memory. Explain what
  goes wrong without it.
- **The watchdog**: 1 s interval, 5 s ack-silence threshold, resend in-flight
  chunks, emit `CHUNK_RETRY`. Be ready for the sharp question — *"TCP already
  guarantees delivery, so why retry?"* Answer: it guards against a stalled or
  unresponsive **application**, not against packet loss.
- **Idempotent receive**: duplicate chunks are dropped but still re-acked, in
  case the lost message was the ack rather than the chunk.
- Pause / resume as a cooperative await on a promise queue; cancel as a flag
  checked each loop iteration
- **Two-stage verification** — byte length against metadata, then SHA-256 over
  the reassembled buffer. Nothing is written to disk until both pass.
- Path-injection defence: `path.basename()` on incoming filenames
- Progress throttling to 250 ms so the UI gets smooth speed/ETA without an event
  per chunk

**Demo:** Send the 10 MB test file. Pause mid-flight, resume, watch the ack
counter continue. Then show the checksum verification line in the log.

---

### Module 4 — Sync Engine, Control Plane & Visualization
**"Keeping two folders honest, and making the whole protocol visible."**

**Owns:**
- `apps/networking/src/sync/` — `sync-engine.ts`, `sync-scanner.ts`,
  `sync-state.ts`, `sync-messages.ts`, `sync-event.ts`
- `apps/networking/src/session/session-store.ts`
- `apps/networking/src/history/history-store.ts`
- `apps/api/src/index.ts` (REST + SSE)
- `apps/desktop/` — Electron main/preload, `App.tsx`, `api.ts`,
  `TransferVisualizer.tsx`, `ProtocolTimeline.tsx`, `AnalyticsDashboard.tsx`,
  `TransferHistory.tsx`, `charts.tsx`

> This is the broadest module, and the history/analytics work has widened it
> further. If the group prefers even slices, split it as
> *4a: Sync engine + SessionStore* and
> *4b: HistoryStore + API + UI (dashboard, charts, replay)*.

**Must be able to explain:**
- **Baseline model**: the last state both sides agreed on, persisted to
  `~/SyncBridge/sync-state/<pairId>.json`. Local changes = scan vs baseline;
  agreement = completed transfer updates baseline.
- **Cheap diffing**: hash only when size or mtime changed; if the hash still
  matches, it was a `touch`, not an edit. Explain why this matters for a large
  mostly-static folder.
- **Manifest exchange**: one shot after pairing, so pre-existing identical files
  seed the baseline instead of crossing the wire.
- **Conflict resolution**: last-writer-wins is *rejected*; the incoming file is
  saved as `name (sync conflict from <peer>).ext` and both copies survive.
- **Offline retry for free**: no socket → don't send → baseline unchanged →
  the file still looks "changed" next tick → it retries on reconnect. No queue,
  no retry table.
- **Path traversal defence** in `resolveOutputPath` — resolved candidate must
  start with the resolved sync root.
- **SessionStore**: correlates three independent event streams onto one
  `sessionId`, with bounded memory (50 sessions, 5000 events each, 2-minute
  discovery lookback). Explain *why* it exists: SSE has no history, so a UI
  opened late would see an empty screen.
- **API design**: loopback-only bind, CORS allowlist, 1 MiB body cap, one SSE
  endpoint multiplexing four event names — and one *client* EventSource fanned
  out in `api.ts`. Explain why: a browser caps concurrent connections per
  origin and an SSE connection is never released, so one stream per event type
  starves the app's own fetches.
- **HistoryStore**: the only durable store. `node:sqlite` (not
  `better-sqlite3`, so there is no native module to rebuild against Electron's
  ABI), WAL mode, schema versioned with `user_version`, upsert-keyed by
  `transferId`. Explain why the engine *sweeps* the live transfer list on a
  1 s debounce instead of persisting from a single event: a cancel or a
  rejection emits no transfer event, and a missed event would lose the row
  forever.
- **Analytics honesty**: throughput is each transfer's bytes over its own
  duration; the mean RTT is recovered from `SUM(rtt_avg × samples) / SUM(samples)`
  so a 3-chunk file doesn't weigh as much as a 1000-chunk one. RTT is
  sender-side only and skips resent chunks, because a retried chunk has no
  unambiguous round trip.
- **Electron process model**: main / preload / renderer, `contextIsolation:
  true`, `nodeIntegration: false`, and the `contextBridge` exposing exactly
  three IPC methods. Explain why the engine lives in the API process, not in
  Electron.
- **Canvas rendering**: chunk grid driven by `requestAnimationFrame` from a
  mutable ref, deliberately bypassing React's render cycle so thousands of chunk
  events don't cause thousands of re-renders.

**Demo:** Pair a folder across two machines, drop a file in, watch it appear on
the other side within 5 s and name itself in the pair's file list. Edit the same
file on both sides while disconnected, reconnect, and show the conflict copy.
Then quit the app entirely, reopen it, and show the transfers still in Transfer
History with the dashboard's throughput and RTT charts intact — the one piece of
state that survives a restart. Finish with a session replay stepping through the
full protocol timeline.

---

### Shared talking points (everyone should know these)

1. **Zero third-party networking dependencies** — everything on `node:dgram`,
   `node:net`, `node:crypto`. If asked "did you use a library for this?", the
   answer is no.
2. **The three ports** — 41234 UDP discovery, 41235 HTTP control, 41236 TCP data.
3. **The full message flow** — discovery → connection → transfer → sync.
4. **The security gap** — auto-accept, no encryption, no pairing. Stating this
   proactively is far stronger than being caught by it.
5. **Monorepo layout** — three apps, npm workspaces, and the fact that
   `packages/protocol` is unused scaffolding.

---

## 8. Design Decisions Worth Defending

| Decision | Rationale | Cost |
|---|---|---|
| Electron over a web app | Needs local filesystem and raw TCP/UDP, which browsers don't expose | Large bundle; packaging work |
| JSON protocol messages | Human-readable, trivially debuggable, language-independent | Verbose on the wire |
| Base64 file chunks inside JSON | One uniform message format; no second binary parser | ~33% overhead — the biggest known inefficiency |
| 4-byte length-prefix framing | Simplest correct solution to TCP's stream semantics | Hand-rolled, needs the 16 MiB guard |
| Engine owned by the API, not Electron | Exactly one engine per device; runs headless for testing | An extra process to manage |
| SSE instead of WebSocket | Events are one-directional (engine → UI); SSE auto-reconnects and is simpler | Can't push UI → engine over it (REST handles that) |
| In-memory live state, SQLite for history | Live state stays simple; finished transfers survive a restart | Two places to look for a transfer |
| `node:sqlite` over `better-sqlite3` | Keeps the zero-native-dependency property — no rebuild against Electron's ABI | Needs Node 22+ |
| Sweep the transfer list, not one event | A cancel or rejection emits no transfer event; a missed event would lose a row permanently | Recording lags the event by up to 1 s |
| Soft-state device registry | Self-healing, no explicit goodbye message needed | Up to 30 s to notice a departure |
| Conflict copy over last-writer-wins | Never silently destroys a user's edit | Leaves manual cleanup to the user |
| Hash only on size/mtime change | Keeps scanning a large folder cheap | Misses an edit that preserves both — rare in practice |

---

## 9. Known Limitations

**Security**
- No authentication or pairing — any LAN device that completes the handshake can
  send files, and file transfers **auto-accept**.
- No encryption; all traffic is plaintext JSON over TCP.
- No rate limiting or connection throttling.

**Reliability & scale**
- Whole files are read into memory (`readFileSync`) on send and reassembled
  entirely in memory on receive — a multi-GB file will exhaust RAM.
- A transfer interrupted by disconnect cannot resume from its last chunk after a
  restart; resume only works within a live session.
- No automated tests. The `test-*.ts` files are manual harnesses.
- Sessions and the device registry are still in memory and lost on restart; only
  finished transfers are persisted.
- RTT is measured on the **sending** side only, and only for chunks that were
  never resent, so a received-only device reports no latency of its own.
- History grows without bound — there is no retention policy or `VACUUM`, only
  the manual *Clear history* button.

**Networking**
- LAN only. UDP broadcast does not cross subnets or routers; there is no relay,
  no NAT traversal, no mDNS fallback.
- IPv4 only.
- Local IP selection picks the first non-internal IPv4 interface, which can
  choose wrong on a machine with VPN or virtual adapters.

**Sync**
- Sync only runs while both peers are connected; a 5 s polling scan, not
  filesystem watching.
- No selective sync, ignore patterns, or `.gitignore`-style exclusions.
- Conflicts are surfaced, never merged.

**Product**
- No packaged installers; must be run from source.
- Single-window UI, no settings screen, no notifications.

---

## 10. Future Work

Ordered by value-to-effort. The first three are what an examiner will ask about.

### Tier 1 — Close the credibility gaps
1. **Device pairing and trust** *(roadmap Phase 11)* — public-key exchange on
   first contact, PIN or QR confirmation shown on both screens (AirDrop-style),
   persisted trusted-device list, and a hard requirement that a trust
   relationship exists before `FILE_TRANSFER_REQUEST` or `SYNC_PAIR_REQUEST` is
   accepted. This also fills the deliberately-empty *authentication* stage in
   the protocol timeline.
2. **Encryption in transit** — TLS over the TCP socket, or an application-layer
   AEAD (e.g. AES-256-GCM) with keys derived from the pairing exchange.
3. **Streaming I/O** — replace `readFileSync` / in-memory reassembly with
   `fs.createReadStream` and positional `fs.write`, making transfer memory usage
   independent of file size. This is the single highest-impact engineering fix.

### Tier 2 — Correctness and robustness
4. **Runtime message validation (Zod)** — replace the hand-written
   `isValidConnectRequest`-style guards with schemas, so a malformed or hostile
   message can't reach handler code.
5. **Binary chunk frames** — add a frame type flag so `FILE_CHUNK` payloads go
   over the wire as raw bytes, eliminating the Base64 overhead. Keep JSON for
   control messages.
6. **Durable resume** — persist per-transfer chunk bitmaps so an interrupted
   transfer resumes after an app restart, not just within a session.
7. **An automated test suite** — unit tests for `MessageFramer` (the fragmenting
   and coalescing cases especially), `diffAgainstBaseline`, and
   `resolveOutputPath`'s traversal guard; integration tests spawning two engines
   on loopback.

### Tier 3 — Features on the roadmap
8. **Extend the persistence layer** *(Phase 12, partly done)* — transfers,
   sessions and devices are now stored in SQLite via `node:sqlite`. Still open:
   persisting the *live* session timeline (today it is rebuilt in memory each
   run), a retention policy, and `VACUUM` so the file does not grow forever.
9. **Deepen the analytics** *(Phase 10, partly done)* — throughput, average
   speed, RTT, retry counts and duration all ship, with per-day throughput and
   latency charts. Still open: percentiles rather than means (a p95 RTT says
   far more than an average), per-file-type breakdowns, and receiver-side RTT.
10. **Filesystem watching** — replace the 5 s poll with `fs.watch` /
    `chokidar`-style events plus debouncing, for near-instant sync.
11. **Selective sync** — ignore patterns, per-pair include/exclude rules,
    one-way (mirror) mode alongside two-way.
12. **Transfer queue** — multiple concurrent transfers with prioritisation and a
    concurrency cap.

### Tier 4 — Reach and polish
13. **mDNS / Bonjour discovery** alongside UDP broadcast, for networks where
    broadcast is filtered.
14. **Cross-subnet discovery** — an optional lightweight rendezvous service, or
    manual peer entry by IP.
15. **IPv6 support.**
16. **Mobile companion app** speaking the same protocol.
17. **Packaging and release** *(Phase 14)* — `electron-builder` for macOS `.dmg`
    and Windows `.exe`, auto-update, code signing.
18. **UX polish** *(Phase 13)* — loading and empty states, system notifications,
    dark mode, a settings screen for ports and the received-files directory.

### Research direction
`docs/patent/PRIOR_ART.md` begins a prior-art assessment (currently one entry,
PA-001 / US11469970B2, Talari Networks) around the project's most novel idea:
**correlating transport-layer events with file-transfer-layer state to diagnose
and recommend recovery from transfer failures.** Generic network-visualization
claims are noted as high-risk; a narrowly defined transfer-state-correlation
mechanism may be more defensible. Continuing that search, and building an actual
diagnosis/recommendation engine on top of `SessionStore`, is the most
research-flavoured direction available.

---

## 11. Quick Reference Card

```
PORTS      41234/UDP discovery · 41235/HTTP api (loopback) · 41236/TCP data · 5173 vite
FRAME      [4-byte uint32 BE length][UTF-8 JSON]   max 16 MiB
ROUTING    CONNECT_* → ConnectionManager · FILE_* → Transfer · SYNC_* → Sync
           CLIPBOARD_* → Clipboard   (prefix-dispatched over one socket)
CHUNK      64 KiB, Base64 in JSON · ack each · 5 s stall → retry · 250 ms progress events
INTEGRITY  SHA-256 over the whole file, checked before anything is written to disk
TIMERS     discover 10 s searching / 60 s connected · stale 3x interval
           sync scan 5 s · connect timeout 5 s · watchdog 1 s · clipboard poll 1 s
STATE      identity  ~/.syncbridge/identity.json
           history   ~/.syncbridge/history.db        (SQLite, survives restart)
           received  ~/SyncBridge/
           baselines ~/SyncBridge/sync-state/<pairId>.json
EVENTS     protocol · transfer · sync · clipboard  →  ONE SSE /api/events
           (one EventSource, fanned out client-side: browsers cap
            concurrent connections per origin, and SSE never releases one)
           →  SessionStore (50 sessions x 5000 events)
           →  /api/sessions/:id/timeline  and  /export (JSON/Markdown/Mermaid)
HISTORY    terminal transfers swept into SQLite on a 1 s debounce
           /api/history/transfers (paged, searchable) · /api/analytics
           metrics: throughput = bytes / own duration · RTT = chunk→ack,
           sender-side, excluding resent chunks
RUN        npm run dev          (networking watch + api + vite)
           npm run desktop:electron
           npm run check        (typecheck all workspaces)
```
