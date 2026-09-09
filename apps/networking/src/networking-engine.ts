import { DeviceIdentity } from "./discovery/device-identity";
import { DiscoveryService } from "./discovery/discovery";
import { ConnectionManager } from "./connection/connection-manager";
import { TcpServer } from "./connection/tcp-server";
import { EventEmitter } from "node:events";
import type { ProtocolEvent } from "./protocol-event";

export class NetworkingEngine extends EventEmitter {
    readonly deviceIdentity: DeviceIdentity;
    readonly discovery: DiscoveryService;
    readonly connectionManager: ConnectionManager;
    readonly tcpServer: TcpServer;

    constructor() {
        super();
        this.deviceIdentity =
            new DeviceIdentity();

        this.discovery =
            new DiscoveryService(
                this.deviceIdentity,
                (event) => this.publishEvent(event)
            );

        this.connectionManager =
            new ConnectionManager(
                this.deviceIdentity.deviceId,
                this.deviceIdentity.deviceName,
                undefined,
                undefined,
                (event) => this.publishEvent(event)
            );

        this.tcpServer =
            new TcpServer(
                (socket) => {
                    this.connectionManager
                        .handleIncomingConnection(
                            socket
                        );
                }
            );
    }

    async start(): Promise<void> {
        await this.discovery.start();

        this.tcpServer.start();
    }

    stop(): void {
        this.discovery.stop();

        this.tcpServer.stop();
    }

    getDeviceInfo() {
        return {
            deviceId:
                this.deviceIdentity.deviceId,

            deviceName:
                this.deviceIdentity.deviceName,

            platform:
                process.platform,
        };
    }

    getDiscoveredDevices() {
        return this.discovery.getDevices();
    }

    getConnections() {
        return this.connectionManager
            .getConnections();
    }

    disconnectDevice(deviceId: string): boolean {
        return this.connectionManager.disconnectDevice(deviceId);
    }

    getTransfers() {
        return this.connectionManager
            .getTransfers();
    }

    requestFileTransfer(
        deviceId: string,
        filePath: string
    ) {
        return this.connectionManager.requestTransfer(
            deviceId,
            filePath
        );
    }

    private publishEvent(event: ProtocolEvent): void {
        this.emit("protocol-event", event);
    }
}
