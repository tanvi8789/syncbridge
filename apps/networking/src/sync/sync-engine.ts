import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";

import { encodeMessage } from "../connection/framing";
import type { TransferManager } from "../transfer/transfer-manager";

import {
    SyncMessageType,
    type SyncPairRequest,
    type SyncPairAccept,
    type SyncPairReject,
    type SyncManifestMessage,
    type SyncManifestEntry,
    type SyncDeleteMessage,
    type SyncUnpairMessage,
} from "./sync-messages";

import {
    type SyncPair,
    loadBaseline,
    saveBaseline,
    deleteBaseline,
    type Baseline,
} from "./sync-state";

import {
    scanFolder,
    diffAgainstBaseline,
    checksumFile,
} from "./sync-scanner";

import type { SyncEventListener } from "./sync-event";

const SYNC_VERSION = "1.0.0";
const TICK_INTERVAL_MS = 5000;

interface PendingPush {
    pairId: string;
    relativePath: string;
    size: number;
    mtimeMs: number;
    checksum: string;
}

export class SyncEngine {
    private pairs =
        new Map<string, SyncPair>();

    private baselines =
        new Map<string, Baseline>();

    private timers =
        new Map<string, NodeJS.Timeout>();

    private pendingPushes =
        new Map<string, PendingPush>();

    private reconciledTransferIds =
        new Set<string>();

    constructor(
        private readonly deviceId: string,
        private readonly transferManager: TransferManager,
        private readonly getConnectionSocket: (
            peerDeviceId: string
        ) => net.Socket | undefined,
        private readonly onEvent?: SyncEventListener,
        private readonly getSessionId?: (
            peerDeviceId: string
        ) => string | undefined
    ) {}

    /**
     * Resolver handed to TransferManager/TransferReceiver so
     * sync-tagged incoming transfers know where to write.
     */
    getLocalFolder(
        pairId: string
    ): string | undefined {
        return this.pairs.get(pairId)?.localFolder;
    }

    getPairs(): SyncPair[] {
        return Array.from(
            this.pairs.values()
        );
    }

    createPair(
        peerDeviceId: string,
        localFolder: string,
        name: string
    ): SyncPair {
        const socket =
            this.getConnectionSocket(peerDeviceId);

        if (!socket) {
            throw new Error(
                `No connection to device ${peerDeviceId}`
            );
        }

        const pairId = randomUUID();

        const pair: SyncPair = {
            pairId,
            name,
            peerDeviceId,
            localFolder,
            status: "PENDING",
            createdAt: Date.now(),
            sessionId: this.getSessionId?.(peerDeviceId),
        };

        this.pairs.set(pairId, pair);
        this.baselines.set(pairId, new Map());

        const request: SyncPairRequest = {
            type: SyncMessageType.SYNC_PAIR_REQUEST,
            version: SYNC_VERSION,
            pairId,
            name,
            timestamp: Date.now(),
        };

        this.sendMessage(socket, request);

        console.log(
            `[SYNC] Requested pair "${name}" (${pairId}) with ${peerDeviceId}`
        );

        return pair;
    }

    removePair(
        pairId: string
    ): void {
        const pair = this.pairs.get(pairId);

        if (!pair) {
            throw new Error(
                `Unknown sync pair: ${pairId}`
            );
        }

        this.stopTimer(pairId);

        const socket = this.getConnectionSocket(
            pair.peerDeviceId
        );

        if (socket) {
            const unpair: SyncUnpairMessage = {
                type: SyncMessageType.SYNC_UNPAIR,
                version: SYNC_VERSION,
                pairId,
                timestamp: Date.now(),
            };

            this.sendMessage(socket, unpair);
        }

        this.pairs.delete(pairId);
        this.baselines.delete(pairId);
        deleteBaseline(pairId);

        this.onEvent?.({
            pairId,
            type: "PAIR_REMOVED",
            timestamp: Date.now(),
            sessionId: pair.sessionId,
        });
    }

    syncNow(
        pairId: string
    ): void {
        const pair = this.pairs.get(pairId);

        if (!pair) {
            throw new Error(
                `Unknown sync pair: ${pairId}`
            );
        }

        this.tick(pair);
    }

