import { DeviceIdentity } from "./discovery/device-identity";
import { DiscoveryService } from "./discovery/discovery";
import { ConnectionManager } from "./connection/connection-manager";
import { TcpServer } from "./connection/tcp-server";
import { EventEmitter } from "node:events";
import type { ProtocolEvent } from "./protocol-event";
import type { TransferEvent } from "./transfer/transfer-event";
import type { SyncEvent } from "./sync/sync-event";
import type { ClipboardEvent } from "./clipboard/clipboard-event";
import { SessionStore } from "./session/session-store";
import {
    HistoryStore,
    isTerminalTransferState,
    type HistoryQuery,
    type Analytics,
} from "./history/history-store";

/** What /api/analytics returns when the database is unavailable. */
const EMPTY_ANALYTICS = (since?: number): Analytics => ({
    since,
    generatedAt: Date.now(),
    totals: {
        transfers: 0,
        succeeded: 0,
        failed: 0,
        bytes: 0,
        bytesSent: 0,
        bytesReceived: 0,
        totalRetries: 0,
        transfersWithRetries: 0,
    },
    throughput: {},
    latency: { samples: 0 },
    byPeer: [],
    byDay: [],
    sessions: { total: 0 },
    devicesSeen: 0,
});

export class NetworkingEngine extends EventEmitter {
    readonly deviceIdentity: DeviceIdentity;
    readonly discovery: DiscoveryService;
    readonly connectionManager: ConnectionManager;
    readonly tcpServer: TcpServer;
    private readonly sessionStore: SessionStore;
    /*
     * Undefined when the database could not be opened (a locked
     * file, a read-only home). History is a convenience, not a
     * prerequisite for transferring files, so the engine runs
     * without it rather than refusing to start.
     */
    private readonly historyStore?: HistoryStore;

    private historySweepTimer?: NodeJS.Timeout;

    /*
     * The last state each transfer was persisted in, so a sweep
     * that sees the same finished transfers again does no work.
     */
    private recordedTransferStates = new Map<string, string>();

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
                (event) => this.publishSyncEvent(event),
                (event) => this.publishClipboardEvent(event)
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
        try {
            this.historyStore = new HistoryStore();
        } catch (error) {
            console.error(
                "[HISTORY] Disabled — could not open the database:",
                error
            );
        }
    }

    getSessions() {
        return this.sessionStore.getSessions();
    }

    getSessionTimeline(sessionId: string) {
        return this.sessionStore.getSessionTimeline(sessionId);
    }

    getSessionExport(sessionId: string) {
        return this.sessionStore.getSessionExport(sessionId);
    }

    getHistory(query?: HistoryQuery) {
        /*
         * Flushed first so a transfer that just finished is in the
         * page the caller is about to render, rather than appearing
         * a second later when the debounce fires.
         */
        this.sweepHistory();

        return (
            this.historyStore?.getTransfers(query) ?? {
                transfers: [],
                total: 0,
                limit: query?.limit ?? 50,
                offset: query?.offset ?? 0,
            }
        );
    }

    getAnalytics(since?: number) {
        this.sweepHistory();

        return this.historyStore?.getAnalytics(since) ?? EMPTY_ANALYTICS(since);
    }

    clearHistory(): void {
        this.historyStore?.clear();
        this.recordedTransferStates.clear();
    }

    async start(): Promise<void> {
        await this.discovery.start();

        this.tcpServer.start();
    }

    stop(): void {
        this.discovery.stop();

        this.tcpServer.stop();

        if (this.historySweepTimer) {
            clearTimeout(this.historySweepTimer);
            this.historySweepTimer = undefined;
        }

        // Last chance to persist anything that finished recently.
        this.sweepHistory();
        this.historyStore?.close();
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

        // Cancelling emits no transfer event, so history would
        // otherwise not learn the transfer had ended.
        this.scheduleHistorySweep();
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

    publishClipboard(content: string): number {
        return this.connectionManager.publishClipboard(content);
    }

    getClipboard() {
        return this.connectionManager.getClipboard();
    }

    getClipboardHistory() {
        return this.connectionManager.getClipboardHistory();
    }

    isClipboardEnabled(): boolean {
        return this.connectionManager.isClipboardEnabled();
    }

    setClipboardEnabled(enabled: boolean): void {
        this.connectionManager.setClipboardEnabled(enabled);
    }

    acknowledgeClipboardWrite(contentHash: string): void {
        this.connectionManager.acknowledgeClipboardWrite(contentHash);
    }

    private publishEvent(event: ProtocolEvent): void {
        /*
         * Connection churn is what decides how aggressively we need
         * to keep broadcasting, so let discovery re-evaluate its
         * cadence whenever the connection set may have changed.
         */
        if (
            event.type === "CONNECT_ACCEPTED" ||
            event.type === "CONNECT_REJECTED" ||
            event.type === "CONNECTION_CLOSED"
        ) {
            this.syncDiscoveryCadence();
            this.scheduleHistorySweep();
        }

        this.emit("protocol-event", event);
    }

    private syncDiscoveryCadence(): void {
        const hasConnections = this.connectionManager
            .getConnections()
            .some((connection) => connection.state === "CONNECTED");

        this.discovery.setConnectionsActive(hasConnections);
    }

    private publishTransferEvent(event: TransferEvent): void {
        if (
            event.type === "TRANSFER_COMPLETED" ||
            event.type === "TRANSFER_VERIFIED"
        ) {
            this.scheduleHistorySweep();
        }

        this.emit("transfer-event", event);
    }

    /**
     * Persist whatever has reached a terminal state.
     *
     * This sweeps the live transfer list rather than persisting from
     * one specific event, because not every ending is evented — a
     * cancel or a rejection produces no transfer event at all, and a
     * missed event would mean a transfer silently absent from
     * history forever.
     */
    private sweepHistory(): void {
        const store = this.historyStore;

        if (!store) {
            return;
        }

        const names = new Map<string, string | undefined>();

        for (const connection of this.connectionManager.getConnections()) {
            names.set(connection.deviceId, connection.deviceName);
        }

        for (const device of this.discovery.getDevices()) {
            if (!names.has(device.deviceId)) {
                names.set(device.deviceId, device.deviceName);
            }

            store.recordDevice({
                deviceId: device.deviceId,
                deviceName: device.deviceName,
                platform: device.platform,
            });
        }

        for (const transfer of this.connectionManager.getTransfers()) {
            if (!isTerminalTransferState(transfer.state)) {
                continue;
            }

            if (
                this.recordedTransferStates.get(transfer.transferId) ===
                transfer.state
            ) {
                continue;
            }

            store.recordTransfer(
                transfer,
                names.get(transfer.peerDeviceId)
            );

            this.recordedTransferStates.set(
                transfer.transferId,
                transfer.state
            );
        }

        for (const summary of this.sessionStore.getSessions()) {
            store.recordSession({
                ...summary,
                peerDeviceName:
                    summary.peerDeviceName ??
                    names.get(summary.peerDeviceId),
            });
        }
    }

    private scheduleHistorySweep(): void {
        if (this.historySweepTimer) {
            return;
        }

        /*
         * Coalesced: a multi-file sync finishes many transfers at
         * once, and each one would otherwise trigger its own pass
         * over the whole transfer list.
         */
        this.historySweepTimer = setTimeout(() => {
            this.historySweepTimer = undefined;
            this.sweepHistory();
        }, 1000);
    }

    private publishSyncEvent(event: SyncEvent): void {
        this.emit("sync-event", event);
    }

    private publishClipboardEvent(event: ClipboardEvent): void {
        this.emit("clipboard-event", event);
    }
}
