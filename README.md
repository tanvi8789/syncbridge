# SyncBridge

SyncBridge is a desktop app for moving files between computers on the same
local network. Devices find each other automatically, connect directly, and
transfer files or keep folders in sync. There is no cloud service, no account
and no internet connection involved.

It is also built to teach how networking works. Every step of the protocol
(discovery, connection, pairing, chunked transfer, verification) is recorded as
a structured event, so you can replay a session and see what happened on the
wire.

## What it does

**Connect**
- Finds other SyncBridge devices on the LAN automatically (UDP broadcast).
- Opens a direct TCP connection between two devices.
- Pairs a new device once with a 6-digit PIN, then remembers it.

**Share**
- Sends files with live progress, speed and ETA, and lets you pause, resume or
  cancel. Large files are split into chunks, each one acknowledged, and the
  whole file is verified with a SHA-256 checksum.
- Keeps a folder in sync between two devices, and keeps both copies when the
  same file was edited on each side.
- Shares copied text between connected devices.
- Lets you mark a file as sensitive so it is encrypted with a PIN you choose.

**Understand**
- Records each session as a timeline you can replay, with plain-English
  explanations of every step (Explain mode) and export to JSON, Markdown or a
  Mermaid diagram.
- Shows a live visualizer of every chunk in a transfer.
- Saves transfer history and shows analytics for throughput, latency and retries.

## How it fits together

```
 Desktop app (Electron + React)
            |  HTTP + server-sent events, localhost only
 Local API (Node.js)
            |
 Networking engine (Node.js)
   discovery (UDP) | connections, pairing, transfer, sync, clipboard (TCP)
```

The networking engine does all the work and has no UI. The local API exposes it
to the desktop app over REST and a single event stream, and the desktop app is
a React interface wrapped in Electron for file pickers and native clipboard
access. Networking uses only Node's built-in `dgram`, `net` and `crypto`
modules, with no third-party networking libraries.

## Tech stack

- Electron and React for the desktop app
- TypeScript throughout
- Node.js for the API and the networking engine
- SQLite (`node:sqlite`) for transfer history
- Vite for the renderer build

## Project structure

```
apps/networking   Networking engine: discovery, connections, pairing,
                  transfer, sync, clipboard, history, session recording
apps/api          Local REST and event-stream API (127.0.0.1:41235)
apps/desktop      Electron shell and React interface
packages/protocol Shared protocol definitions (early scaffolding)
docs/             Architecture notes, protocol message reference, prior art
PROJECT_OVERVIEW.md  Full walkthrough of the design and decisions
```

## Getting started

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

This builds the networking engine, then starts the API and the Vite dev server.
In a second terminal, build and open the Electron app:

```bash
npm run desktop:electron
```

To try it you need two machines on the same network, each running SyncBridge.
Run `npm run check` to type-check every workspace.

## Using it

1. Open **Devices**. Other machines running SyncBridge appear on the map.
2. Select one and choose **Connect**. The first time, one device shows a PIN and
   the other asks for it. After that the two devices trust each other.
3. Drop a file on the connected device, or use **Send file** in **Transfers**.
   Tick *This file is sensitive* if it should be locked with a PIN.
4. Use **Folder sync** to keep a folder identical on two devices, and
   **Clipboard** to share copied text.
5. Open **Protocol** to replay a session, and **Analytics** to see throughput
   and latency over time.

## Ports and files

| Port | Protocol | Purpose |
|---|---|---|
| 41234 | UDP | Device discovery |
| 41235 | HTTP | Local API, bound to 127.0.0.1 only |
| 41236 | TCP | Device-to-device connection |
| 5173 | HTTP | Vite dev server |

| Location | Contents |
|---|---|
| `~/SyncBridge/Received` | Files received from other devices |
| `~/SyncBridge/sync-state` | Folder sync baselines |
| `~/.syncbridge` | Device identity, paired devices, transfer history |

## Tests

The networking tests are runnable scripts and need no test framework:

```bash
cd apps/networking
npx tsx src/pairing/test-pairing.ts                  # pairing and sensitive files
npx tsx src/connection/test-connection-lifecycle.ts  # handshake and rejections
```

## Security in brief

- A new device must be paired with a PIN before it can send anything. The PIN is
  never sent over the network.
- Sensitive files are encrypted with AES-256-GCM using a key derived from the
  PIN, and stay locked on the receiving device until the PIN is entered.
- All other traffic on the LAN is plaintext, and transfers from a paired device
  are accepted automatically.

The details, including known limits, are in
[PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) and
[docs/protocol/messages.md](docs/protocol/messages.md).

## Status

SyncBridge works end to end on a LAN. Planned work includes encrypting all
traffic, streaming large files instead of buffering them, a proper automated
test suite, and packaged installers. See the future work section of
[PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md).
