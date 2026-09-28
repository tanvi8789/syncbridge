export type SyncEventType =
    | "PAIR_CREATED"
    | "PAIR_REMOVED"
    | "SCAN_COMPLETE"
    | "FILE_QUEUED"
    | "FILE_DELETED"
    | "CONFLICT";

export interface SyncEvent {
    pairId: string;
    type: SyncEventType;

    relativePath?: string;

    timestamp: number;

    /** Threads this event back to the connection session it happened over. */
    sessionId?: string;
}

export type SyncEventListener = (event: SyncEvent) => void;
