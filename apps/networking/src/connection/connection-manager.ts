import net from "node:net";
import { randomUUID } from "node:crypto";

import { MessageType } from "../message-types";
import type {
    ConnectRequest,
    ConnectAccept,
    ConnectReject,
    ConnectRejectReason,
} from "../connection-messages";

import type { DiscoveredDevice } from "../discovery/device-registry";
import { ConnectionState } from "./connection-state";

import {
    encodeMessage,
    MessageFramer,
} from "./framing";

import { TransferManager } from "../transfer/transfer-manager";
import type {
    ProtocolEventListener,
    ProtocolEventType,
} from "../protocol-event";

const PROTOCOL_VERSION = "1.0.0";
const TCP_PORT = 41236;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;

export interface Connection {
    socket: net.Socket;
    state: ConnectionState;
    framer: MessageFramer;
    deviceId?: string;
    deviceName?: string;
    platform?: string;
    sessionId?: string;
    connectedAt?: number;
    rejectReason?: string;
}

export class ConnectionManager {
    private connections = new Map<
        string,
        Connection
    >();

    private socketToDeviceId = new Map<net.Socket, string>();
    private pendingSockets = new Set<net.Socket>();
    private nextSequence = 0;

    private transferManager: TransferManager;

    constructor(
        private readonly deviceId: string,
        private readonly deviceName: string = "SyncBridge Node",
        private readonly tcpPort: number = TCP_PORT,
        private readonly connectionTimeoutMs: number = DEFAULT_CONNECTION_TIMEOUT_MS,
        private readonly onEvent?: ProtocolEventListener
    ) {
        this.transferManager =
            new TransferManager();
    }

    async connectToDevice(
        device: DiscoveredDevice
    ): Promise<void> {
        if (device.deviceId === this.deviceId) {
            throw new Error("Cannot connect to own device");
        }

        const existing = this.connections.get(device.deviceId);
        if (
            existing &&
            (existing.state === ConnectionState.CONNECTED ||
                existing.state === ConnectionState.CONNECTING)
        ) {
            console.log(
                `[CONNECTION] Already connected or connecting to ${device.deviceName}`
            );
            return;
        }

        console.log(
            `[CONNECTION] Connecting to ${device.deviceName} at ${device.ip}:${this.tcpPort}`
        );
        this.emit("CONNECT_ATTEMPT", device.deviceId, undefined, device.deviceName);

        const socket = new net.Socket();
        const framer = this.createFramer(device.deviceId);

        const connection: Connection = {
            socket,
            state: ConnectionState.CONNECTING,
            framer,
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            platform: device.platform,
        };

        this.connections.set(device.deviceId, connection);
        this.socketToDeviceId.set(socket, device.deviceId);

        let timeoutTimer: NodeJS.Timeout | null = null;

        const cleanupListeners = () => {
            if (timeoutTimer) {
                clearTimeout(timeoutTimer);
                timeoutTimer = null;
            }
        };

        socket.on("error", (error) => {
            console.error(
                `[CONNECTION] Error connecting to ${device.deviceName}:`,
                error
            );
            cleanupListeners();
            if (connection.state === ConnectionState.CONNECTING) {
                connection.state = ConnectionState.FAILED;
                connection.rejectReason = error.message;
            }
            this.handleSocketTermination(device.deviceId, socket);
        });

        socket.on("close", () => {
            console.log(
                `[CONNECTION] Connection closed: ${device.deviceName}`
            );
            cleanupListeners();
            this.handleSocketTermination(device.deviceId, socket);
        });

        socket.on("data", (data) => {
            const buffer = Buffer.isBuffer(data)
                ? data
                : Buffer.from(data);

            const messages =
                framer.addData(buffer);

            for (const message of messages) {
                this.handleMessage(
                    socket,
                    device.deviceId,
                    message
                );
            }
        });

        await new Promise<void>(
            (resolve, reject) => {
                timeoutTimer = setTimeout(() => {
                    cleanupListeners();
                    console.error(
                        `[CONNECTION] Connection to ${device.deviceName} timed out after ${this.connectionTimeoutMs}ms`
                    );
                    connection.state = ConnectionState.FAILED;
                    connection.rejectReason = "CONNECTION_TIMEOUT";
                    socket.destroy(new Error("Connection timed out"));
                    reject(new Error("Connection timed out"));
                }, this.connectionTimeoutMs);

                socket.connect(
                    this.tcpPort,
                    device.ip,
                    () => {
                        cleanupListeners();
                        console.log(
                            `[CONNECTION] TCP connection established with ${device.deviceName}`
                        );

                        this.sendConnectRequest(
                            socket
                        );

                        resolve();
                    }
                );

                socket.once(
                    "error",
                    (err) => {
                        cleanupListeners();
                        reject(err);
                    }
                );
            }
        );
    }

