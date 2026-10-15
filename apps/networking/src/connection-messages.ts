import { MessageType } from "./message-types";

export interface ConnectRequest {
    type: typeof MessageType.CONNECT_REQUEST;
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

    /**
     * Responder's counter-proof that it also knew the PIN / pairing
     * secret. The initiator refuses an accept that lacks a valid one.
     */
    proof?: string;
    timestamp: number;
}

export type ConnectRejectReason =
    | "DUPLICATE_CONNECTION"
    | "VERSION_MISMATCH"
    | "SELF_CONNECTION"
    | "CONNECTION_TIMEOUT"
    | "BUSY"
    | "PAIRING_FAILED"
    | "AUTH_FAILED"
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
