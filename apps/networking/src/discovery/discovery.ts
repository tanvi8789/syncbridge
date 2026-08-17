import dgram from "node:dgram";
import { DiscoverySocket } from "./socket";
import { DeviceIdentity } from "./device-identity";
import { DeviceRegistry } from "./device-registry";

export class DiscoveryService {
    private socket: DiscoverySocket;
    private identity: DeviceIdentity;
    private registry: DeviceRegistry;

    private discoveryInterval?: NodeJS.Timeout;
    private cleanupInterval?: NodeJS.Timeout;

    constructor(identity: DeviceIdentity) {
        this.identity = identity;
        this.registry = new DeviceRegistry();

        this.socket = new DiscoverySocket(
            (message, remote) =>
                this.handleMessage(message, remote)
        );
    }

    start(): void {
        this.socket.start();

        // Initial discovery after socket starts
        setTimeout(() => {
            this.broadcastDiscovery();
        }, 500);

        // Broadcast discovery every 10 seconds
        this.discoveryInterval = setInterval(() => {
            this.broadcastDiscovery();
        }, 10_000);

        // Remove devices that haven't been seen for 30 seconds
        this.cleanupInterval = setInterval(() => {
            this.registry.removeStale(30_000);
        }, 10_000);
    }

    private broadcastDiscovery(): void {
        const message = {
            type: "DISCOVER",
            version: "1.0.0",
            deviceId: this.identity.deviceId,
            timestamp: Date.now(),
        };

        const payload = Buffer.from(
            JSON.stringify(message)
        );

        console.log(
            "[DISCOVERY] Broadcasting DISCOVER"
        );

        this.socket.sendBroadcast(payload);
    }

    private handleMessage(
        message: Buffer,
        remote: dgram.RemoteInfo
    ): void {
        console.log(
            `[DISCOVERY] Received packet from ${remote.address}:${remote.port}`
        );

        let parsedMessage: unknown;

        try {
            parsedMessage = JSON.parse(
                message.toString()
            );
        } catch {
            console.log(
                "[DISCOVERY] Ignoring invalid JSON packet"
            );
            return;
        }

        console.log(
            "[DISCOVERY] Parsed message:",
            parsedMessage
        );

        // Ignore messages originating from this device
        if (
            typeof parsedMessage === "object" &&
            parsedMessage !== null &&
            "deviceId" in parsedMessage &&
            parsedMessage.deviceId ===
                this.identity.deviceId
        ) {
            console.log(
                "[DISCOVERY] Ignoring own broadcast"
            );
            return;
        }

        // Handle DISCOVER
        if (
            typeof parsedMessage === "object" &&
            parsedMessage !== null &&
            "type" in parsedMessage &&
            parsedMessage.type === "DISCOVER"
        ) {
            this.sendDiscoveryResponse(remote);
            return;
        }

        // Handle DISCOVER_RESPONSE
        if (
            typeof parsedMessage === "object" &&
            parsedMessage !== null &&
            "type" in parsedMessage &&
            parsedMessage.type ===
                "DISCOVER_RESPONSE"
        ) {
            this.handleDiscoveryResponse(
                parsedMessage
            );
            return;
        }

        console.log(
            "[DISCOVERY] Unknown message type"
        );
    }

    private sendDiscoveryResponse(
        remote: dgram.RemoteInfo
    ): void {
        const response = {
            type: "DISCOVER_RESPONSE",
            deviceId: this.identity.deviceId,
            deviceName: this.identity.deviceName,
            ip: remote.address,
            platform: process.platform,
        };

        const payload = Buffer.from(
            JSON.stringify(response)
        );

        console.log(
            `[DISCOVERY] Sending DISCOVER_RESPONSE to ${remote.address}:${remote.port}`
        );

        this.socket.send(
            payload,
            remote.address,
            remote.port
        );
    }

    private handleDiscoveryResponse(
        message: object
    ): void {
        console.log(
            "[DISCOVERY] Received DISCOVER_RESPONSE"
        );

        // Make sure all required fields exist
        if (
            !("deviceId" in message) ||
            !("deviceName" in message) ||
            !("ip" in message) ||
            !("platform" in message)
        ) {
            console.log(
                "[DISCOVERY] Invalid DISCOVER_RESPONSE"
            );
            return;
        }

        const deviceId = message.deviceId;
        const deviceName = message.deviceName;
        const ip = message.ip;
        const platform = message.platform;

        // Validate field types
        if (
            typeof deviceId !== "string" ||
            typeof deviceName !== "string" ||
            typeof ip !== "string" ||
            typeof platform !== "string"
        ) {
            console.log(
                "[DISCOVERY] Invalid DISCOVER_RESPONSE fields"
            );
            return;
        }

        console.log(
            `[DISCOVERY] Device ID: ${deviceId}`
        );

        console.log(
            `[DISCOVERY] Device Name: ${deviceName}`
        );

        console.log(
            `[DISCOVERY] IP: ${ip}`
        );

        console.log(
            `[DISCOVERY] Platform: ${platform}`
        );

        // Add or update device in registry
        this.registry.register({
            deviceId,
            deviceName,
            ip,
            platform,
        });
    }

    getDevices() {
        return this.registry.getAll();
    }

    stop(): void {
        // Stop discovery broadcast timer
        if (this.discoveryInterval) {
            clearInterval(this.discoveryInterval);
            this.discoveryInterval = undefined;
        }

        // Stop stale-device cleanup timer
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = undefined;
        }

        // Close UDP socket
        this.socket.stop();

        console.log(
            "[DISCOVERY] Discovery service stopped"
        );
    }
}