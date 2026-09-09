import type { BaseMessage } from "./base.js";
import type { DeviceInfo } from "./device.js";
import type {
    DiscoverMessage,
    DiscoverResponseMessage,
} from "./discover.js";
import type {
    ConnectRequestMessage,
    ConnectAcceptMessage,
    ConnectRejectMessage,
} from "./connect.js";
import type {
    TransferStartMessage,
    ChunkMessage,
    ChunkAckMessage,
    VerifyRequestMessage,
    VerifySuccessMessage,
    TransferCompleteMessage,
} from "./transfer.js";

export interface MessageContext {
    messageId: string;
    sessionId: string;
    senderId: string;
    sequence: number;
    version?: string;
}

function base(
    type: string,
    context: MessageContext
): BaseMessage {
    return {
        type,
        version: context.version ?? "1.0",
        messageId: context.messageId,
        sessionId: context.sessionId,
        timestamp: Date.now(),
        sequence: context.sequence,
        senderId: context.senderId,
    };
}

export function createDiscoverMessage(
    context: MessageContext
): DiscoverMessage {
    return {
        ...base("DISCOVER", context),
        type: "DISCOVER",
    };
}

export function createDiscoverResponseMessage(
    context: MessageContext,
    device: DeviceInfo
): DiscoverResponseMessage {
    return {
        ...base("DISCOVER_RESPONSE", context),
        type: "DISCOVER_RESPONSE",
        device,
    };
}

export function createConnectRequestMessage(
    context: MessageContext,
    device: DeviceInfo
): ConnectRequestMessage {
    return {
        ...base("CONNECT_REQUEST", context),
        type: "CONNECT_REQUEST",
        device,
    };
}

export function createConnectAcceptMessage(
    context: MessageContext,
    device: DeviceInfo
): ConnectAcceptMessage {
    return {
        ...base("CONNECT_ACCEPT", context),
        type: "CONNECT_ACCEPT",
        device,
    };
}

export function createConnectRejectMessage(
    context: MessageContext,
    reason: string
): ConnectRejectMessage {
    return {
        ...base("CONNECT_REJECT", context),
        type: "CONNECT_REJECT",
        reason,
    };
}

export function createTransferStartMessage(
    context: MessageContext,
    transferId: string,
    fileName: string,
    fileSize: number,
    totalChunks: number,
    checksum: string
): TransferStartMessage {
    return {
        ...base("TRANSFER_START", context),
        type: "TRANSFER_START",
        transferId,
        fileName,
        fileSize,
        totalChunks,
        checksum,
    };
}

export function createChunkMessage(
    context: MessageContext,
    transferId: string,
    chunkIndex: number,
    totalChunks: number,
    data: string,
    checksum: string
): ChunkMessage {
    return {
        ...base("CHUNK", context),
        type: "CHUNK",
        transferId,
        chunkIndex,
        totalChunks,
        data,
        checksum,
    };
}

export function createChunkAckMessage(
    context: MessageContext,
    transferId: string,
    chunkIndex: number
): ChunkAckMessage {
    return {
        ...base("CHUNK_ACK", context),
        type: "CHUNK_ACK",
        transferId,
        chunkIndex,
    };
}

export function createVerifyRequestMessage(
    context: MessageContext,
    transferId: string
): VerifyRequestMessage {
    return {
        ...base("VERIFY_REQUEST", context),
        type: "VERIFY_REQUEST",
        transferId,
    };
}

export function createVerifySuccessMessage(
    context: MessageContext,
    transferId: string,
    checksum: string
): VerifySuccessMessage {
    return {
        ...base("VERIFY_SUCCESS", context),
        type: "VERIFY_SUCCESS",
        transferId,
        checksum,
    };
}

export function createTransferCompleteMessage(
    context: MessageContext,
    transferId: string
): TransferCompleteMessage {
    return {
        ...base("TRANSFER_COMPLETE", context),
        type: "TRANSFER_COMPLETE",
        transferId,
    };
}