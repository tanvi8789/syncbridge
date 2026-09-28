import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";

import {
    TransferMessageType,
    type FileMetadata,
    type FileChunk,
    type FileChunkAck,
    type FileTransferComplete,
    type FileTransferAck,
} from "./transfer-messages";

import {
    TRANSFER_VERSION,
    CHUNK_SIZE,
} from "./transfer-config";

import {
    encodeMessage,
} from "../connection/framing";

import type {
    Transfer,
} from "./transfer-state";

import type {
    TransferEventListener,
} from "./transfer-event";

export class TransferReceiver {
    /**
     * In-flight chunk buffers, keyed by transfer ID. The Transfer
     * records themselves live in the shared map passed in below so
     * they stay visible to the rest of the app (and the desktop UI)
     * while a transfer is in progress and after it completes.
     */
    private chunkBuffers =
        new Map<string, Map<number, Buffer>>();

    /**
     * Directory where manually-sent files are stored. Fixed under
     * the user's home directory so it doesn't depend on which
     * process cwd the networking engine happens to be started from.
     * Sync-tagged transfers are written into their sync pair's own
     * folder instead (see `getSyncFolder`).
     */
    private readonly receivedDirectory =
        path.join(
            os.homedir(),
            "SyncBridge",
            "Received"
        );

    /**
     * Sender-reported modification time for the source file, keyed
     * by transfer ID. Only set for sync-tagged transfers; used to
     * detect a conflicting local edit at write time.
     */
    private sourceModifiedAt =
        new Map<string, number>();

    constructor(
        private readonly transfers: Map<string, Transfer>,
        private readonly onEvent?: TransferEventListener,
        private readonly getSyncFolder?: (
            syncPairId: string
        ) => string | undefined,
        private readonly onSyncConflict?: (info: {
            transferId: string;
            syncPairId: string;
            relativePath: string;
            conflictPath: string;
        }) => void
    ) {}

    /**
     * Handle incoming file metadata.
     */
    handleMetadata(
        metadata: FileMetadata
    ): void {
        console.log(
            "[TRANSFER] FILE_METADATA received"
        );

        console.log(
            `[TRANSFER] Transfer ID: ${metadata.transferId}`
        );

        console.log(
            `[TRANSFER] File: ${metadata.fileName}`
        );

        console.log(
            `[TRANSFER] Size: ${metadata.fileSize} bytes`
        );

        console.log(
            `[TRANSFER] Total chunks: ${metadata.totalChunks}`
        );

        /*
         * A placeholder entry is created as soon as the transfer
         * request comes in (see TransferManager.handleTransferRequest),
         * so it's already visible in the UI. Fill it in with the
         * real size/chunk count now that metadata has arrived.
         */
        const existing =
            this.transfers.get(
                metadata.transferId
            );

        const transfer: Transfer = existing ?? {
            transferId: metadata.transferId,
            direction: "received",
            peerDeviceId: "unknown",
            fileName: metadata.fileName,
            fileSize: metadata.fileSize,
            totalChunks: metadata.totalChunks,
            chunksAcked: 0,
            bytesTransferred: 0,
            retryCount: 0,
            paused: false,
            syncPairId: metadata.syncPairId,
            relativePath: metadata.relativePath,
            state: "TRANSFERRING",
        };

        transfer.fileName = metadata.fileName;
        transfer.fileSize = metadata.fileSize;
        transfer.totalChunks = metadata.totalChunks;
        transfer.checksum = metadata.checksum;
        transfer.state = "TRANSFERRING";

        this.transfers.set(
            metadata.transferId,
            transfer
        );

        this.chunkBuffers.set(
            metadata.transferId,
            new Map()
        );

        if (typeof metadata.sourceModifiedAt === "number") {
            this.sourceModifiedAt.set(
                metadata.transferId,
                metadata.sourceModifiedAt
            );
        }

        console.log(
            "[TRANSFER] Ready to receive file"
        );
    }

