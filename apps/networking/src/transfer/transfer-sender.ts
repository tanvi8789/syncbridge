import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { createHash } from "node:crypto";

import {
    TransferMessageType,
    type FileMetadata,
    type FileChunk,
    type FileTransferComplete,
} from "./transfer-messages";

import {
    TRANSFER_VERSION,
    CHUNK_SIZE,
    CHUNK_ACK_TIMEOUT_MS,
    PROGRESS_EVENT_INTERVAL_MS,
} from "./transfer-config";

import {
    encodeMessage,
} from "../connection/framing";

import type { Transfer } from "./transfer-state";
import type { TransferEvent, TransferEventListener } from "./transfer-event";

interface SendControl {
    paused: boolean;
    cancelled: boolean;
    resumeWaiters: Array<() => void>;
    highestSentIndex: number;
    lastAckAt: number;
    lastProgressEmitAt: number;
}

export class TransferSender {
    private activeSends =
        new Map<string, SendControl>();

    constructor(
        private readonly onEvent?: TransferEventListener
    ) {}

    /**
     * Send a file to a connected peer.
     */
    async sendFile(
        socket: net.Socket,
        transfer: Transfer,
        filePath: string
    ): Promise<void> {
        if (!fs.existsSync(filePath)) {
            console.error(
                `[TRANSFER] File does not exist: ${filePath}`
            );

            return;
        }

        const stats =
            fs.statSync(filePath);

        if (!stats.isFile()) {
            console.error(
                `[TRANSFER] Path is not a file: ${filePath}`
            );

            return;
        }

        const fileName =
            path.basename(filePath);

        const fileSize =
            stats.size;

        const totalChunks =
            Math.ceil(
                fileSize / CHUNK_SIZE
            );

        /*
         * Update transfer information
         * using the actual file.
         */
        transfer.fileName =
            fileName;

        transfer.fileSize =
            fileSize;

        transfer.totalChunks =
            totalChunks;

        transfer.state =
            "TRANSFERRING";

        transfer.startedAt =
            Date.now();

        // The receiver verifies this before committing the completed file.
        const fileBuffer = fs.readFileSync(filePath);
        const checksum = createHash("sha256")
            .update(fileBuffer)
            .digest("hex");
        transfer.checksum = checksum;

        const control: SendControl = {
            paused: false,
            cancelled: false,
            resumeWaiters: [],
            highestSentIndex: -1,
            lastAckAt: Date.now(),
            lastProgressEmitAt: 0,
        };

        this.activeSends.set(
            transfer.transferId,
            control
        );

        /*
         * Send file metadata first.
         */
        const metadata:
            FileMetadata = {
                type:
                    TransferMessageType.FILE_METADATA,

                version:
                    TRANSFER_VERSION,

                transferId:
                    transfer.transferId,

                fileName,

                fileSize,

                totalChunks,

                checksum,

                timestamp:
                    Date.now(),
            };

        this.sendMessage(
            socket,
            metadata
        );

        console.log(
            `[TRANSFER] FILE_METADATA sent`
        );

        console.log(
            `[TRANSFER] File: ${fileName}`
        );

        console.log(
            `[TRANSFER] Size: ${fileSize} bytes`
        );

        console.log(
            `[TRANSFER] Total chunks: ${totalChunks}`
        );

        /*
         * Watchdog: if the receiver stops acknowledging chunks for
         * too long while chunks are still in flight, resend them.
         * TCP already guarantees delivery on a live connection, so
         * this mainly recovers from a stalled/unresponsive peer.
         */
        const watchdog = setInterval(() => {
            this.checkForStalledChunks(
                socket,
                transfer,
                control,
                fileBuffer,
                totalChunks
            );
        }, 1000);

        try {
            /*
             * Split the file into chunks and send each one,
             * honoring socket backpressure and pause requests.
             */
            for (
                let chunkIndex = 0;
                chunkIndex < totalChunks;
                chunkIndex++
            ) {
                if (control.cancelled) {
                    break;
                }

                await this.waitWhilePaused(
                    control
                );

                if (control.cancelled) {
                    break;
                }

                const wroteImmediately =
                    this.sendChunk(
                        socket,
                        transfer,
                        fileBuffer,
                        chunkIndex,
                        totalChunks
                    );

                control.highestSentIndex =
                    chunkIndex;

                this.emitProgress(
                    transfer,
                    control,
                    false
                );

                if (!wroteImmediately) {
                    await once(
                        socket,
                        "drain"
                    );
                }
            }

            if (control.cancelled) {
                console.log(
                    `[TRANSFER] Transfer cancelled: ${transfer.transferId}`
                );

                return;
            }

            /*
             * Tell the receiver that all
             * chunks have been sent.
             */
            const complete:
                FileTransferComplete = {
                    type:
                        TransferMessageType.FILE_TRANSFER_COMPLETE,

                    version:
                        TRANSFER_VERSION,

                    transferId:
                        transfer.transferId,

                    totalChunks,

                    timestamp:
                        Date.now(),
                };

            this.sendMessage(
                socket,
                complete
            );

            console.log(
                `[TRANSFER] FILE_TRANSFER_COMPLETE sent`
            );
        } finally {
            clearInterval(watchdog);
        }
    }