    async sendFile(
        peerDeviceId: string,
        filePath: string
    ): Promise<void> {
        const connection =
            this.connections.get(peerDeviceId);

        if (!connection) {
            console.error(
                `[CONNECTION] No connection found for ${peerDeviceId}`
            );
            return;
        }

        if (
            connection.state !==
            ConnectionState.CONNECTED
        ) {
            console.error(
                `[CONNECTION] Peer ${peerDeviceId} is not connected`
            );
            return;
        }

        const fs = await import("node:fs/promises");
        const path = await import("node:path");

        const stats =
            await fs.stat(filePath);

        if (!stats.isFile()) {
            console.error(
                `[CONNECTION] Not a file: ${filePath}`
            );
            return;
        }

        const fileName =
            path.basename(filePath);

        const transferId =
            this.transferManager.requestTransfer(
                connection.socket,
                this.deviceId,
                fileName
            );

        console.log(
            `[CONNECTION] File transfer requested: ${transferId}`
        );
    }

    getConnections() {
        return Array.from(
            this.connections.entries()
        ).map(
            ([deviceId, connection]) => ({
                deviceId,
                deviceName: connection.deviceName,
                state: connection.state,
                sessionId: connection.sessionId,
                remoteAddress:
                    connection.socket.remoteAddress,
                remotePort:
                    connection.socket.remotePort,
                connectedAt: connection.connectedAt,
                rejectReason: connection.rejectReason,
            })
        );
    }

    getTransfers() {
        return this.transferManager.getTransfers();
    }

    handleIncomingConnection(
        socket: net.Socket
    ): void {
        console.log(
            `[CONNECTION] Handling incoming TCP connection from ${socket.remoteAddress}:${socket.remotePort}`
        );

        this.pendingSockets.add(socket);
        const framer = this.createFramer();

        const onPendingClose = () => {
            this.pendingSockets.delete(socket);
            const deviceId = this.socketToDeviceId.get(socket);
            if (deviceId) {
                this.handleSocketTermination(deviceId, socket);
            }
        };

        socket.on("close", onPendingClose);
        socket.on("error", (error) => {
            console.error(
                `[CONNECTION] Socket error from ${socket.remoteAddress}:`,
                error
            );
            onPendingClose();
        });

        socket.on("data", (data) => {
            const buffer = Buffer.isBuffer(data)
                ? data
                : Buffer.from(data);

            const messages =
                framer.addData(buffer);

            for (const message of messages) {
                const mappedDeviceId = this.socketToDeviceId.get(socket);
                if (mappedDeviceId) {
                    this.handleMessage(socket, mappedDeviceId, message);
                } else {
                    this.handlePendingMessage(socket, framer, message);
                }
            }
        });
    }

    private handlePendingMessage(
        socket: net.Socket,
        framer: MessageFramer,
        message: object
    ): void {
        if (!("type" in message) || message.type !== MessageType.CONNECT_REQUEST) {
            console.warn(
                "[CONNECTION] Rejecting message before handshake on incoming socket"
            );
            return;
        }

        const request = message as ConnectRequest;
        this.handleConnectRequest(socket, framer, request);
    }

