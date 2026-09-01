import { DeviceIdentity } from "./discovery/device-identity";
import { DiscoveryService } from "./discovery/discovery";
import { ConnectionManager } from "./connection/connection-manager";
import { TcpServer } from "./connection/tcp-server";

export class NetworkingEngine {
    readonly deviceIdentity: DeviceIdentity;
    readonly discovery: DiscoveryService;
    readonly connectionManager: ConnectionManager;
    readonly tcpServer: TcpServer;

    constructor() {
        this.deviceIdentity =
            new DeviceIdentity();

        this.discovery =
            new DiscoveryService(
                this.deviceIdentity
            );

        this.connectionManager =
            new ConnectionManager(
                this.deviceIdentity.deviceId
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

    getTransfers() {
        return this.connectionManager
            .getTransfers();
    }
}