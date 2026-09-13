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
     * Directory where received files are stored. Fixed under the
     * user's home directory so it doesn't depend on which process
     * cwd the networking engine happens to be started from.
     */
    private readonly receivedDirectory =
        path.join(
            os.homedir(),
            "SyncBridge",
            "Received"
        );

    constructor(
        private readonly transfers: Map<string, Transfer>,
        private readonly onEvent?: TransferEventListener
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

        /*
         * Make sure the received-files
         * directory exists.
         */
        try {
            fs.mkdirSync(
                this.receivedDirectory,
                {
                    recursive: true,
                }
            );
        } catch (error) {
            console.error(
                "[TRANSFER] Failed to create received directory:",
                error
            );

            return;
        }

        /*
         * Sanitize the filename so that a
         * sender cannot escape the received
         * directory using ../ paths.
         */
        const safeFileName =
            path.basename(
                transfer.fileName
            );

        const outputPath =
            path.join(
                this.receivedDirectory,
                safeFileName
            );

        /*
         * Write the reconstructed file.
         */
        try {
            fs.writeFileSync(
                outputPath,
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
            `[TRANSFER] File saved: ${outputPath}`
        );

        /*
         * Mark the transfer as completed and record
         * where the file actually landed on disk.
         */
        transfer.state =
            "COMPLETED";

        transfer.savedPath =
            outputPath;

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
