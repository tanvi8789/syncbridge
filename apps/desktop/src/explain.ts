/*
 * Plain-English explanations shown when "Explain mode" is on.
 *
 * These are deliberately written for someone who has never seen the
 * codebase: each one says what actually happened on the wire and why
 * the protocol does it that way, rather than restating the event name.
 */

import type {
    ProtocolEvent,
    SyncEvent,
    TimelineEntry,
    TimelineStage,
    TransferEvent,
} from "./api";

export const STAGE_EXPLANATIONS: Record<TimelineStage, string> = {
    discovery:
        "Devices announce themselves with a UDP broadcast to the whole subnet. UDP is fine here because a lost announcement just gets retried on the next round — nothing depends on it arriving.",
    connection:
        "A direct TCP connection is opened on port 41236 and a handshake runs over it. TCP takes over from here because file data must arrive complete and in order.",
    authentication:
        "Reserved for device pairing and trust. SyncBridge does not implement this yet — any device on the network is currently accepted, which is why this step stays empty.",
    metadata:
        "Before any bytes move, the sender describes the file: its name, exact size, how many chunks it will arrive in, and a SHA-256 checksum of the whole thing. The receiver needs all of this to reassemble and verify.",
    "chunk-transfer":
        "The file is split into 64 KiB chunks and sent one at a time. The receiver acknowledges each chunk, so both sides always know exactly how far along the transfer is — and the sender can retry anything that stalls.",
    verification:
        "The receiver reassembles the chunks and hashes the result, comparing it against the checksum from the metadata step. Nothing is written to disk unless the hash matches exactly.",
    completion:
        "Both sides agree the transfer finished successfully. The file is now on disk at its final path and the transfer is marked complete.",
    sync: "A paired folder was scanned and compared against its baseline — the last state both devices agreed on. Only genuinely changed files are queued for transfer.",
};

export const PROTOCOL_EVENT_EXPLANATIONS: Partial<
    Record<ProtocolEvent["type"], string>
> = {
    DISCOVER_SENT:
        "This device sent a UDP broadcast asking 'is anyone else running SyncBridge?'. It goes to every network interface's broadcast address, so every machine on the subnet receives it.",
    DISCOVER_RECEIVED:
        "A discovery broadcast arrived from another machine. Devices also receive their own broadcasts, so the first thing checked is whether the sender's device ID is our own.",
    DISCOVER_RESPONSE_SENT:
        "This device replied directly (unicast, not broadcast) to whoever was asking. The reply advertises our own IP address — not the address the request came from, which is a classic mistake here.",
    DEVICE_DISCOVERED:
        "A peer's reply was accepted and added to the device registry with a timestamp. If it stops answering broadcasts, it eventually ages out of the list automatically.",
    CONNECT_ATTEMPT:
        "A TCP connection is being opened to the peer's advertised IP on port 41236. If it does not complete within 5 seconds it is abandoned.",
    CONNECT_REQUEST_SENT:
        "A CONNECT_REQUEST was written to the socket. It carries a request ID to match the reply against, a message ID, a sequence number, and a proposed session ID.",
    CONNECT_REQUEST_RECEIVED:
        "An incoming CONNECT_REQUEST is being validated — checking the protocol version matches and that this is not a duplicate or a connection to ourselves.",
    CONNECT_ACCEPTED:
        "The handshake succeeded and a session ID is now shared by both devices. Every transfer and sync event from here on is tagged with it, which is what makes this timeline possible.",
    CONNECT_REJECTED:
        "The peer refused the connection and said why — typically a duplicate connection, a protocol version mismatch, or an attempt to connect to itself.",
    CONNECTION_CLOSED:
        "The TCP socket closed. Both lookup tables tracking this connection are cleaned up, and any transfer still running over it stops.",
    MALFORMED_MESSAGE:
        "Data arrived that could not be decoded as a valid frame — either the declared length exceeded the 16 MiB cap or the payload was not valid JSON. The read buffer is reset rather than trying to resynchronise.",
};

