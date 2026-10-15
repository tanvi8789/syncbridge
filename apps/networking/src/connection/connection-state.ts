export const ConnectionState = {
    DISCONNECTED: "DISCONNECTED",
    CONNECTING: "CONNECTING",
    AWAITING_PIN: "AWAITING_PIN",
    CONNECTED: "CONNECTED",
    REJECTED: "REJECTED",
    FAILED: "FAILED",
    CLOSING: "CLOSING",
} as const;

export type ConnectionState =
    typeof ConnectionState[keyof typeof ConnectionState];