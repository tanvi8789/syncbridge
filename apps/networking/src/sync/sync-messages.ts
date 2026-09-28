export enum SyncMessageType {
    SYNC_PAIR_REQUEST = "SYNC_PAIR_REQUEST",
    SYNC_PAIR_ACCEPT = "SYNC_PAIR_ACCEPT",
    SYNC_PAIR_REJECT = "SYNC_PAIR_REJECT",

    SYNC_MANIFEST = "SYNC_MANIFEST",

    SYNC_DELETE = "SYNC_DELETE",

    SYNC_UNPAIR = "SYNC_UNPAIR",
}

export interface SyncManifestEntry {
    relativePath: string;
    size: number;
    mtimeMs: number;
    checksum: string;
}

/**
 * Sent by the side that initiates a new sync pair. `pairId` is
 * chosen by the initiator and shared by both sides from then on.
 */
export interface SyncPairRequest {
    type: SyncMessageType.SYNC_PAIR_REQUEST;
    version: string;

    pairId: string;
    name: string;

    timestamp: number;
}

export interface SyncPairAccept {
    type: SyncMessageType.SYNC_PAIR_ACCEPT;
    version: string;

    pairId: string;

    timestamp: number;
}

export interface SyncPairReject {
    type: SyncMessageType.SYNC_PAIR_REJECT;
    version: string;

    pairId: string;
    reason: string;

    timestamp: number;
}

/**
 * Exchanged exactly once per side, right after a pair is accepted,
 * so files that already match on both ends don't get re-transferred.
 */
export interface SyncManifestMessage {
    type: SyncMessageType.SYNC_MANIFEST;
    version: string;

    pairId: string;
    entries: SyncManifestEntry[];

    timestamp: number;
}

export interface SyncDeleteMessage {
    type: SyncMessageType.SYNC_DELETE;
    version: string;

    pairId: string;
    relativePath: string;

    timestamp: number;
}

export interface SyncUnpairMessage {
    type: SyncMessageType.SYNC_UNPAIR;
    version: string;

    pairId: string;

    timestamp: number;
}
