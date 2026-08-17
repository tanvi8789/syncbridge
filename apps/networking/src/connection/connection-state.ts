export const ConnectionState = {
    DISCONNECTED: "DISCONNECTED",
    CONNECTING: "CONNECTING",
    CONNECTED: "CONNECTED",
    REJECTED: "REJECTED",
} as const;

export type ConnectionState =
    typeof ConnectionState[keyof typeof ConnectionState];