    private sendConnectRequest(
        socket: net.Socket
    ): void {
        const request: ConnectRequest = {
            type:
                MessageType.CONNECT_REQUEST,

            version: PROTOCOL_VERSION,

            requestId: randomUUID(),

            messageId: randomUUID(),

            sequence: this.nextSequence++,

            deviceId: this.deviceId,

            deviceName: this.deviceName,

            platform: process.platform,

            timestamp: Date.now(),
        };

        this.sendMessage(
            socket,
            request
        );

        console.log(
            "[CONNECTION] CONNECT_REQUEST sent"
        );
        this.emit("CONNECT_REQUEST_SENT");
    }

    private handleMessage(
        socket: net.Socket,
        peerDeviceId: string,
        message: object
    ): void {
        if (!("type" in message)) {
            console.error(
                "[CONNECTION] Invalid message received"
            );

            return;
        }

        const messageType =
            message.type;

        if (
            typeof messageType !==
            "string"
        ) {
            console.error(
                "[CONNECTION] Invalid message type"
            );

            return;
        }

        console.log(
            `[CONNECTION] Received message: ${messageType}`
        );

        /*
         * Route file-transfer messages
         * to TransferManager.
         */
        if (
            messageType.startsWith(
                "FILE_"
            )
        ) {
            this.transferManager.handleMessage(
                socket,
                message
            );

            return;
        }

        /*
         * Handle connection protocol
         * messages.
         */
        switch (messageType) {
            case MessageType.CONNECT_REQUEST:
                this.handleConnectRequest(
                    socket,
                    new MessageFramer(),
                    message as ConnectRequest
                );

                break;

            case MessageType.CONNECT_ACCEPT:
                this.handleConnectAccept(
                    peerDeviceId,
                    message as ConnectAccept
                );

                break;

            case MessageType.CONNECT_REJECT:
                this.handleConnectReject(
                    peerDeviceId,
                    message as ConnectReject
                );

                break;

            default:
                console.log(
                    `[CONNECTION] Unknown message type: ${messageType}`
                );
        }
    }

    private handleConnectRequest(
        socket: net.Socket,
        framer: MessageFramer,
        request: ConnectRequest
    ): void {
        if (!this.isValidConnectRequest(request)) {
            console.warn("[CONNECTION] Rejecting malformed CONNECT_REQUEST");
            this.emit("MALFORMED_MESSAGE", undefined, undefined, "Invalid CONNECT_REQUEST");
            socket.destroy();
            this.pendingSockets.delete(socket);
            return;
        }

        console.log(
            `[CONNECTION] CONNECT_REQUEST received from ${request.deviceId} (version: ${request.version})`
        );
        this.emit("CONNECT_REQUEST_RECEIVED", request.deviceId);

        // 1. Check self connection
        if (request.deviceId === this.deviceId) {
            console.warn("[CONNECTION] Rejecting self-connection");
            this.sendConnectReject(socket, request.requestId, request.deviceId, "SELF_CONNECTION");
            socket.destroy();
            this.pendingSockets.delete(socket);
            return;
        }

        // 2. Check protocol version compatibility (major version check)
        const peerMajor = request.version ? request.version.split(".")[0] : "";
        const localMajor = PROTOCOL_VERSION.split(".")[0];
        if (peerMajor !== localMajor) {
            console.warn(
                `[CONNECTION] Rejecting incompatible protocol version: ${request.version} (expected: ${PROTOCOL_VERSION})`
            );
            this.sendConnectReject(socket, request.requestId, request.deviceId, "VERSION_MISMATCH");
            socket.destroy();
            this.pendingSockets.delete(socket);
            return;
        }

        // 3. Check duplicate active connection
        const existing = this.connections.get(request.deviceId);
        if (existing && existing.state === ConnectionState.CONNECTED) {
            console.warn(
                `[CONNECTION] Rejecting duplicate connection from ${request.deviceId}`
            );
            this.sendConnectReject(socket, request.requestId, request.deviceId, "DUPLICATE_CONNECTION");
            socket.destroy();
            this.pendingSockets.delete(socket);
            return;
        }

        // 4. Accept connection & establish session
        const sessionId = randomUUID();
        const response: ConnectAccept = {
            type: MessageType.CONNECT_ACCEPT,
            version: PROTOCOL_VERSION,
            requestId: request.requestId,
            messageId: randomUUID(),
            sequence: this.nextSequence++,
            deviceId: this.deviceId,
            sessionId,
            deviceName: this.deviceName,
            platform: process.platform,
            timestamp: Date.now(),
        };

        this.sendMessage(socket, response);
        console.log(
            `[CONNECTION] CONNECT_ACCEPT sent to ${request.deviceId}, sessionId: ${sessionId}`
        );

        this.pendingSockets.delete(socket);
        this.socketToDeviceId.set(socket, request.deviceId);

        const connection: Connection = {
            socket,
            state: ConnectionState.CONNECTED,
            framer,
            sessionId,
            deviceId: request.deviceId,
            deviceName: request.deviceName,
            platform: request.platform,
            connectedAt: Date.now(),
        };

        this.connections.set(request.deviceId, connection);
        console.log(`[CONNECTION] Peer ${request.deviceId} is now CONNECTED`);
        this.emit("CONNECT_ACCEPTED", request.deviceId, sessionId);
    }

