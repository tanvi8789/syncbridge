export const MessageType = {
    DISCOVER: "DISCOVER",
    DISCOVER_RESPONSE: "DISCOVER_RESPONSE",

    CONNECT_REQUEST: "CONNECT_REQUEST",
    CONNECT_ACCEPT: "CONNECT_ACCEPT",
    CONNECT_REJECT: "CONNECT_REJECT",
    CONNECT_CHALLENGE: "CONNECT_CHALLENGE",

    PAIR_PROOF: "PAIR_PROOF",
    PAIR_RETRY: "PAIR_RETRY",
} as const;

export type MessageType =
    typeof MessageType[keyof typeof MessageType];