    /**
     * Handle an incoming file chunk.
     */
    handleChunk(
        socket: net.Socket,
        chunk: FileChunk
    ): void {
        const transfer =
            this.transfers.get(
                chunk.transferId
            );

        const chunks =
            this.chunkBuffers.get(
                chunk.transferId
            );

        if (!transfer || !chunks) {
            console.error(
                `[TRANSFER] Unknown transfer: ${chunk.transferId}`
            );

            return;
        }

        /*
         * Prevent duplicate chunks from being stored twice, but
         * still re-ack them in case our previous ack was the one
         * that got lost/delayed and the sender's watchdog resent.
         */
        if (
            chunks.has(
                chunk.chunkIndex
            )
        ) {
            console.log(
                `[TRANSFER] Duplicate chunk ignored: ${chunk.chunkIndex}`
            );

            this.acknowledgeChunk(
                socket,
                transfer,
                chunk.chunkIndex
            );

            return;
        }

        let chunkBuffer: Buffer;

        try {
            chunkBuffer =
                Buffer.from(
                    chunk.data,
                    "base64"
                );
        } catch {
            console.error(
                `[TRANSFER] Failed to decode chunk ${chunk.chunkIndex}`
            );

            return;
        }

        chunks.set(
            chunk.chunkIndex,
            chunkBuffer
        );

        if (
            chunk.chunkIndex === 0 ||
            chunk.chunkIndex === chunk.totalChunks - 1 ||
            (chunk.chunkIndex + 1) % 25 === 0
        ) {
            console.log(
                `[TRANSFER] Received chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks}`
            );
        }

        if (chunk.chunkIndex + 1 > transfer.chunksAcked) {
            transfer.chunksAcked = chunk.chunkIndex + 1;

            transfer.bytesTransferred = Math.min(
                transfer.chunksAcked * CHUNK_SIZE,
                transfer.fileSize
            );

            transfer.lastProgressAt = Date.now();
        }

        this.acknowledgeChunk(
            socket,
            transfer,
            chunk.chunkIndex
        );
    }

    private acknowledgeChunk(
        socket: net.Socket,
        transfer: Transfer,
        chunkIndex: number
    ): void {
        const ack: FileChunkAck = {
            type: TransferMessageType.FILE_CHUNK_ACK,
            version: TRANSFER_VERSION,
            transferId: transfer.transferId,
            chunkIndex,
            timestamp: Date.now(),
        };

        this.sendMessage(
            socket,
            ack
        );

        this.onEvent?.({
            transferId: transfer.transferId,
            type: "CHUNK_ACKED",
            chunkIndex,
            chunksAcked: transfer.chunksAcked,
            totalChunks: transfer.totalChunks,
            bytesTransferred: transfer.bytesTransferred,
            fileSize: transfer.fileSize,
            timestamp: Date.now(),
        });
    }

    /**
     * Discard any in-flight state for a transfer that was cancelled
     * by the peer (or by us) before it finished.
     */
    handleCancel(
        transferId: string
    ): void {
        this.chunkBuffers.delete(
            transferId
        );
    }

