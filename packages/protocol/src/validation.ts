import type { ProtocolMessage } from "./messages.js";

const messageTypes = new Set([
    "DISCOVER",
    "DISCOVER_RESPONSE",
    "CONNECT_REQUEST",
    "CONNECT_ACCEPT",
    "CONNECT_REJECT",
    "TRANSFER_START",
    "CHUNK",
    "CHUNK_ACK",
    "VERIFY_REQUEST",
    "VERIFY_SUCCESS",
    "TRANSFER_COMPLETE",
]);

export interface ValidationResult {
    valid: boolean;
    errors: string[];
}

export function validateMessage(
    message: unknown
): ValidationResult {
    const errors: string[] = [];

    if (
        typeof message !== "object" ||
        message === null
    ) {
        return {
            valid: false,
            errors: ["Message must be an object"],
        };
    }

    const candidate =
        message as Record<string, unknown>;

    if (
        typeof candidate.type !== "string" ||
        !messageTypes.has(candidate.type)
    ) {
        errors.push("Invalid or unknown message type");
    }

    if (
        typeof candidate.version !== "string"
    ) {
        errors.push("Missing or invalid version");
    }

    if (
        typeof candidate.messageId !== "string" ||
        candidate.messageId.length === 0
    ) {
        errors.push("Missing messageId");
    }

    if (
        typeof candidate.sessionId !== "string" ||
        candidate.sessionId.length === 0
    ) {
        errors.push("Missing sessionId");
    }

    if (
        typeof candidate.senderId !== "string" ||
        candidate.senderId.length === 0
    ) {
        errors.push("Missing senderId");
    }

    if (
        typeof candidate.timestamp !== "number"
    ) {
        errors.push("Missing or invalid timestamp");
    }

    if (
        typeof candidate.sequence !== "number" ||
        !Number.isInteger(candidate.sequence) ||
        candidate.sequence < 0
    ) {
        errors.push("Invalid sequence number");
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}

export function isProtocolMessage(
    message: unknown
): message is ProtocolMessage {
    return validateMessage(message).valid;
}