    private handleConnectAccept(
        peerDeviceId: string,
        response: ConnectAccept
    ): void {
        console.log(
            `[CONNECTION] CONNECT_ACCEPT received from ${response.deviceId}, sessionId: ${response.sessionId}`
        );

        const connection =
            this.connections.get(
                peerDeviceId
            );

        if (!connection) {
            console.error(
                `[CONNECTION] No connection found for ${peerDeviceId}`
            );

            return;
        }

        if (!this.isValidConnectAccept(response)) {
            connection.state = ConnectionState.FAILED;
            connection.rejectReason = "INVALID_CONNECT_ACCEPT";
            this.emit("MALFORMED_MESSAGE", peerDeviceId, undefined, "Invalid CONNECT_ACCEPT");
            connection.socket.destroy();
            return;
        }

        connection.state =
            ConnectionState.CONNECTED;
        connection.sessionId = response.sessionId;
        connection.connectedAt = Date.now();
        connection.deviceName = response.deviceName ?? connection.deviceName;
        connection.platform = response.platform ?? connection.platform;
        connection.rejectReason = undefined;

        console.log(
            `[CONNECTION] Peer ${peerDeviceId} is CONNECTED (session: ${connection.sessionId})`
        );
        this.emit("CONNECT_ACCEPTED", peerDeviceId, connection.sessionId);
    }

    private handleConnectReject(
        peerDeviceId: string,
        response: ConnectReject
    ): void {
        console.log(
            `[CONNECTION] CONNECT_REJECT received from ${response.deviceId}`
        );

        console.log(
            `[CONNECTION] Reason: ${response.reason}`
        );

        const connection =
            this.connections.get(
                peerDeviceId
            );

        if (connection) {
            connection.state =
                ConnectionState.REJECTED;
            connection.rejectReason = response.reason;
            connection.socket.destroy();
        }

        this.handleSocketTermination(peerDeviceId);
        this.emit("CONNECT_REJECTED", peerDeviceId, undefined, response.reason);
    }

    private sendConnectReject(
        socket: net.Socket,
        requestId: string,
        targetDeviceId: string,
        reason: ConnectRejectReason
    ): void {
        const reject: ConnectReject = {
            type: MessageType.CONNECT_REJECT,
            version: PROTOCOL_VERSION,
            requestId,
            messageId: randomUUID(),
            sequence: this.nextSequence++,
            deviceId: this.deviceId,
            reason,
            timestamp: Date.now(),
        };

        this.sendMessage(socket, reject);
    }

