import { randomUUID } from "node:crypto";

export class DeviceIdentity {
    readonly deviceId: string;
    readonly deviceName: string;

    constructor() {
        this.deviceId = randomUUID();
        this.deviceName = "SyncBridge Device";
    }
}