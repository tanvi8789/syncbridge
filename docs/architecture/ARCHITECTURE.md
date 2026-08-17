# SyncBridge Architecture

## Overview

SyncBridge is a desktop LAN synchronization platform designed to enable secure peer-to-peer file synchronization and transfer over a local network.

The application follows a modular, multi-process architecture consisting of three primary applications:

- Desktop Application (Electron + React)
- API Service (Spring Boot)
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
│      Spring Boot API        │
│ Session • Analytics • DB    │
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
- Database Access

---

## Networking Engine

Responsible for:

- UDP Device Discovery
- TCP Connections
- File Transfer
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

(Current implementation to be decided.)

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

Current Version

0.1.0

Status

Project scaffold completed.

Next milestone:

Implement UDP device discovery.



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