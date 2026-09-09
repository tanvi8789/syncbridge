export const MessageType = {
    // Discovery
    DISCOVER: "DISCOVER",
    DISCOVER_RESPONSE: "DISCOVER_RESPONSE",

    // Connection
    CONNECT_REQUEST: "CONNECT_REQUEST",
    CONNECT_ACCEPT: "CONNECT_ACCEPT",
    CONNECT_REJECT: "CONNECT_REJECT",

    // Synchronization / transfer negotiation
    SYNC_REQUEST: "SYNC_REQUEST",
    TRANSFER_START: "TRANSFER_START",

    // Data transfer
    CHUNK: "CHUNK",
    CHUNK_ACK: "CHUNK_ACK",

    // Verification
    VERIFY_REQUEST: "VERIFY_REQUEST",
    VERIFY_SUCCESS: "VERIFY_SUCCESS",

    // Completion / errors
    TRANSFER_COMPLETE: "TRANSFER_COMPLETE",
    TRANSFER_CANCEL: "TRANSFER_CANCEL",
    ERROR: "ERROR",
} as const;

export type MessageType =
    typeof MessageType[keyof typeof MessageType];