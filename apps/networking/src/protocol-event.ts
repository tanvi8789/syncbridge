export type ProtocolEventType =
    | "DISCOVER_SENT"
    | "DISCOVER_RECEIVED"
    | "DISCOVER_RESPONSE_SENT"
    | "DEVICE_DISCOVERED"
    | "CONNECT_ATTEMPT"
    | "CONNECT_REQUEST_SENT"
    | "CONNECT_REQUEST_RECEIVED"
    | "CONNECT_ACCEPTED"
    | "CONNECT_REJECTED"
    | "PAIRING_CHALLENGE_SENT"
    | "PAIRING_CHALLENGE_RECEIVED"
    | "PAIRING_PROOF_SENT"
    | "PAIRING_VERIFIED"
    | "PAIRING_FAILED"
    | "CONNECTION_CLOSED"
    | "MALFORMED_MESSAGE";

export interface ProtocolEvent {
    id: string;
    timestamp: number;
    type: ProtocolEventType;
    layer: "discovery" | "connection" | "authentication" | "framing";
    deviceId?: string;
    sessionId?: string;
    detail?: string;
}

export type ProtocolEventListener = (event: ProtocolEvent) => void;