    private handleSocketTermination(deviceId: string, socket?: net.Socket): void {
        const connection = this.connections.get(deviceId);
        if (connection && (!socket || connection.socket === socket)) {
            this.connections.delete(deviceId);
            this.socketToDeviceId.delete(connection.socket);
            this.emit("CONNECTION_CLOSED", deviceId, connection.sessionId);
        }
        if (socket) {
            this.pendingSockets.delete(socket);
            this.socketToDeviceId.delete(socket);
        }
    }

    disconnectDevice(deviceId: string): boolean {
        const connection = this.connections.get(deviceId);
        if (!connection) {
            return false;
        }

        console.log(`[CONNECTION] Disconnecting session with ${deviceId}`);
        connection.state = ConnectionState.CLOSING;
        connection.socket.destroy();
        this.connections.delete(deviceId);
        this.socketToDeviceId.delete(connection.socket);
        this.emit("CONNECTION_CLOSED", deviceId, connection.sessionId);
        return true;
    }

    private sendMessage(
        socket: net.Socket,
        message: object
    ): void {
        const payload =
            encodeMessage(message);

        socket.write(payload);
    }

    getConnectedDevices(): string[] {
        const connectedDevices: string[] = [];

        for (const [deviceId, connection] of this.connections) {
            if (
                connection.state ===
                ConnectionState.CONNECTED
            ) {
                connectedDevices.push(deviceId);
            }
        }

        return connectedDevices;
    }

    async sendFileToFirstConnectedPeer(
        filePath: string
    ): Promise<void> {
        const connectedDevices =
            this.getConnectedDevices();

        if (connectedDevices.length === 0) {
            console.error(
                "[CONNECTION] No connected peers available"
            );

            return;
        }

        const peerDeviceId =
            connectedDevices[0];

        await this.sendFile(
            peerDeviceId,
            filePath
        );
    }

    requestTransfer(
        deviceId: string,
        filePath: string
    ) {
        const connection =
            this.connections.get(deviceId);

        if (!connection) {
            throw new Error(
                `No connection found for device ${deviceId}`
            );
        }

        if (
            connection.state !== "CONNECTED"
        ) {
            throw new Error(
                `Device ${deviceId} is not connected`
            );
        }

        return this.transferManager.requestTransfer(
            connection.socket,
            this.deviceId,
            filePath
        );
    }

    private createFramer(deviceId?: string): MessageFramer {
        return new MessageFramer((detail) =>
            this.emit("MALFORMED_MESSAGE", deviceId, undefined, detail)
        );
    }

    private isValidConnectRequest(message: ConnectRequest): boolean {
        return (
            typeof message.version === "string" &&
            typeof message.requestId === "string" &&
            typeof message.messageId === "string" &&
            typeof message.sequence === "number" &&
            Number.isInteger(message.sequence) &&
            message.sequence >= 0 &&
            typeof message.deviceId === "string" &&
            message.deviceId.length > 0 &&
            typeof message.timestamp === "number"
        );
    }

    private isValidConnectAccept(message: ConnectAccept): boolean {
        return (
            message.version === PROTOCOL_VERSION &&
            typeof message.requestId === "string" &&
            typeof message.messageId === "string" &&
            typeof message.sequence === "number" &&
            Number.isInteger(message.sequence) &&
            message.sequence >= 0 &&
            typeof message.deviceId === "string" &&
            message.deviceId.length > 0 &&
            typeof message.sessionId === "string" &&
            message.sessionId.length > 0 &&
            typeof message.timestamp === "number"
        );
    }

    private emit(
        type: ProtocolEventType,
        deviceId?: string,
        sessionId?: string,
        detail?: string
    ): void {
        this.onEvent?.({
            id: randomUUID(),
            timestamp: Date.now(),
            type,
            layer: type === "MALFORMED_MESSAGE" ? "framing" : "connection",
            deviceId,
            sessionId,
            detail,
        });
    }
}
