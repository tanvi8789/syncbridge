export type TransferState =
    | "REQUESTED"
    | "ACCEPTED"
    | "TRANSFERRING"
    | "COMPLETED"
    | "REJECTED";

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

    state: TransferState;
}