    /**
     * Handle completion of a file transfer.
     */
    handleComplete(
        socket: net.Socket,
        message: FileTransferComplete
    ): void {
        console.log(
            "[TRANSFER] FILE_TRANSFER_COMPLETE received"
        );

        console.log(
            `[TRANSFER] Transfer ID: ${message.transferId}`
        );

        const transfer =
            this.transfers.get(
                message.transferId
            );

        const chunks =
            this.chunkBuffers.get(
                message.transferId
            );

        if (!transfer || !chunks) {
            console.error(
                `[TRANSFER] Unknown transfer: ${message.transferId}`
            );

            return;
        }

        /*
         * Make sure all expected chunks
         * were received.
         */
        if (
            chunks.size !==
            transfer.totalChunks
        ) {
            console.error(
                `[TRANSFER] Missing chunks: received ${chunks.size}/${transfer.totalChunks}`
            );

            return;
        }

        /*
         * Reconstruct the file in the
         * correct order.
         */
        const orderedChunks: Buffer[] = [];

        for (
            let index = 0;
            index < transfer.totalChunks;
            index++
        ) {
            const chunk =
                chunks.get(index);

            if (!chunk) {
                console.error(
                    `[TRANSFER] Missing chunk: ${index}`
                );

                return;
            }

            orderedChunks.push(chunk);
        }

        const fileBuffer =
            Buffer.concat(
                orderedChunks
            );

        console.log(
            "[TRANSFER] File reconstructed"
        );

        console.log(
            `[TRANSFER] Reconstructed size: ${fileBuffer.length} bytes`
        );

        /*
         * Verify the reconstructed size
         * against the metadata.
         */
        if (
            fileBuffer.length !==
            transfer.fileSize
        ) {
            console.error(
                "[TRANSFER] File size mismatch"
            );

            console.error(
                `[TRANSFER] Expected: ${transfer.fileSize}`
            );

            console.error(
                `[TRANSFER] Received: ${fileBuffer.length}`
            );

            return;
        }

        if (
            typeof transfer.checksum !== "string" ||
            createHash("sha256").update(fileBuffer).digest("hex") !== transfer.checksum
        ) {
            console.error("[TRANSFER] File checksum mismatch");
            return;
        }

        this.onEvent?.({
            transferId: transfer.transferId,
            type: "TRANSFER_VERIFIED",
            sessionId: transfer.sessionId,
            chunksAcked: transfer.chunksAcked,
            totalChunks: transfer.totalChunks,
            bytesTransferred: transfer.bytesTransferred,
            fileSize: transfer.fileSize,
            timestamp: Date.now(),
        });

        const outputPath = this.resolveOutputPath(transfer);

        if (!outputPath) {
            return;
        }

        /*
         * Make sure the destination directory exists (sync
         * transfers can carry a relative path with subdirectories).
         */
        try {
            fs.mkdirSync(
                path.dirname(outputPath),
                {
                    recursive: true,
                }
            );
        } catch (error) {
            console.error(
                "[TRANSFER] Failed to create destination directory:",
                error
            );

            return;
        }

        /*
         * A sync-tagged transfer whose destination already holds a
         * copy modified more recently than the sender's version is a
         * conflict: don't clobber the newer local edit. Save the
         * incoming file alongside it instead so nothing is lost.
         */
        const finalPath = this.applyConflictPolicy(
            transfer,
            outputPath
        );

        /*
         * Write the reconstructed file.
         */
        try {
            fs.writeFileSync(
                finalPath,
                fileBuffer
            );
        } catch (error) {
            console.error(
                "[TRANSFER] Failed to write received file:",
                error
            );

            return;
        }

        console.log(
            `[TRANSFER] File saved: ${finalPath}`
        );

        /*
         * Mark the transfer as completed and record
         * where the file actually landed on disk.
         */
        transfer.state =
            "COMPLETED";

        transfer.savedPath =
            finalPath;

        this.onEvent?.({
            transferId: transfer.transferId,
            type: "TRANSFER_COMPLETED",
            sessionId: transfer.sessionId,
            chunksAcked: transfer.chunksAcked,
            totalChunks: transfer.totalChunks,
            bytesTransferred: transfer.bytesTransferred,
            fileSize: transfer.fileSize,
            timestamp: Date.now(),
        });

        /*
         * Tell the sender that the file
         * was successfully reconstructed
         * and saved.
         */
        const ack:
            FileTransferAck = {
            type:
                TransferMessageType.FILE_TRANSFER_ACK,

            version:
                TRANSFER_VERSION,

            transferId:
                transfer.transferId,

            timestamp:
                Date.now(),
        };

        this.sendMessage(
            socket,
            ack
        );

        console.log(
            "[TRANSFER] FILE_TRANSFER_ACK sent"
        );

        console.log(
            "[TRANSFER] Transfer completed successfully"
        );

        /*
         * The completed chunk buffers are no longer needed, but the
         * Transfer record itself stays in the shared map so it keeps
         * showing up (as COMPLETED, with its savedPath) in the UI.
         */
        this.chunkBuffers.delete(
            transfer.transferId
        );

        this.sourceModifiedAt.delete(
            transfer.transferId
        );
    }

