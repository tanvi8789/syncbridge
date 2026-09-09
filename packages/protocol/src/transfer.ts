import type { BaseMessage } from "./base.js";

export interface TransferStartMessage extends BaseMessage {
    type: "TRANSFER_START";

    transferId: string;
    fileName: string;
    fileSize: number;
    totalChunks: number;
    checksum: string;
}

export interface ChunkMessage extends BaseMessage {
    type: "CHUNK";

    transferId: string;
    chunkIndex: number;
    totalChunks: number;
    data: string;
    checksum: string;
}

export interface ChunkAckMessage extends BaseMessage {
    type: "CHUNK_ACK";

    transferId: string;
    chunkIndex: number;
}

export interface VerifyRequestMessage extends BaseMessage {
    type: "VERIFY_REQUEST";

    transferId: string;
}

export interface VerifySuccessMessage extends BaseMessage {
    type: "VERIFY_SUCCESS";

    transferId: string;
    checksum: string;
}

export interface TransferCompleteMessage extends BaseMessage {
    type: "TRANSFER_COMPLETE";

    transferId: string;
}