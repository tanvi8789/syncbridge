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
     * Present when this transfer was queued by the sync engine
     * rather than a manual send, so the UI can label it accordingly.
     */
    syncPairId?: string;
    relativePath?: string;

    /** Threads this transfer back to the connection session it happened over. */
    sessionId?: string;

    state: TransferState;
}
