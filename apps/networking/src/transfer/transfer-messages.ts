export enum TransferMessageType {
    FILE_TRANSFER_REQUEST = "FILE_TRANSFER_REQUEST",
    FILE_TRANSFER_ACCEPT = "FILE_TRANSFER_ACCEPT",
    FILE_TRANSFER_REJECT = "FILE_TRANSFER_REJECT",

    FILE_METADATA = "FILE_METADATA",

    FILE_CHUNK = "FILE_CHUNK",

    FILE_TRANSFER_COMPLETE = "FILE_TRANSFER_COMPLETE",
    FILE_TRANSFER_ACK = "FILE_TRANSFER_ACK",

    FILE_TRANSFER_CANCEL = "FILE_TRANSFER_CANCEL",
    FILE_TRANSFER_ERROR = "FILE_TRANSFER_ERROR",
}

export interface FileTransferRequest {
    type: TransferMessageType.FILE_TRANSFER_REQUEST;
    version: string;

    transferId: string;

    senderDeviceId: string;
    fileName: string;

    timestamp: number;
}

export interface FileTransferAccept {
    type: TransferMessageType.FILE_TRANSFER_ACCEPT;
    version: string;

    transferId: string;

    deviceId: string;

    timestamp: number;
}

export interface FileTransferReject {
    type: TransferMessageType.FILE_TRANSFER_REJECT;
    version: string;

    transferId: string;

    deviceId: string;

    reason: string;

    timestamp: number;
}

export interface FileMetadata {
    type: TransferMessageType.FILE_METADATA;
    version: string;

    transferId: string;

    fileName: string;
    fileSize: number;

    totalChunks: number;

    timestamp: number;
}

export interface FileChunk {
    type: TransferMessageType.FILE_CHUNK;
    version: string;

    transferId: string;

    chunkIndex: number;
    totalChunks: number;

    data: string;

    timestamp: number;
}

export interface FileTransferComplete {
    type: TransferMessageType.FILE_TRANSFER_COMPLETE;
    version: string;

    transferId: string;

    totalChunks: number;

    timestamp: number;
}

export interface FileTransferAck {
    type: TransferMessageType.FILE_TRANSFER_ACK;
    version: string;

    transferId: string;

    timestamp: number;
}

export interface FileTransferCancel {
    type: TransferMessageType.FILE_TRANSFER_CANCEL;
    version: string;

    transferId: string;

    reason: string;

    timestamp: number;
}

export interface FileTransferError {
    type: TransferMessageType.FILE_TRANSFER_ERROR;
    version: string;

    transferId: string;

    error: string;

    timestamp: number;
}