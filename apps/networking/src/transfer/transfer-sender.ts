import fs from "node:fs";
import path from "node:path";
import net from "node:net";

import {
    TransferMessageType,
    type FileMetadata,
    type FileChunk,
    type FileTransferComplete,
} from "./transfer-messages";

import {
    TRANSFER_VERSION,
    CHUNK_SIZE,
} from "./transfer-config";

import {
    encodeMessage,
} from "../connection/framing";

import type { Transfer } from "./transfer-state";

export class TransferSender {
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
         * Read the complete file.
         */
        const fileBuffer =
            fs.readFileSync(
                filePath
            );

        /*
         * Split the file into chunks
         * and send each chunk.
         */
        for (
            let chunkIndex = 0;
            chunkIndex < totalChunks;
            chunkIndex++
        ) {
            const start =
                chunkIndex *
                CHUNK_SIZE;

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

            this.sendMessage(
                socket,
                chunk
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