import { MessageType } from "./message-types";

export interface ConnectRequest {
    type: typeof MessageType.CONNECT_REQUEST;
    version: string;
    requestId: string;
    messageId: string;
    sequence: number;
    deviceId: string;
    deviceName?: string;
    platform?: string;
    timestamp: number;
}

export interface ConnectAccept {
    type: typeof MessageType.CONNECT_ACCEPT;
    version: string;
    requestId: string;
    messageId: string;
    sequence: number;
    deviceId: string;
    sessionId: string;
    deviceName?: string;
    platform?: string;
    timestamp: number;
}

export type ConnectRejectReason =
    | "DUPLICATE_CONNECTION"
    | "VERSION_MISMATCH"
    | "SELF_CONNECTION"
    | "CONNECTION_TIMEOUT"
    | "BUSY"
    | "UNKNOWN_ERROR";

export interface ConnectReject {
    type: typeof MessageType.CONNECT_REJECT;
    version: string;
    requestId: string;
    messageId: string;
    sequence: number;
    deviceId: string;
    reason: ConnectRejectReason | string;
    timestamp: number;
}
