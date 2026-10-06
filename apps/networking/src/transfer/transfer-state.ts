export type TransferState =
    | "REQUESTED"
    | "ACCEPTED"
    | "TRANSFERRING"
    | "PAUSED"
    | "COMPLETED"
    | "REJECTED"
    | "CANCELLED";

export type TransferDirection = "sent" | "received";

export interface Transfer {
    transferId: string;

    direction: TransferDirection;
    peerDeviceId: string;

    fileName: string;
    fileSize: number;

    totalChunks: number;

    checksum?: string;

    /**
     * Absolute path the file was written to on this device.
     * Only set for completed received transfers.
     */
    savedPath?: string;

    /**
     * Live progress, kept up to date on both the sending and
     * receiving side so either device's UI can visualize it.
     */
    chunksAcked: number;
    bytesTransferred: number;
    retryCount: number;
    paused: boolean;

    startedAt?: number;
    lastProgressAt?: number;

    /**
     * Chunk-ack round-trip statistics, accumulated on the sending
     * side only (the receiver never learns when a chunk was sent).
     * Kept as a running total rather than an average so samples can
     * be folded in without rescanning.
     */
    rttSamples?: number;
    rttTotalMs?: number;
    rttMinMs?: number;
    rttMaxMs?: number;

    /**
     * Present when this transfer was queued by the sync engine
     * rather than a manual send, so the UI can label it accordingly.
     */
    syncPairId?: string;
    relativePath?: string;

    /** Threads this transfer back to the connection session it happened over. */
    sessionId?: string;

    state: TransferState;
}
