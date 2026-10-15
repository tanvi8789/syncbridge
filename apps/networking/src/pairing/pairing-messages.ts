import { MessageType } from "../message-types";

export type PairingMode = "pin" | "trusted";

/** Responder -> initiator: "prove you know the PIN / pairing secret." */
export interface ConnectChallenge {
    type: typeof MessageType.CONNECT_CHALLENGE;
    version: string;
    requestId: string;
    messageId: string;
    sequence: number;
    deviceId: string;
    sessionId: string;
    deviceName?: string;
    mode: PairingMode;
    nonce: string;
    publicKey: string;
    timestamp: number;
}

/** Initiator -> responder: nonce, key and the HMAC proof. */
export interface PairProof {
    type: typeof MessageType.PAIR_PROOF;
    version: string;
    requestId: string;
    messageId: string;
    sequence: number;
    deviceId: string;
    sessionId: string;
    nonce: string;
    publicKey: string;
    proof: string;
    timestamp: number;
}

/** Responder -> initiator: the PIN was wrong, try again. */
export interface PairRetry {
    type: typeof MessageType.PAIR_RETRY;
    version: string;
    requestId: string;
    messageId: string;
    sequence: number;
    deviceId: string;
    attemptsLeft: number;
    timestamp: number;
}

export type PairingEventType =
    | "PIN_DISPLAY"
    | "PIN_ENTRY"
    | "PAIRED"
    | "PAIRING_FAILED";

/** Surfaced to the UI (the PIN itself only ever appears in PIN_DISPLAY). */
export interface PairingEvent {
    type: PairingEventType;
    deviceId: string;
    deviceName?: string;
    pin?: string;
    attemptsLeft?: number;
    error?: string;
    expiresAt?: number;
    timestamp: number;
}

export interface PairingPrompt {
    kind: "display" | "entry";
    deviceId: string;
    deviceName?: string;
    pin?: string;
    attemptsLeft: number;
    error?: string;
    expiresAt: number;
}

export type PairingEventListener = (event: PairingEvent) => void;
