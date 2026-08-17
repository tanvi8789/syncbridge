export interface DiscoveredDevice {
    deviceId: string;
    deviceName: string;
    ip: string;
    platform: string;
    lastSeen: number;
}

export class DeviceRegistry {
    private devices = new Map<string, DiscoveredDevice>();

    register(device: Omit<DiscoveredDevice, "lastSeen">): void {
        const existingDevice = this.devices.get(device.deviceId);

        const discoveredDevice: DiscoveredDevice = {
            ...device,
            lastSeen: Date.now(),
        };

        this.devices.set(device.deviceId, discoveredDevice);

        if (existingDevice) {
            console.log(
                `[REGISTRY] Updated device: ${device.deviceName}`
            );
        } else {
            console.log(
                `[REGISTRY] Discovered device: ${device.deviceName}`
            );
        }
    }

    getAll(): DiscoveredDevice[] {
        return Array.from(this.devices.values());
    }

    get(deviceId: string): DiscoveredDevice | undefined {
        return this.devices.get(deviceId);
    }

    remove(deviceId: string): boolean {
        return this.devices.delete(deviceId);
    }

    removeStale(timeoutMs: number): void {
        const now = Date.now();

        for (const [deviceId, device] of this.devices) {
            if (now - device.lastSeen > timeoutMs) {
                this.devices.delete(deviceId);

                console.log(
                    `[REGISTRY] Removed stale device: ${device.deviceName}`
                );
            }
        }
    }
}