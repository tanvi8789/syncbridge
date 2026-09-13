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

    state: TransferState;
}