export const TRANSFER_EVENT_EXPLANATIONS: Partial<
    Record<TransferEvent["type"], string>
> = {
    TRANSFER_REQUESTED:
        "The sender asked permission to send a file. The receiver registers it immediately so it appears in the UI, then accepts automatically — there is no approval prompt yet.",
    CHUNK_SENT:
        "A 64 KiB slice of the file was Base64-encoded into a JSON message and written to the socket. If the kernel's send buffer was full, the sender waits for it to drain rather than queueing in memory.",
    CHUNK_ACKED:
        "The receiver confirmed it stored this chunk. Acknowledging every chunk is what lets the sender detect a stalled peer and drive an accurate progress bar.",
    CHUNK_RETRY:
        "No acknowledgement arrived for 5 seconds, so the sender re-sent the chunk. TCP already guarantees delivery, so this is really protection against a peer whose application has stopped responding.",
    TRANSFER_PAUSED:
        "The send loop is parked on a promise. The socket stays open and no chunks are written until it resumes.",
    TRANSFER_RESUMED:
        "The paused send loop was released and picks up from the next unsent chunk.",
    TRANSFER_PROGRESS:
        "A throttled progress update, emitted about four times a second so the UI can show speed and ETA without an event for every single chunk.",
    TRANSFER_VERIFIED:
        "The reassembled file's SHA-256 matched the checksum sent in the metadata step, and the byte count matched too. Only now is it safe to write to disk.",
    TRANSFER_COMPLETED:
        "The file is written and both devices agree the transfer is done.",
};

export const SYNC_EVENT_EXPLANATIONS: Partial<
    Record<SyncEvent["type"], string>
> = {
    PAIR_CREATED:
        "Two folders are now linked. Both sides immediately exchange a manifest listing every file with its checksum, so anything already identical on both ends is marked as agreed rather than re-sent.",
    PAIR_REMOVED:
        "The pair was dismantled and its stored baseline deleted. The files themselves are left alone.",
    SCAN_COMPLETE:
        "The folder was walked and compared against the baseline. Files are only hashed when their size or modification time changed, which keeps scanning a large folder cheap.",
    FILE_QUEUED:
        "A genuinely changed file was handed to the transfer engine. It travels over the same chunked protocol as a manual send, just tagged with the sync pair it belongs to.",
    FILE_DELETED:
        "The peer deleted this file, so it was removed here too. The path is checked first to make sure it cannot point outside the synced folder.",
    CONFLICT:
        "Both devices changed the same file while apart. Rather than pick a winner and destroy an edit, the incoming copy is saved alongside the local one under a conflict name.",
};

export const TRANSFER_STEP_EXPLANATIONS: Record<string, string> = {
    REQUESTED:
        "Waiting for the peer to accept the transfer. Nothing has been sent yet beyond the filename.",
    ACCEPTED:
        "The peer agreed. The sender is now hashing the file and preparing the metadata message.",
    TRANSFERRING:
        "Chunks are flowing. Each square in the grid below is one 64 KiB chunk — it turns blue when sent and green once the peer confirms it.",
    VERIFYING:
        "Every chunk is acknowledged. The receiver is reassembling the file and checking its SHA-256 against the checksum the sender promised.",
    COMPLETED:
        "Verified and written to disk.",
};

export function explainTimelineEntry(
    entry: TimelineEntry
): string | undefined {
    const type = (entry.event as { type?: string }).type;

    if (!type) {
        return undefined;
    }

    switch (entry.source) {
        case "protocol":
            return PROTOCOL_EVENT_EXPLANATIONS[
                type as ProtocolEvent["type"]
            ];
        case "transfer":
            return TRANSFER_EVENT_EXPLANATIONS[
                type as TransferEvent["type"]
            ];
        case "sync":
            return SYNC_EVENT_EXPLANATIONS[type as SyncEvent["type"]];
        default:
            return undefined;
    }
}
