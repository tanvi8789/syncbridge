import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ConnectionManager } from "../connection/connection-manager";
import type { PairingEventListener } from "./pairing-messages";
import { TrustStore } from "./trust-store";

/**
 * Helpers for tests that run two ConnectionManagers in one process.
 * A throwaway trust file keeps test devices out of the real
 * ~/.syncbridge/trusted-devices.json.
 */
export function testTrustStore(): TrustStore {
    return new TrustStore(
        path.join(os.tmpdir(), `sb-test-trust-${randomUUID()}.json`)
    );
}

/**
 * Pairing listener for the *server* side: when it displays a PIN,
 * type it into the client, the way a person would.
 */
export function autoPairingListener(
    serverDeviceId: string,
    getClient: () => ConnectionManager | undefined
): PairingEventListener {
    return (event) => {
        if (event.type !== "PIN_DISPLAY" || !event.pin) {
            return;
        }

        const pin = event.pin;
        const deadline = Date.now() + 3000;

        // The client only asks for the PIN once the challenge arrives.
        const attempt = () => {
            try {
                getClient()?.submitPairingPin(serverDeviceId, pin);
            } catch {
                if (Date.now() < deadline) {
                    setTimeout(attempt, 50);
                }
            }
        };

        attempt();
    };
}