    /**
     * Route incoming SYNC_* messages to the appropriate handler.
     */
    handleMessage(
        socket: net.Socket,
        message: object,
        peerDeviceId: string
    ): void {
        if (!("type" in message)) {
            return;
        }

        switch (message.type) {
            case SyncMessageType.SYNC_PAIR_REQUEST:
                this.handlePairRequest(
                    socket,
                    message as SyncPairRequest,
                    peerDeviceId
                );
                break;

            case SyncMessageType.SYNC_PAIR_ACCEPT:
                this.handlePairAccept(
                    message as SyncPairAccept
                );
                break;

            case SyncMessageType.SYNC_PAIR_REJECT:
                this.handlePairReject(
                    message as SyncPairReject
                );
                break;

            case SyncMessageType.SYNC_MANIFEST:
                this.handleManifest(
                    message as SyncManifestMessage
                );
                break;

            case SyncMessageType.SYNC_DELETE:
                this.handleDelete(
                    message as SyncDeleteMessage
                );
                break;

            case SyncMessageType.SYNC_UNPAIR:
                this.handleUnpair(
                    message as SyncUnpairMessage
                );
                break;

            default:
                console.log(
                    `[SYNC] Unknown message type: ${String(message.type)}`
                );
        }
    }

    /**
     * Called (via TransferReceiver's onSyncConflict callback) when a
     * sync-tagged write lands on top of a more recently modified
     * local file and gets saved alongside it instead.
     */
    handleConflict(info: {
        syncPairId: string;
        relativePath: string;
        conflictPath: string;
    }): void {
        this.onEvent?.({
            pairId: info.syncPairId,
            type: "CONFLICT",
            relativePath: info.relativePath,
            timestamp: Date.now(),
            sessionId: this.pairs.get(info.syncPairId)?.sessionId,
        });
    }

    private handlePairRequest(
        socket: net.Socket,
        request: SyncPairRequest,
        peerDeviceId: string
    ): void {
        console.log(
            `[SYNC] SYNC_PAIR_REQUEST received: "${request.name}" (${request.pairId})`
        );

        const localFolder = path.join(
            os.homedir(),
            "SyncBridge",
            "Sync",
            sanitizeFolderName(request.name)
        );

        fs.mkdirSync(localFolder, { recursive: true });

        const pair: SyncPair = {
            pairId: request.pairId,
            name: request.name,
            peerDeviceId,
            localFolder,
            status: "ACTIVE",
            createdAt: Date.now(),
            sessionId: this.getSessionId?.(peerDeviceId),
        };

        this.pairs.set(request.pairId, pair);
        this.baselines.set(request.pairId, loadBaseline(request.pairId));

        const accept: SyncPairAccept = {
            type: SyncMessageType.SYNC_PAIR_ACCEPT,
            version: SYNC_VERSION,
            pairId: request.pairId,
            timestamp: Date.now(),
        };

        this.sendMessage(socket, accept);

        this.onEvent?.({
            pairId: pair.pairId,
            type: "PAIR_CREATED",
            timestamp: Date.now(),
            sessionId: pair.sessionId,
        });

        this.sendManifest(pair, socket);
        this.startTimer(pair);
    }

    private handlePairAccept(
        response: SyncPairAccept
    ): void {
        const pair = this.pairs.get(response.pairId);

        if (!pair) {
            return;
        }

        pair.status = "ACTIVE";

        console.log(
            `[SYNC] Pair "${pair.name}" (${pair.pairId}) accepted`
        );

        this.onEvent?.({
            pairId: pair.pairId,
            type: "PAIR_CREATED",
            timestamp: Date.now(),
            sessionId: pair.sessionId,
        });

        const socket = this.getConnectionSocket(
            pair.peerDeviceId
        );

        if (socket) {
            this.sendManifest(pair, socket);
        }

        this.startTimer(pair);
    }

    private handlePairReject(
        response: SyncPairReject
    ): void {
        const pair = this.pairs.get(response.pairId);

        if (pair) {
            pair.status = "REJECTED";
        }

        console.log(
            `[SYNC] Pair ${response.pairId} rejected: ${response.reason}`
        );
    }

    private handleUnpair(
        message: SyncUnpairMessage
    ): void {
        const sessionId = this.pairs.get(message.pairId)?.sessionId;

        this.stopTimer(message.pairId);
        this.pairs.delete(message.pairId);
        this.baselines.delete(message.pairId);
        deleteBaseline(message.pairId);

        this.onEvent?.({
            pairId: message.pairId,
            type: "PAIR_REMOVED",
            timestamp: Date.now(),
            sessionId,
        });
    }

