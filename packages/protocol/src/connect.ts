import type { BaseMessage } from "./base.js";
import type { DeviceInfo } from "./device.js";

export interface ConnectRequestMessage extends BaseMessage {
    type: "CONNECT_REQUEST";

    device: DeviceInfo;
}

export interface ConnectAcceptMessage extends BaseMessage {
    type: "CONNECT_ACCEPT";

    sessionId: string;
    device: DeviceInfo;
}

export interface ConnectRejectMessage extends BaseMessage {
    type: "CONNECT_REJECT";

    reason: string;
}