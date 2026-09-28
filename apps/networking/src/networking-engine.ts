import { DeviceIdentity } from "./discovery/device-identity";
import { DiscoveryService } from "./discovery/discovery";
import { ConnectionManager } from "./connection/connection-manager";
import { TcpServer } from "./connection/tcp-server";
import { EventEmitter } from "node:events";
import type { ProtocolEvent } from "./protocol-event";
import type { TransferEvent } from "./transfer/transfer-event";
import type { SyncEvent } from "./sync/sync-event";
import { SessionStore } from "./session/session-store";

export class NetworkingEngine extends EventEmitter {
    readonly deviceIdentity: DeviceIdentity;
    readonly discovery: DiscoveryService;
    readonly connectionManager: ConnectionManager;
    readonly tcpServer: TcpServer;
    private readonly sessionStore: SessionStore;

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
                (event) => this.publishEvent(event),
                (event) => this.publishTransferEvent(event),
                (event) => this.publishSyncEvent(event)
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

        this.sessionStore = new SessionStore(this);
    }

    getSessions() {
        return this.sessionStore.getSessions();
    }

    getSessionTimeline(sessionId: string) {
        return this.sessionStore.getSessionTimeline(sessionId);
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

    pauseTransfer(transferId: string): void {
        this.connectionManager.pauseTransfer(transferId);
    }

    resumeTransfer(transferId: string): void {
        this.connectionManager.resumeTransfer(transferId);
    }

    cancelTransfer(transferId: string): void {
        this.connectionManager.cancelTransfer(transferId);
    }

    createSyncPair(
        peerDeviceId: string,
        localFolder: string,
        name: string
    ) {
        return this.connectionManager.createSyncPair(
            peerDeviceId,
            localFolder,
            name
        );
    }

    removeSyncPair(pairId: string): void {
        this.connectionManager.removeSyncPair(pairId);
    }

    syncNow(pairId: string): void {
        this.connectionManager.syncNow(pairId);
    }

    getSyncPairs() {
        return this.connectionManager.getSyncPairs();
    }

    private publishEvent(event: ProtocolEvent): void {
        this.emit("protocol-event", event);
    }

    private publishTransferEvent(event: TransferEvent): void {
        this.emit("transfer-event", event);
    }

    private publishSyncEvent(event: SyncEvent): void {
        this.emit("sync-event", event);
    }
}