    /**
     * Seed the baseline for any file that already matches on both
     * sides, so the normal push flow doesn't waste a transfer
     * re-sending identical content the first time a pair is created.
     */
    private handleManifest(
        message: SyncManifestMessage
    ): void {
        const pair = this.pairs.get(message.pairId);
        const baseline = this.baselines.get(message.pairId);

        if (!pair || !baseline) {
            return;
        }

        const localFiles = scanFolder(pair.localFolder);
        const localByPath = new Map(
            localFiles.map((file) => [file.relativePath, file])
        );

        let changed = false;

        for (const entry of message.entries) {
            const local = localByPath.get(entry.relativePath);

            if (!local) {
                continue;
            }

            const checksum = checksumFile(
                path.join(pair.localFolder, entry.relativePath)
            );

            if (checksum === entry.checksum) {
                baseline.set(entry.relativePath, {
                    size: local.size,
                    mtimeMs: local.mtimeMs,
                    checksum,
                });

                changed = true;
            }
        }

        if (changed) {
            saveBaseline(message.pairId, baseline);
        }
    }

    private handleDelete(
        message: SyncDeleteMessage
    ): void {
        const pair = this.pairs.get(message.pairId);
        const baseline = this.baselines.get(message.pairId);

        if (!pair || !baseline) {
            return;
        }

        const targetPath = this.resolveSafePath(
            pair.localFolder,
            message.relativePath
        );

        if (targetPath) {
            try {
                fs.unlinkSync(targetPath);
                console.log(
                    `[SYNC] Deleted ${targetPath} (requested by peer)`
                );
            } catch {
                // Already gone locally; nothing to do.
            }
        }

        baseline.delete(message.relativePath);
        saveBaseline(message.pairId, baseline);

        this.onEvent?.({
            pairId: message.pairId,
            type: "FILE_DELETED",
            relativePath: message.relativePath,
            timestamp: Date.now(),
            sessionId: pair.sessionId,
        });
    }

    private startTimer(
        pair: SyncPair
    ): void {
        this.stopTimer(pair.pairId);

        const timer = setInterval(() => {
            this.tick(pair);
        }, TICK_INTERVAL_MS);

        this.timers.set(pair.pairId, timer);
    }

    private stopTimer(
        pairId: string
    ): void {
        const timer = this.timers.get(pairId);

        if (timer) {
            clearInterval(timer);
            this.timers.delete(pairId);
        }
    }

    private tick(
        pair: SyncPair
    ): void {
        if (pair.status !== "ACTIVE") {
            return;
        }

        this.reconcileCompletedTransfers(pair);

        const baseline = this.baselines.get(pair.pairId);

        if (!baseline) {
            return;
        }

        const scanned = scanFolder(pair.localFolder);
        const diff = diffAgainstBaseline(
            pair.localFolder,
            scanned,
            baseline
        );

        for (const file of diff.changed) {
            this.pushFile(pair, file);
        }

        for (const relativePath of diff.deleted) {
            this.pushDelete(pair, relativePath);
        }

        if (diff.changed.length > 0 || diff.deleted.length > 0) {
            pair.lastSyncAt = Date.now();
        }

        this.onEvent?.({
            pairId: pair.pairId,
            type: "SCAN_COMPLETE",
            timestamp: Date.now(),
            sessionId: pair.sessionId,
        });
    }

    private pushFile(
        pair: SyncPair,
        file: { relativePath: string; size: number; mtimeMs: number; checksum: string }
    ): void {
        const socket = this.getConnectionSocket(
            pair.peerDeviceId
        );

        if (!socket) {
            // Peer is offline; the file will still look "changed"
            // next tick since the baseline hasn't moved, so this
            // naturally retries once the peer reconnects.
            return;
        }

        const absolutePath = path.join(
            pair.localFolder,
            file.relativePath
        );

        const transferId = this.transferManager.requestTransfer(
            socket,
            this.deviceId,
            absolutePath,
            pair.peerDeviceId,
            {
                syncPairId: pair.pairId,
                relativePath: file.relativePath,
            }
        );

        if (!transferId) {
            return;
        }

        this.pendingPushes.set(transferId, {
            pairId: pair.pairId,
            relativePath: file.relativePath,
            size: file.size,
            mtimeMs: file.mtimeMs,
            checksum: file.checksum,
        });

        this.onEvent?.({
            pairId: pair.pairId,
            type: "FILE_QUEUED",
            relativePath: file.relativePath,
            timestamp: Date.now(),
            sessionId: pair.sessionId,
        });
    }

