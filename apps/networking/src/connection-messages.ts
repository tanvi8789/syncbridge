import { MessageType } from "./message-types";

export interface ConnectRequest {
    type: typeof MessageType.CONNECT_REQUEST;
    version: string;
    requestId: string;
    deviceId: string;
    timestamp: number;
}

export interface ConnectAccept {
    type: typeof MessageType.CONNECT_ACCEPT;
    version: string;
    requestId: string;
    deviceId: string;
    timestamp: number;
}

export interface ConnectReject {
    type: typeof MessageType.CONNECT_REJECT;
    version: string;
    requestId: string;
    deviceId: string;
    reason: string;
    timestamp: number;
}