    /**
     * Called by TransferManager whenever a FILE_CHUNK_ACK arrives
     * for a transfer this sender is driving.
     */
    notifyAck(
        transferId: string
    ): void {
        const control =
            this.activeSends.get(
                transferId
            );

        if (control) {
            control.lastAckAt =
                Date.now();
        }
    }

    pause(
        transferId: string
    ): void {
        const control =
            this.activeSends.get(
                transferId
            );

        if (control) {
            control.paused = true;
        }
    }

    resume(
        transferId: string
    ): void {
        const control =
            this.activeSends.get(
                transferId
            );

        if (!control) {
            return;
        }

        control.paused = false;

        const waiters =
            control.resumeWaiters.splice(0);

        for (const resolve of waiters) {
            resolve();
        }
    }

    cancel(
        transferId: string
    ): void {
        const control =
            this.activeSends.get(
                transferId
            );

        if (!control) {
            return;
        }

        control.cancelled = true;

        // Unblock the send loop if it's currently paused so it can
        // observe the cancellation and exit.
        this.resume(transferId);
    }

    private sendChunk(
        socket: net.Socket,
        transfer: Transfer,
        fileBuffer: Buffer,
        chunkIndex: number,
        totalChunks: number
    ): boolean {
        const start =
            chunkIndex * CHUNK_SIZE;

        const end =
            Math.min(
                start + CHUNK_SIZE,
                fileBuffer.length
            );

        const chunkBuffer =
            fileBuffer.subarray(
                start,
                end
            );

        const chunk:
            FileChunk = {
            type:
                TransferMessageType.FILE_CHUNK,

            version:
                TRANSFER_VERSION,

            transferId:
                transfer.transferId,

            chunkIndex,

            totalChunks,

            data:
                chunkBuffer.toString(
                    "base64"
                ),

            timestamp:
                Date.now(),
        };

        const wroteImmediately =
            this.sendMessage(
                socket,
                chunk
            );

        this.onEvent?.(
            this.buildEvent(
                "CHUNK_SENT",
                transfer,
                chunkIndex
            )
        );

        if (
            chunkIndex === 0 ||
            chunkIndex === totalChunks - 1 ||
            (chunkIndex + 1) % 25 === 0
        ) {
            console.log(
                `[TRANSFER] Sent chunk ${chunkIndex + 1}/${totalChunks}`
            );
        }

        return wroteImmediately;
    }

    private checkForStalledChunks(
        socket: net.Socket,
        transfer: Transfer,
        control: SendControl,
        fileBuffer: Buffer,
        totalChunks: number
    ): void {
        if (
            control.cancelled ||
            control.paused
        ) {
            return;
        }

        const fullyAcked =
            transfer.chunksAcked >
            control.highestSentIndex;

        if (fullyAcked) {
            return;
        }

        if (
            Date.now() - control.lastAckAt <
            CHUNK_ACK_TIMEOUT_MS
        ) {
            return;
        }

        console.warn(
            `[TRANSFER] No ack progress for ${transfer.transferId}, ` +
                `resending chunks ${transfer.chunksAcked}-${control.highestSentIndex}`
        );

        for (
            let chunkIndex = transfer.chunksAcked;
            chunkIndex <= control.highestSentIndex;
            chunkIndex++
        ) {
            this.sendChunk(
                socket,
                transfer,
                fileBuffer,
                chunkIndex,
                totalChunks
            );

            transfer.retryCount += 1;

            this.onEvent?.(
                this.buildEvent(
                    "CHUNK_RETRY",
                    transfer,
                    chunkIndex
                )
            );
        }

        // Give the resent chunks a full timeout window before
        // considering them stalled again.
        control.lastAckAt = Date.now();
    }

    private waitWhilePaused(
        control: SendControl
    ): Promise<void> {
        if (!control.paused) {
            return Promise.resolve();
        }

        return new Promise((resolve) => {
            control.resumeWaiters.push(resolve);
        });
    }

    private emitProgress(
        transfer: Transfer,
        control: SendControl,
        force: boolean
    ): void {
        const now = Date.now();

        if (
            !force &&
            now - control.lastProgressEmitAt <
                PROGRESS_EVENT_INTERVAL_MS
        ) {
            return;
        }

        control.lastProgressEmitAt = now;

        this.onEvent?.(
            this.buildEvent(
                "TRANSFER_PROGRESS",
                transfer
            )
        );
    }

    private buildEvent(
        type: TransferEvent["type"],
        transfer: Transfer,
        chunkIndex?: number
    ): TransferEvent {
        return {
            transferId:
                transfer.transferId,

            type,

            chunkIndex,

            chunksAcked:
                transfer.chunksAcked,

            totalChunks:
                transfer.totalChunks,

            bytesTransferred:
                transfer.bytesTransferred,

            fileSize:
                transfer.fileSize,

            timestamp:
                Date.now(),
        };
    }

    private sendMessage(
        socket: net.Socket,
        message: object
    ): boolean {
        const payload =
            encodeMessage(message);

        return socket.write(payload);
    }
}