    private pushDelete(
        pair: SyncPair,
        relativePath: string
    ): void {
        const baseline = this.baselines.get(pair.pairId);
        baseline?.delete(relativePath);
        saveBaseline(pair.pairId, baseline ?? new Map());

        const socket = this.getConnectionSocket(
            pair.peerDeviceId
        );

        if (socket) {
            const message: SyncDeleteMessage = {
                type: SyncMessageType.SYNC_DELETE,
                version: SYNC_VERSION,
                pairId: pair.pairId,
                relativePath,
                timestamp: Date.now(),
            };

            this.sendMessage(socket, message);
        }

        this.onEvent?.({
            pairId: pair.pairId,
            type: "FILE_DELETED",
            relativePath,
            timestamp: Date.now(),
            sessionId: pair.sessionId,
        });
    }

    /**
     * Fold any sync-tagged transfer that has finished (in either
     * direction) into this pair's baseline, so the next scan doesn't
     * treat it as a new local change and push it right back.
     */
    private reconcileCompletedTransfers(
        pair: SyncPair
    ): void {
        const baseline = this.baselines.get(pair.pairId);

        if (!baseline) {
            return;
        }

        let changed = false;

        for (const transfer of this.transferManager.getTransfers()) {
            if (transfer.syncPairId !== pair.pairId) {
                continue;
            }

            if (
                transfer.state !== "COMPLETED" ||
                this.reconciledTransferIds.has(transfer.transferId) ||
                !transfer.relativePath
            ) {
                continue;
            }

            this.reconciledTransferIds.add(transfer.transferId);

            if (transfer.direction === "sent") {
                const pending = this.pendingPushes.get(
                    transfer.transferId
                );

                this.pendingPushes.delete(transfer.transferId);

                if (pending) {
                    baseline.set(pending.relativePath, {
                        size: pending.size,
                        mtimeMs: pending.mtimeMs,
                        checksum: pending.checksum,
                    });

                    changed = true;
                }

                continue;
            }

            // Received. Only advance the baseline if the file
            // actually landed at the expected path — a conflict
            // copy is saved elsewhere and must not be treated as
            // the agreed version.
            if (!transfer.savedPath || !transfer.checksum) {
                continue;
            }

            const expectedPath = path.resolve(
                pair.localFolder,
                transfer.relativePath
            );

            if (
                path.resolve(transfer.savedPath) !== expectedPath
            ) {
                continue;
            }

            let mtimeMs: number;

            try {
                mtimeMs = fs.statSync(expectedPath).mtimeMs;
            } catch {
                continue;
            }

            baseline.set(transfer.relativePath, {
                size: transfer.fileSize,
                mtimeMs,
                checksum: transfer.checksum,
            });

            changed = true;
        }

        if (changed) {
            saveBaseline(pair.pairId, baseline);
        }
    }

    private sendManifest(
        pair: SyncPair,
        socket: net.Socket
    ): void {
        const scanned = scanFolder(pair.localFolder);

        const entries: SyncManifestEntry[] = scanned.map(
            (file) => ({
                relativePath: file.relativePath,
                size: file.size,
                mtimeMs: file.mtimeMs,
                checksum: checksumFile(
                    path.join(pair.localFolder, file.relativePath)
                ),
            })
        );

        const message: SyncManifestMessage = {
            type: SyncMessageType.SYNC_MANIFEST,
            version: SYNC_VERSION,
            pairId: pair.pairId,
            entries,
            timestamp: Date.now(),
        };

        this.sendMessage(socket, message);
    }

    private resolveSafePath(
        rootFolder: string,
        relativePath: string
    ): string | undefined {
        const resolvedRoot = path.resolve(rootFolder);
        const candidate = path.resolve(resolvedRoot, relativePath);

        if (
            candidate !== resolvedRoot &&
            !candidate.startsWith(resolvedRoot + path.sep)
        ) {
            console.error(
                `[SYNC] Rejecting unsafe path: ${relativePath}`
            );

            return undefined;
        }

        return candidate;
    }

    private sendMessage(
        socket: net.Socket,
        message: object
    ): void {
        socket.write(encodeMessage(message));
    }
}

function sanitizeFolderName(name: string): string {
    return name.replace(/[^a-zA-Z0-9 _-]/g, "_").trim() || "Untitled";
}