    /**
     * Decide where a completed transfer's file should be written.
     * Sync-tagged transfers go into their pair's own folder (nested
     * under the transfer's relative path); everything else goes into
     * the flat manually-received folder.
     */
    private resolveOutputPath(
        transfer: Transfer
    ): string | undefined {
        if (transfer.syncPairId && transfer.relativePath) {
            const syncFolder = this.getSyncFolder?.(
                transfer.syncPairId
            );

            if (syncFolder) {
                const resolvedFolder =
                    path.resolve(syncFolder);

                const candidate =
                    path.resolve(
                        resolvedFolder,
                        transfer.relativePath
                    );

                /*
                 * Make sure the relative path can't escape the sync
                 * folder (e.g. via "../../" segments).
                 */
                if (
                    candidate !== resolvedFolder &&
                    !candidate.startsWith(
                        resolvedFolder + path.sep
                    )
                ) {
                    console.error(
                        `[TRANSFER] Rejecting unsafe sync path: ${transfer.relativePath}`
                    );

                    return undefined;
                }

                return candidate;
            }

            console.warn(
                `[TRANSFER] Unknown sync pair ${transfer.syncPairId}, falling back to the manual received folder`
            );
        }

        try {
            fs.mkdirSync(
                this.receivedDirectory,
                { recursive: true }
            );
        } catch (error) {
            console.error(
                "[TRANSFER] Failed to create received directory:",
                error
            );

            return undefined;
        }

        const safeFileName =
            path.basename(
                transfer.fileName
            );

        return path.join(
            this.receivedDirectory,
            safeFileName
        );
    }

    /**
     * If a sync-tagged transfer's destination already has a file
     * that was modified more recently than the sender's copy, the
     * two sides diverged independently between syncs. Rather than
     * silently overwrite the newer local edit (or the incoming one),
     * write the incoming file alongside it and report the conflict.
     */
    private applyConflictPolicy(
        transfer: Transfer,
        outputPath: string
    ): string {
        if (!transfer.syncPairId) {
            return outputPath;
        }

        const sourceModifiedAt =
            this.sourceModifiedAt.get(
                transfer.transferId
            );

        if (typeof sourceModifiedAt !== "number") {
            return outputPath;
        }

        let existingMtimeMs: number | undefined;

        try {
            existingMtimeMs =
                fs.statSync(outputPath).mtimeMs;
        } catch {
            // No existing file at this path, so there's no conflict.
            return outputPath;
        }

        if (existingMtimeMs <= sourceModifiedAt) {
            return outputPath;
        }

        const parsed = path.parse(outputPath);

        const conflictPath = path.join(
            parsed.dir,
            `${parsed.name} (sync conflict from ${transfer.peerDeviceId.slice(0, 8)})${parsed.ext}`
        );

        console.warn(
            `[TRANSFER] Sync conflict at ${outputPath}, saving incoming file as ${conflictPath}`
        );

        this.onSyncConflict?.({
            transferId: transfer.transferId,
            syncPairId: transfer.syncPairId,
            relativePath: transfer.relativePath ?? parsed.base,
            conflictPath,
        });

        return conflictPath;
    }

    private sendMessage(
        socket: net.Socket,
        message: object
    ): void {
        const payload =
            encodeMessage(message);

        socket.write(payload);
    }
}
