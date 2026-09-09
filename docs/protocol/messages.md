# SyncBridge Communication Protocol v1.0

This document defines every message exchanged between SyncBridge peers.

---

## 1. DISCOVER

**Purpose**

Broadcast by a device to discover other SyncBridge peers on the LAN.

**Transport**

UDP Broadcast

**Example**

```json
{
  "type": "DISCOVER",
  "version": "1.0.0",
  "timestamp": 1753896000
}
```

---

## 2. DISCOVER_RESPONSE

**Purpose**

Sent by a device in response to a DISCOVER request.

**Transport**

UDP Unicast

**Example**

```json
{
  "type": "DISCOVER_RESPONSE",
  "deviceId": "a8f2d7b1",
  "deviceName": "Tanvi-MacBook",
  "ip": "192.168.1.15",
  "platform": "macOS"
}
```


## CONNECT_REQUEST

Sent by a device when it wants to establish a peer connection.

Fields:

- `type`
- `version`
- `requestId`
- `messageId` — unique identifier for this protocol message
- `sequence` — monotonically increasing sender sequence number
- `deviceId`
- `timestamp`

---

## CONNECT_ACCEPT

Sent when a connection request is accepted.

Fields:

- `type`
- `version`
- `requestId`
- `messageId`
- `sequence`
- `deviceId`
- `sessionId`
- `timestamp`

---

## CONNECT_REJECT

Sent when a connection request is rejected.

Fields:

- `type`
- `version`
- `requestId`
- `messageId`
- `sequence`
- `deviceId`
- `reason`
- `timestamp`

---

## TCP message framing

TCP messages use a 4-byte unsigned big-endian payload-length header followed by
a UTF-8 JSON payload. The decoder accepts fragmented and coalesced TCP data,
rejects invalid JSON, and caps a single frame at 16 MiB. `requestId` correlates
a handshake request with its response; `messageId` identifies each individual
message; and `sessionId` is issued in `CONNECT_ACCEPT`.
