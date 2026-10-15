# SyncBridge Architecture

## Overview

SyncBridge is a desktop LAN synchronization platform designed to enable secure peer-to-peer file synchronization and transfer over a local network.

The application follows a modular, multi-process architecture consisting of three primary applications:

- Desktop Application (Electron + React)
- Local API Service (Node.js)
- Networking Engine (Node.js)

---

# High-Level Architecture

```
┌─────────────────────────────┐
│      Desktop Application    │
│     Electron + React UI     │
└──────────────┬──────────────┘
               │
        REST / WebSocket
               │
┌──────────────▼──────────────┐
│      Local Node API         │
│ Control plane • SSE events  │
└──────────────┬──────────────┘
               │
         Internal Commands
               │
┌──────────────▼──────────────┐
│     Networking Engine       │
│ UDP • TCP • Synchronization │
└──────────────┬──────────────┘
               │
          Local Network
```

---

# Component Responsibilities

## Desktop Application

Responsible for:

- User Interface
- Dashboard
- Device Management
- Transfer Monitoring
- Analytics Visualization
- Settings

---

## API Service

Responsible for:

- REST API
- WebSocket Events
- Device Registry
- Transfer History
- Analytics
- Local control API and SSE event forwarding

---

## Networking Engine

Responsible for:

- UDP Device Discovery
- TCP Connections
- Device Pairing and Trust (PIN pairing, trusted-device store)
- File Transfer (including PIN-encrypted sensitive files)
- Folder Synchronization
- Protocol Handling
- Checksum Verification

---

# Communication

## Desktop ↔ API

Protocol

- HTTP REST
- WebSocket

---

## API ↔ Networking Engine

Internal communication between the control plane and networking engine.

The API owns the networking engine in the desktop development topology. The
Electron process only supplies native UI features (such as file selection), so
there is exactly one engine per device.

---

## Networking Engine ↔ Remote Peer

Protocols

- UDP
- TCP

---

# Project Structure

```
apps/
    desktop/
    api/
    networking/

packages/
    protocol/
    constants/
    types/
    ui/

docs/
```

---

# Protocol Overview

Current protocol messages

- DISCOVER
- DISCOVER_RESPONSE
- CONNECT_REQUEST
- CONNECT_ACCEPT
- CONNECT_REJECT
- SYNC_REQUEST
- TRANSFER_START
- CHUNK
- CHUNK_ACK
- VERIFY_REQUEST
- VERIFY_SUCCESS
- TRANSFER_COMPLETE
- ERROR

---

# Data Flow

Device Discovery

↓

Connection

↓

Transfer Request

↓

Chunk Transfer

↓

Verification

↓

Completion

---

# Current Status

Current implementation includes discovery, PIN-based device pairing with a
persisted trusted-device list, connection lifecycle management, verified file
transfer (with optional PIN-encrypted "sensitive" files), folder
synchronization, clipboard sharing, and SQLite transfer history. Encryption of
all traffic (not just sensitive files), cross-network discovery and packaging
remain future work. See `PROJECT_OVERVIEW.md` for the full picture.



# Architecture Decisions

## ADR-001

Desktop application uses Electron instead of a browser-only application.

Reason:

- Access to local file system
- Native TCP/UDP networking
- Desktop experience
- Easier future packaging

---

## ADR-002

Protocol messages use JSON.

Reason:

- Human-readable
- Easy debugging
- Language independent

---

## ADR-003

File data will be transferred as raw binary rather than embedded in JSON.

Reason:

- Better performance
- Lower memory usage
- Simpler chunking

---

## ADR-004

Devices must pair before they can exchange anything but the handshake.

Decision:

- A new device is paired once with a 6-digit PIN shown on one screen and typed
  on the other. The PIN never crosses the network: both sides send an HMAC over
  an ephemeral X25519 key exchange transcript, keyed with the PIN.
- A successful pairing stores an HKDF-derived secret on both sides; later
  connections prove knowledge of it automatically.
- Until a connection is authenticated, `FILE_`, `SYNC_` and `CLIPBOARD_`
  messages are dropped.

Reason:

- Simple for users, and no certificate infrastructure on a LAN
- Binds the key exchange to the PIN, so an active man-in-the-middle needs the PIN
- Trade-off: not a full PAKE, so a recorded pairing allows offline PIN guessing
  (which does not reveal the stored secret)

---

## ADR-005

Sensitive files are encrypted by the sender with a key derived from a PIN the
two people share out of band.

Reason:

- A PIN check in the UI alone would still leave the file readable on the wire
  and on disk; encrypting makes the PIN the actual key
- The receiver stores only ciphertext until the PIN is entered
- The file name is inside the ciphertext
- Trade-off: the PIN's strength is the file's strength, and only sensitive
  files get this protection
