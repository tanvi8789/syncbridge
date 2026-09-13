import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class DeviceIdentity {
    readonly deviceId: string;
    readonly deviceName: string;

    constructor() {
        const statePath = path.join(os.homedir(), ".syncbridge", "identity.json");
        let deviceId: string | undefined;
        try {
            const saved = JSON.parse(fs.readFileSync(statePath, "utf8")) as { deviceId?: unknown };
            if (typeof saved.deviceId === "string" && saved.deviceId.length > 0) deviceId = saved.deviceId;
        } catch {
            // First launch, or an unreadable old state file.
        }
        this.deviceId = deviceId ?? randomUUID();
        this.deviceName = os.hostname();
        if (!deviceId) {
            try {
                fs.mkdirSync(path.dirname(statePath), { recursive: true });
                fs.writeFileSync(statePath, JSON.stringify({ deviceId: this.deviceId }), { mode: 0o600 });
            } catch (error) {
                console.warn("[IDENTITY] Could not persist device identity:", error);
            }
        }
    }
}
