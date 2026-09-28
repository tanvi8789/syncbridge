import dgram from "node:dgram";
import os from "node:os";
import { randomUUID } from "node:crypto";

import { DiscoverySocket } from "./socket";
import { DeviceIdentity } from "./device-identity";
import { DeviceRegistry } from "./device-registry";
import type { ProtocolEventListener } from "../protocol-event";

/*
 * Discovery runs at two cadences. While this device has no peer
 * connections it is actively looking for one, so it broadcasts
 * often. Once a connection is established the broadcast is only
 * keeping the registry warm and letting new devices notice us, so it
 * backs off sharply — this is what stops the protocol log filling
 * with DISCOVER/DISCOVER_RESPONSE traffic during a transfer.
 */
const SEARCHING_BROADCAST_INTERVAL_MS = 10_000;
const CONNECTED_BROADCAST_INTERVAL_MS = 60_000;

/*
 * A device is dropped after it misses this many broadcast rounds.
 * Deriving it from the current interval rather than hard-coding 30 s
 * means backing off the broadcast can't cause peers to be evicted
 * before they ever get a chance to answer.
 */
const STALE_ROUNDS = 3;

const CLEANUP_INTERVAL_MS = 10_000;

export class DiscoveryService {
    private socket: DiscoverySocket;
    private identity: DeviceIdentity;
    private registry: DeviceRegistry;

    private discoveryInterval?: NodeJS.Timeout;
    private cleanupInterval?: NodeJS.Timeout;

    private broadcastIntervalMs = SEARCHING_BROADCAST_INTERVAL_MS;
    private hasConnections = false;
    private running = false;

    constructor(
        identity: DeviceIdentity,
        private readonly onEvent?: ProtocolEventListener
    ) {
        this.identity = identity;
        this.registry = new DeviceRegistry();

        this.socket = new DiscoverySocket(
            (message, remote) =>
                this.handleMessage(message, remote)
        );
    }

    start(): void {
        this.socket.start();

        this.running = true;

        // Initial discovery after socket starts
        setTimeout(() => {
            this.broadcastDiscovery();
        }, 500);

        this.scheduleBroadcasts();

        // Drop devices that have missed several broadcast rounds
        this.cleanupInterval = setInterval(() => {
            this.registry.removeStale(
                this.getStaleTimeoutMs()
            );
        }, CLEANUP_INTERVAL_MS);
    }

    /**
     * Switch between the searching and connected broadcast cadences.
     *
     * Called by NetworkingEngine whenever a connection opens or
     * closes, so an idle-but-connected device stops flooding the LAN
     * (and the protocol event log) with discovery traffic.
     */
    setConnectionsActive(hasConnections: boolean): void {
        if (hasConnections === this.hasConnections) {
            return;
        }

        this.hasConnections = hasConnections;

        const nextInterval = hasConnections
            ? CONNECTED_BROADCAST_INTERVAL_MS
            : SEARCHING_BROADCAST_INTERVAL_MS;

        if (nextInterval === this.broadcastIntervalMs) {
            return;
        }

        this.broadcastIntervalMs = nextInterval;

        console.log(
            `[DISCOVERY] ${
                hasConnections ? "Connected" : "Searching"
            } — broadcasting every ${nextInterval / 1000}s ` +
                `(devices go stale after ${this.getStaleTimeoutMs() / 1000}s)`
        );

        if (this.running) {
            this.scheduleBroadcasts();
        }
    }

    getBroadcastIntervalMs(): number {
        return this.broadcastIntervalMs;
    }

    private getStaleTimeoutMs(): number {
        return this.broadcastIntervalMs * STALE_ROUNDS;
    }

    private scheduleBroadcasts(): void {
        if (this.discoveryInterval) {
            clearInterval(this.discoveryInterval);
        }

        this.discoveryInterval = setInterval(() => {
            this.broadcastDiscovery();
        }, this.broadcastIntervalMs);
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

        this.socket.sendBroadcast(payload, this.getBroadcastAddresses());
        this.emit("DISCOVER_SENT");
    }

