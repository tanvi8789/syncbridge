import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TrustedDevice {
    deviceId: string;
    deviceName: string;
    pairedAt: number;
    lastSeenAt?: number;
}

interface TrustRecord extends TrustedDevice {
    /** Hex pairing secret. Never leaves this file / process. */
    secret: string;
}

/**
 * Devices that completed PIN pairing. Persisted so a trusted device
 * reconnects without a PIN. The file holds secrets, so it is
 * written owner-read/write only.
 */
export class TrustStore {
    private readonly records = new Map<string, TrustRecord>();

    constructor(
        private readonly filePath: string = path.join(
            os.homedir(),
            ".syncbridge",
            "trusted-devices.json"
        )
    ) {
        this.load();
    }

    isTrusted(deviceId: string): boolean {
        return this.records.has(deviceId);
    }

    getSecret(deviceId: string): string | undefined {
        return this.records.get(deviceId)?.secret;
    }

    add(deviceId: string, deviceName: string, secret: string): void {
        this.records.set(deviceId, {
            deviceId,
            deviceName,
            secret,
            pairedAt: Date.now(),
        });
        this.save();
    }

    touch(deviceId: string): void {
        const record = this.records.get(deviceId);

        if (record) {
            record.lastSeenAt = Date.now();
            this.save();
        }
    }

    remove(deviceId: string): boolean {
        const removed = this.records.delete(deviceId);

        if (removed) {
            this.save();
        }

        return removed;
    }

    list(): TrustedDevice[] {
        return Array.from(this.records.values()).map(
            ({ secret: _secret, ...device }) => device
        );
    }

    private load(): void {
        try {
            const parsed = JSON.parse(
                fs.readFileSync(this.filePath, "utf8")
            ) as { devices?: TrustRecord[] };

            for (const record of parsed.devices ?? []) {
                if (
                    typeof record.deviceId === "string" &&
                    typeof record.secret === "string"
                ) {
                    this.records.set(record.deviceId, record);
                }
            }
        } catch {
            // First launch, or an unreadable file: start with no trust.
        }
    }

    private save(): void {
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(
                this.filePath,
                JSON.stringify({ devices: Array.from(this.records.values()) }),
                { mode: 0o600 }
            );
        } catch (error) {
            console.warn("[PAIRING] Could not persist trusted devices:", error);
        }
    }
}
