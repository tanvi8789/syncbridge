export const MessageType = {
    DISCOVER: "DISCOVER",
    DISCOVER_RESPONSE: "DISCOVER_RESPONSE",

    CONNECT_REQUEST: "CONNECT_REQUEST",
    CONNECT_ACCEPT: "CONNECT_ACCEPT",
    CONNECT_REJECT: "CONNECT_REJECT",
} as const;

export type MessageType =
    typeof MessageType[keyof typeof MessageType];