    private handleMessage(
        message: Buffer,
        remote: dgram.RemoteInfo
    ): void {
        console.log(
            `[DISCOVERY] Received packet from ${remote.address}:${remote.port}`
        );
        this.emit("DISCOVER_RECEIVED", remote.address);

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

        /*
         * Ignore messages originating from this device.
         *
         * Because UDP broadcast is received by the sender
         * as well, seeing our own DISCOVER is normal.
         */
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

        /*
         * Another device is looking for peers.
         */
        if (
            typeof parsedMessage === "object" &&
            parsedMessage !== null &&
            "type" in parsedMessage &&
            parsedMessage.type === "DISCOVER"
        ) {
            this.sendDiscoveryResponse(remote);

            return;
        }

        /*
         * Another device responded to our discovery.
         */
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
        /*
         * IMPORTANT:
         *
         * remote.address = address of the OTHER device.
         *
         * We must advertise OUR OWN IP address instead.
         */
        const localIp = this.getLocalIpAddress();

        if (!localIp) {
            console.error(
                "[DISCOVERY] Could not determine local IP address"
            );

            return;
        }

        const response = {
            type: "DISCOVER_RESPONSE",

            deviceId:
                this.identity.deviceId,

            deviceName:
                this.identity.deviceName,

            ip: localIp,

            platform:
                process.platform,
        };

        const payload = Buffer.from(
            JSON.stringify(response)
        );

        console.log(
            `[DISCOVERY] Sending DISCOVER_RESPONSE to ${remote.address}:${remote.port}`
        );

        console.log(
            `[DISCOVERY] Advertising local IP: ${localIp}`
        );

        this.socket.send(
            payload,
            remote.address,
            remote.port
        );
        this.emit("DISCOVER_RESPONSE_SENT", remote.address);
    }

    /**
     * Find the IPv4 address of the machine
     * that is running SyncBridge.
     */
    private getLocalIpAddress(): string | undefined {
        const interfaces =
            os.networkInterfaces();

        for (const interfaceName of Object.keys(
            interfaces
        )) {
            const addresses =
                interfaces[interfaceName];

            if (!addresses) {
                continue;
            }

            for (const address of addresses) {
                /*
                 * We only want:
                 * - IPv4
                 * - non-internal address
                 */
                if (
                    address.family === "IPv4" &&
                    !address.internal
                ) {
                    return address.address;
                }
            }
        }

        return undefined;
    }

    private getBroadcastAddresses(): string[] {
        const addresses = new Set<string>();
        for (const entries of Object.values(os.networkInterfaces())) {
            for (const entry of entries ?? []) {
                if (entry.family !== "IPv4" || entry.internal || !entry.netmask) continue;
                const ip = entry.address.split(".").map(Number);
                const mask = entry.netmask.split(".").map(Number);
                if (ip.length !== 4 || mask.length !== 4) continue;
                addresses.add(ip.map((octet, index) => octet | (255 ^ mask[index])).join("."));
            }
        }
        return addresses.size > 0 ? [...addresses] : ["255.255.255.255"];
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

        const deviceId =
            message.deviceId;

        const deviceName =
            message.deviceName;

        const ip =
            message.ip;

        const platform =
            message.platform;

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

        /*
         * Never register ourselves.
         *
         * This is an additional safety check in case
         * a response somehow contains our own device ID.
         */
        if (
            deviceId === this.identity.deviceId
        ) {
            console.log(
                "[DISCOVERY] Ignoring own device response"
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
        this.emit("DEVICE_DISCOVERED", deviceId, deviceName);
    }

    getDevices() {
        return this.registry.getAll();
    }

    stop(): void {
        this.running = false;

        // Stop discovery broadcast timer
        if (this.discoveryInterval) {
            clearInterval(
                this.discoveryInterval
            );

            this.discoveryInterval =
                undefined;
        }

        // Stop stale-device cleanup timer
        if (this.cleanupInterval) {
            clearInterval(
                this.cleanupInterval
            );

            this.cleanupInterval =
                undefined;
        }

        // Close UDP socket
        this.socket.stop();

        console.log(
            "[DISCOVERY] Discovery service stopped"
        );
    }

    private emit(
        type: "DISCOVER_SENT" | "DISCOVER_RECEIVED" | "DISCOVER_RESPONSE_SENT" | "DEVICE_DISCOVERED",
        deviceId?: string,
        detail?: string
    ): void {
        this.onEvent?.({
            id: randomUUID(),
            timestamp: Date.now(),
            type,
            layer: "discovery",
            deviceId,
            detail,
        });
    }
}
