export type TransferEventType =
    | "CHUNK_SENT"
    | "CHUNK_ACKED"
    | "CHUNK_RETRY"
    | "TRANSFER_PAUSED"
    | "TRANSFER_RESUMED"
    | "TRANSFER_PROGRESS";

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
}

export type TransferEventListener = (event: TransferEvent) => void;
