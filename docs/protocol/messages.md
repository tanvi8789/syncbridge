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
- `sessionId` — proposed by the initiator and echoed back on accept
- `deviceName`, `platform`
- `timestamp`

---

## CONNECT_CHALLENGE

Sent by the responder after a valid `CONNECT_REQUEST`. The connection is not
accepted, and no `FILE_`, `SYNC_` or `CLIPBOARD_` message is processed, until
the initiator answers correctly.

Fields:

- `type`, `version`, `requestId`, `messageId`, `sequence`, `deviceId`,
  `sessionId`, `deviceName`, `timestamp`
- `mode` — `"pin"` for a device that has never paired (a 6-digit PIN is shown
  on the responder's screen), or `"trusted"` for a paired device
- `nonce` — 16 random bytes, hex
- `publicKey` — ephemeral X25519 key, SPKI DER, base64

---

## PAIR_PROOF

Sent by the initiator in answer to a challenge.

Fields:

- `type`, `version`, `requestId`, `messageId`, `sequence`, `deviceId`,
  `sessionId`, `timestamp`
- `nonce`, `publicKey` — the initiator's own nonce and ephemeral key
- `proof` — `HMAC-SHA256(secret, "initiator|" + transcript)`

`secret` is the PIN (mode `pin`) or the stored pairing secret (mode `trusted`).
`transcript` is `syncbridge-pairing-v1|initiatorId|responderId|initiatorNonce|
responderNonce|initiatorKey|responderKey`. The PIN is never transmitted.

---

## PAIR_RETRY

Sent by the responder when a `pin`-mode proof was wrong and attempts remain
(3 in total; the third failure rejects with `PAIRING_FAILED`).

Fields: `type`, `version`, `requestId`, `messageId`, `sequence`, `deviceId`,
`attemptsLeft`, `timestamp`.

---

## CONNECT_ACCEPT

Sent when a connection request is accepted and the peer has authenticated.

Fields:

- `type`
- `version`
- `requestId`
- `messageId`
- `sequence`
- `deviceId`
- `sessionId`
- `proof` — `HMAC-SHA256(secret, "responder|" + transcript)`; the initiator
  closes the connection if this is missing or wrong
- `timestamp`

After a `pin`-mode pairing both sides derive the long-term secret as
`HKDF-SHA256(ecdhSharedSecret, salt = SHA256(transcript), info =
"syncbridge-pairing-secret", 32 bytes)` and store it against the peer's device
ID.

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
- `reason` — one of `DUPLICATE_CONNECTION`, `VERSION_MISMATCH`,
  `SELF_CONNECTION`, `CONNECTION_TIMEOUT`, `BUSY`, `PAIRING_FAILED`
  (too many wrong PINs, timeout or cancellation), `AUTH_FAILED` (a paired
  device failed to prove it holds the secret), `UNKNOWN_ERROR`
- `timestamp`

---

## Sensitive file transfers

`FILE_TRANSFER_REQUEST` and `FILE_METADATA` carry an optional
`"sensitive": true`. The payload is then the encrypted file, not the original:

```
file  = "SBENC1" | salt(16) | iv(12) | AES-256-GCM ciphertext | tag(16)
plain = nameLength(u16 BE) | file name (UTF-8) | file bytes
key   = scrypt(PIN, salt, N=2^15, r=8, p=1) -> 32 bytes
```

The real file name is inside the ciphertext, so the receiver only sees
`sensitive-xxxxxxxx.sbenc`. The PIN is chosen by the sender (at least 6
characters) and shared with the receiver out of band; it is never sent. The
SHA-256 in `FILE_METADATA` covers the encrypted bytes. The receiver saves the
`.sbenc` file and keeps it locked until the PIN is entered; a wrong PIN or a
modified file fails GCM authentication and nothing is written.

---

## TCP message framing

TCP messages use a 4-byte unsigned big-endian payload-length header followed by
a UTF-8 JSON payload. The decoder accepts fragmented and coalesced TCP data,
rejects invalid JSON, and caps a single frame at 16 MiB. `requestId` correlates
a handshake request with its response; `messageId` identifies each individual
message; and `sessionId` is proposed in `CONNECT_REQUEST` and confirmed in
`CONNECT_ACCEPT`.
