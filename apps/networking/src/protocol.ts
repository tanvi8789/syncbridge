/* import { MessageType } from "./message-types";

export interface DiscoverMessage {
    type: typeof MessageType.DISCOVER;
    version: string;
    deviceId: string;
    timestamp: number;
}

export interface DiscoverResponse {
    type: typeof MessageType.DISCOVER_RESPONSE;
    deviceId: string;
    deviceName: string;
    ip: string;
    platform: string;
}

export function isDiscoverMessage(
    message: unknown
): message is DiscoverMessage {
    if (typeof message !== "object" || message === null) {
        return false;
    }

    const msg = message as Record<string, unknown>;

    return (
        msg.type === MessageType.DISCOVER &&
        typeof msg.version === "string" &&
        typeof msg.deviceId === "string" &&
        typeof msg.timestamp === "number"
    );
}

export function isDiscoverResponse(
    message: unknown
): message is DiscoverResponse {
    if (typeof message !== "object" || message === null) {
        return false;
    }

    const msg = message as Record<string, unknown>;

    return (
        msg.type === MessageType.DISCOVER_RESPONSE &&
        typeof msg.deviceId === "string" &&
        typeof msg.deviceName === "string" &&
        typeof msg.ip === "string" &&
        typeof msg.platform === "string"
    );
} */