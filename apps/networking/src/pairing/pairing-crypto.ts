import {
    createHmac,
    createPublicKey,
    diffieHellman,
    generateKeyPairSync,
    hkdfSync,
    createHash,
    randomBytes,
    randomInt,
    timingSafeEqual,
    type KeyObject,
} from "node:crypto";

/*
 * Pairing proves that both people typed (or read) the same PIN
 * without the PIN ever crossing the network.
 *
 *  - Each side contributes an ephemeral X25519 key and a nonce.
 *  - Each side then sends an HMAC, keyed by the PIN, over the whole
 *    transcript (both device IDs, both nonces, both public keys).
 *    Because the public keys are inside the transcript, an
 *    active man-in-the-middle who swaps keys cannot produce a valid
 *    proof without knowing the PIN.
 *  - On success the X25519 shared secret (which a passive observer
 *    cannot compute, even after brute-forcing the PIN from a
 *    captured transcript) is turned into a long-term pairing secret
 *    that later reconnects authenticate with instead of a PIN.
 */

export const PAIRING_PIN_LENGTH = 6;
export const PAIRING_MAX_ATTEMPTS = 3;
export const PAIRING_TIMEOUT_MS = 120_000;

export interface EphemeralKeys {
    privateKey: KeyObject;
    /** SPKI DER, base64. */
    publicKey: string;
}

export function generateEphemeralKeys(): EphemeralKeys {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");

    return {
        privateKey,
        publicKey: publicKey
            .export({ type: "spki", format: "der" })
            .toString("base64"),
    };
}

export function generateNonce(): string {
    return randomBytes(16).toString("hex");
}

export function generatePin(): string {
    return randomInt(0, 10 ** PAIRING_PIN_LENGTH)
        .toString()
        .padStart(PAIRING_PIN_LENGTH, "0");
}

export function isWellFormedPin(pin: unknown): pin is string {
    return (
        typeof pin === "string" &&
        new RegExp(`^\\d{${PAIRING_PIN_LENGTH}}$`).test(pin)
    );
}

export function isWellFormedPublicKey(value: unknown): value is string {
    if (typeof value !== "string" || value.length === 0 || value.length > 256) {
        return false;
    }

    try {
        createPublicKey({
            key: Buffer.from(value, "base64"),
            format: "der",
            type: "spki",
        });

        return true;
    } catch {
        return false;
    }
}

export interface Transcript {
    initiatorId: string;
    responderId: string;
    initiatorNonce: string;
    responderNonce: string;
    initiatorKey: string;
    responderKey: string;
}

function transcriptString(t: Transcript): string {
    return [
        "syncbridge-pairing-v1",
        t.initiatorId,
        t.responderId,
        t.initiatorNonce,
        t.responderNonce,
        t.initiatorKey,
        t.responderKey,
    ].join("|");
}

export type ProofRole = "initiator" | "responder";

/**
 * `secret` is the PIN when pairing for the first time, or the stored
 * pairing secret when an already-trusted device reconnects.
 */
export function computeProof(
    secret: string,
    role: ProofRole,
    transcript: Transcript
): string {
    return createHmac("sha256", secret)
        .update(`${role}|${transcriptString(transcript)}`)
        .digest("hex");
}

export function proofsMatch(expected: string, actual: unknown): boolean {
    if (typeof actual !== "string") {
        return false;
    }

    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(actual, "hex");

    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** The long-term secret both sides store after a successful pairing. */
export function derivePairingSecret(
    privateKey: KeyObject,
    peerPublicKey: string,
    transcript: Transcript
): string {
    const shared = diffieHellman({
        privateKey,
        publicKey: createPublicKey({
            key: Buffer.from(peerPublicKey, "base64"),
            format: "der",
            type: "spki",
        }),
    });

    const salt = createHash("sha256")
        .update(transcriptString(transcript))
        .digest();

    return Buffer.from(
        hkdfSync("sha256", shared, salt, "syncbridge-pairing-secret", 32)
    ).toString("hex");
}
