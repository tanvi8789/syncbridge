# SyncBridge

A desktop LAN peer-to-peer file-transfer and folder-sync application built with
Electron, React, and Node.js. Devices find each other automatically, pair once
with a PIN, and then move files directly — no cloud, no account, no internet.
Every step of the networking protocol is recorded and can be replayed in the UI.

## Features

- Automatic LAN discovery (UDP broadcast) and direct TCP connections
- **PIN pairing** — a new device must be approved with a 6-digit PIN; paired
  devices are remembered and reconnect without one
- **Sensitive files** — mark a file as sensitive and it is encrypted with a PIN
  you choose; the receiver can only open it by entering the same PIN
- Chunked transfers with pause / resume / cancel, retry on stall, and SHA-256
  verification
- Two-way folder synchronization with conflict detection
- Shared clipboard between connected devices
- Protocol timeline with replay, "explain mode", and session export
- Transfer history and analytics dashboard
- Sidebar layout with a live map of nearby devices, light and dark themes
  (follows the system setting by default), and toast notifications

## Tech Stack

- Electron
- React
- TypeScript
- Node.js (no third-party networking dependencies)

## Repository Structure

```
apps/networking   networking engine: discovery, connections, pairing, transfer, sync
apps/api          local REST + SSE control plane (127.0.0.1:41235)
apps/desktop      Electron + React UI
packages/         shared protocol scaffolding
docs/             architecture, protocol messages, prior-art notes
PROJECT_OVERVIEW.md   full walkthrough of the design
```

## Development

Install dependencies once, then run the local API and renderer:

```bash
npm install
npm run dev
```

In a second terminal, build and open the Electron shell:

```bash
npm run desktop:electron
```

Run static checks with `npm run check`.

### Tests

The networking tests are runnable scripts (no test framework required):

```bash
cd apps/networking
npx tsx src/pairing/test-pairing.ts                  # PIN pairing + sensitive files, end to end
npx tsx src/connection/test-connection-lifecycle.ts  # handshake, rejects, session lifecycle
```

## Pairing two devices

1. Run SyncBridge on both machines (same network). Each appears in the other's
   device list.
2. On device **A**, click **Connect** next to device **B**.
3. Device **B** shows a 6-digit PIN. Device **A** asks for it — type it in.
4. Both devices now list each other under **Paired devices** (Devices view). From now on
   connecting needs no PIN.

You have 3 attempts and 2 minutes. To revoke a device, click **Forget** next to
it under **Paired devices**; it will need a new PIN to connect again. (Forget it
on both sides if you want both to stop trusting each other.)

How it works: the PIN is never sent over the network. Each side proves it knows
it with an HMAC over a transcript that includes an ephemeral X25519 key
exchange; a successful pairing stores a derived secret in
`~/.syncbridge/trusted-devices.json`, which later connections use to
authenticate automatically. Until a peer has authenticated, SyncBridge ignores
every transfer, sync and clipboard message from it.

## Sending a sensitive file

1. Drop a file on a connected device in the Devices view (or use **Send file**
   in Transfers) and pick the device.
2. In the dialog tick **This file is sensitive** and choose a PIN (at least 6
   characters — a longer passphrase is safer).
3. Tell the receiver the PIN yourself, in person or by message. SyncBridge never
   sends it.
4. The file is encrypted (AES-256-GCM, key derived from the PIN with scrypt)
   before it leaves your machine. The receiver sees a **🔒 Locked** file with a
   generic name; clicking **Unlock** and entering the PIN decrypts it into the
   received folder and removes the encrypted copy. A wrong PIN is rejected, and
   five wrong tries lock the file for 30 seconds.

## Security notes

- Only sensitive files are encrypted. Other traffic on the LAN is still
  plaintext JSON, even between paired devices.
- Pairing is a PIN-authenticated key exchange, not a full PAKE: someone who
  records a pairing could guess the 6-digit PIN offline, but that does not
  reveal the stored pairing secret.
- A short sensitive-file PIN can be brute-forced by anyone who obtains the
  encrypted file. Use a passphrase for strong protection.
- Transfers from a paired device are accepted automatically.

See [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) for the architecture, protocol,
known limitations, and future work.
