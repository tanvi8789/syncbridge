import net from "node:net";
import { randomUUID } from "node:crypto";

import { MessageType } from "../message-types";
import type {
    ConnectRequest,
    ConnectAccept,
    ConnectReject,
} from "../connection-messages";

import type { DiscoveredDevice } from "../discovery/device-registry";
import { ConnectionState } from "./connection-state";

import {
    encodeMessage,
    MessageFramer,
} from "./framing";

import { TransferManager } from "../transfer/transfer-manager";

const TCP_PORT = 41236;

interface Connection {
    socket: net.Socket;
    state: ConnectionState;
    framer: MessageFramer;
}

export class ConnectionManager {
    private connections = new Map<
        string,
        Connection
    >();

    private transferManager: TransferManager;

    constructor(
        private readonly deviceId: string,
        private readonly tcpPort: number = 41236
    ) {
        this.transferManager =
            new TransferManager();
    }

    async connectToDevice(
        device: DiscoveredDevice
    ): Promise<void> {
        if (this.connections.has(device.deviceId)) {
            console.log(
                `[CONNECTION] Already connected or connecting to ${device.deviceName}`
            );

            return;
        }

        console.log(
            `[CONNECTION] Connecting to ${device.deviceName} at ${device.ip}:${TCP_PORT}`
        );

        const socket = new net.Socket();

        const framer = new MessageFramer();

        this.connections.set(
            device.deviceId,
            {
                socket,
                state: ConnectionState.CONNECTING,
                framer,
            }
        );

        socket.on("error", (error) => {
            console.error(
                `[CONNECTION] Error connecting to ${device.deviceName}:`,
                error
            );

            this.connections.delete(
                device.deviceId
            );
        });

        socket.on("close", () => {
            console.log(
                `[CONNECTION] Connection closed: ${device.deviceName}`
            );

            this.connections.delete(
                device.deviceId
            );
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
                socket.connect(
                    this.tcpPort,
                    device.ip,
                    () => {
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
                    reject
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

        /*
        * The receiver must accept the transfer
        * before the actual file data is sent.
        */
    }

    getConnections() {
        return Array.from(
            this.connections.entries()
        ).map(
            ([deviceId, connection]) => ({
                deviceId,
                state: connection.state,
                remoteAddress:
                    connection.socket.remoteAddress,
                remotePort:
                    connection.socket.remotePort,
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
            `[CONNECTION] Handling incoming TCP connection from ${socket.remoteAddress}`
        );

        const framer =
            new MessageFramer();

        socket.on("data", (data) => {
            const buffer = Buffer.isBuffer(data)
                ? data
                : Buffer.from(data);

            const messages =
                framer.addData(buffer);

            for (const message of messages) {
                this.handleMessage(
                    socket,
                    "incoming-peer",
                    message
                );
            }
        });

        socket.on("close", () => {
            console.log(
                "[CONNECTION] Incoming peer disconnected"
            );
        });

        socket.on("error", (error) => {
            console.error(
                "[CONNECTION] Incoming connection error:",
                error
            );
        });
    }

    private sendConnectRequest(
        socket: net.Socket
    ): void {
        const request: ConnectRequest = {
            type:
                MessageType.CONNECT_REQUEST,

            version: "1.0.0",

            requestId: randomUUID(),

            deviceId: this.deviceId,

            timestamp: Date.now(),
        };

        this.sendMessage(
            socket,
            request
        );

        console.log(
            "[CONNECTION] CONNECT_REQUEST sent"
        );
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
        request: ConnectRequest
    ): void {
        console.log(
            `[CONNECTION] CONNECT_REQUEST received from ${request.deviceId}`
        );

        const response: ConnectAccept = {
            type:
                MessageType.CONNECT_ACCEPT,

            version: "1.0.0",

            requestId:
                request.requestId,

            deviceId:
                this.deviceId,

            timestamp: Date.now(),
        };

        this.sendMessage(
            socket,
            response
        );

        console.log(
            "[CONNECTION] CONNECT_ACCEPT sent"
        );

        const existing =
            this.connections.get(
                request.deviceId
            );

        if (existing) {
            existing.state =
                ConnectionState.CONNECTED;
        } else {
            this.connections.set(
                request.deviceId,
                {
                    socket,
                    state:
                        ConnectionState.CONNECTED,
                    framer:
                        new MessageFramer(),
                }
            );
        }

        console.log(
            `[CONNECTION] Peer ${request.deviceId} is CONNECTED`
        );
    }

    private handleConnectAccept(
        peerDeviceId: string,
        response: ConnectAccept
    ): void {
        console.log(
            `[CONNECTION] CONNECT_ACCEPT received from ${response.deviceId}`
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

        connection.state =
            ConnectionState.CONNECTED;

        console.log(
            `[CONNECTION] Peer ${peerDeviceId} is CONNECTED`
        );
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

            connection.socket.destroy();
        }

        this.connections.delete(
            peerDeviceId
        );
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

}