export type TransferState =
    | "REQUESTED"
    | "ACCEPTED"
    | "TRANSFERRING"
    | "COMPLETED"
    | "REJECTED";

export interface Transfer {
    transferId: string;

    fileName: string;
    fileSize: number;

    totalChunks: number;

    state: TransferState;
}