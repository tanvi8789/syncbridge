import fs from "node:fs";
import path from "node:path";
import net from "node:net";

import {
    TransferMessageType,
    type FileMetadata,
    type FileChunk,
    type FileTransferComplete,
    type FileTransferAck,
} from "./transfer-messages";

import {
    TRANSFER_VERSION,
} from "./transfer-config";

import {
    encodeMessage,
} from "../connection/framing";

import type {
    Transfer,
} from "./transfer-state";

interface ReceivingTransfer {
    transfer: Transfer;
    chunks: Map<number, Buffer>;
}

export class TransferReceiver {
    private receivingTransfers =
        new Map<string, ReceivingTransfer>();

    /**
     * Directory where received files are stored.
     */
    private readonly receivedDirectory =
        path.resolve(
            process.cwd(),
            "received"
        );

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

        const transfer: Transfer = {
            transferId:
                metadata.transferId,

            fileName:
                metadata.fileName,

            fileSize:
                metadata.fileSize,

            totalChunks:
                metadata.totalChunks,

            state:
                "TRANSFERRING",
        };

        this.receivingTransfers.set(
            metadata.transferId,
            {
                transfer,
                chunks: new Map(),
            }
        );

        console.log(
            "[TRANSFER] Ready to receive file"
        );
    }

    /**
     * Handle an incoming file chunk.
     */
    handleChunk(
        chunk: FileChunk
    ): void {
        console.log(
            "[TRANSFER] FILE_CHUNK received"
        );

        const receivingTransfer =
            this.receivingTransfers.get(
                chunk.transferId
            );

        if (!receivingTransfer) {
            console.error(
                `[TRANSFER] Unknown transfer: ${chunk.transferId}`
            );

            return;
        }

        /*
         * Prevent duplicate chunks from
         * being stored twice.
         */
        if (
            receivingTransfer.chunks.has(
                chunk.chunkIndex
            )
        ) {
            console.log(
                `[TRANSFER] Duplicate chunk ignored: ${chunk.chunkIndex}`
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

        receivingTransfer.chunks.set(
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

        console.log(
            `[TRANSFER] Chunk size: ${chunkBuffer.length} bytes`
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

        const receivingTransfer =
            this.receivingTransfers.get(
                message.transferId
            );

        if (!receivingTransfer) {
            console.error(
                `[TRANSFER] Unknown transfer: ${message.transferId}`
            );

            return;
        }

        const {
            transfer,
            chunks,
        } = receivingTransfer;

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
         * Mark the transfer as completed.
         */
        transfer.state =
            "COMPLETED";

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
         * Remove the transfer from the
         * active receiving map.
         */
        this.receivingTransfers.delete(
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