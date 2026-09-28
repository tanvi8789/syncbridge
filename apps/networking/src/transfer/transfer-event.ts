export type TransferEventType =
    | "CHUNK_SENT"
    | "CHUNK_ACKED"
    | "CHUNK_RETRY"
    | "TRANSFER_PAUSED"
    | "TRANSFER_RESUMED"
    | "TRANSFER_PROGRESS"
    | "TRANSFER_REQUESTED"
    | "TRANSFER_VERIFIED"
    | "TRANSFER_COMPLETED";

export interface TransferEvent {
    transferId: string;
    type: TransferEventType;

    /**
     * Set for chunk-level events (CHUNK_SENT / CHUNK_ACKED / CHUNK_RETRY).
     */
    chunkIndex?: number;

    chunksAcked: number;
    totalChunks: number;

    bytesTransferred: number;
    fileSize: number;

    timestamp: number;

    /** Threads this event back to the connection session it happened over. */
    sessionId?: string;
}

export type TransferEventListener = (event: TransferEvent) => void;
