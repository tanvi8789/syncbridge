import { randomUUID } from "node:crypto";
import net from "node:net";

import {
    TransferMessageType,
    type FileTransferRequest,
    type FileTransferAccept,
    type FileTransferReject,
    type FileMetadata,
    type FileChunk,
    type FileTransferComplete,
    type FileTransferAck,
} from "./transfer-messages";

import {
    TRANSFER_VERSION,
    CHUNK_SIZE,
} from "./transfer-config";

import {
    encodeMessage,
    MessageFramer,
} from "../connection/framing";

interface Transfer {
    transferId: string;
    fileName: string;
    fileSize: number;
    totalChunks: number;
    state: "REQUESTED" | "ACCEPTED" | "TRANSFERRING" | "COMPLETED";
}

export class TransferManager {
    private transfers = new Map<string, Transfer>();

    /**
     * Request a file transfer from a connected peer.
     */
    requestTransfer(
        socket: net.Socket,
        senderDeviceId: string,
        fileName: string,
        fileSize: number
    ): string {
        const transferId = randomUUID();

        const totalChunks = Math.ceil(
            fileSize / CHUNK_SIZE
        );

        const transfer: Transfer = {
            transferId,
            fileName,
            fileSize,
            totalChunks,
            state: "REQUESTED",
        };

        this.transfers.set(
            transferId,
            transfer
        );

        const request: FileTransferRequest = {
            type:
                TransferMessageType.FILE_TRANSFER_REQUEST,

            version: TRANSFER_VERSION,

            transferId,

            senderDeviceId,

            fileName,

            timestamp: Date.now(),
        };

        this.sendMessage(
            socket,
            request
        );

        console.log(
            `[TRANSFER] FILE_TRANSFER_REQUEST sent`
        );

        console.log(
            `[TRANSFER] Transfer ID: ${transferId}`
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

        return transferId;
    }

    /**
     * Handle incoming transfer messages.
     */
    handleMessage(
        socket: net.Socket,
        message: object
    ): void {
        if (
            !("type" in message)
        ) {
            console.log(
                "[TRANSFER] Invalid transfer message"
            );

            return;
        }

        switch (message.type) {
            case TransferMessageType.FILE_TRANSFER_REQUEST:
                this.handleTransferRequest(
                    socket,
                    message as FileTransferRequest
                );

                break;

            case TransferMessageType.FILE_TRANSFER_ACCEPT:
                this.handleTransferAccept(
                    message as FileTransferAccept
                );

                break;

            case TransferMessageType.FILE_TRANSFER_REJECT:
                this.handleTransferReject(
                    message as FileTransferReject
                );

                break;

            case TransferMessageType.FILE_METADATA:
                this.handleFileMetadata(
                    message as FileMetadata
                );

                break;

            case TransferMessageType.FILE_CHUNK:
                this.handleFileChunk(
                    message as FileChunk
                );

                break;

            case TransferMessageType.FILE_TRANSFER_COMPLETE:
                this.handleTransferComplete(
                    socket,
                    message as FileTransferComplete
                );

                break;

            case TransferMessageType.FILE_TRANSFER_ACK:
                this.handleTransferAck(
                    message as FileTransferAck
                );

                break;

            default:
                console.log(
                    `[TRANSFER] Unknown message type: ${String(message.type)}`
                );
        }
    }

    private handleTransferRequest(
        socket: net.Socket,
        request: FileTransferRequest
    ): void {
        console.log(
            `[TRANSFER] FILE_TRANSFER_REQUEST received`
        );

        console.log(
            `[TRANSFER] Transfer ID: ${request.transferId}`
        );

        console.log(
            `[TRANSFER] File: ${request.fileName}`
        );

        /*
         * For now, automatically accept the transfer.
         *
         * Later this can check:
         * - available disk space
         * - permissions
         * - existing transfers
         * - user approval
         */
        const response: FileTransferAccept = {
            type:
                TransferMessageType.FILE_TRANSFER_ACCEPT,

            version: TRANSFER_VERSION,

            transferId: request.transferId,

            deviceId: "local-device",

            timestamp: Date.now(),
        };

        this.sendMessage(
            socket,
            response
        );

        console.log(
            `[TRANSFER] FILE_TRANSFER_ACCEPT sent`
        );
    }

    private handleTransferAccept(
        response: FileTransferAccept
    ): void {
        console.log(
            `[TRANSFER] FILE_TRANSFER_ACCEPT received`
        );

        const transfer =
            this.transfers.get(
                response.transferId
            );

        if (!transfer) {
            console.log(
                `[TRANSFER] Unknown transfer: ${response.transferId}`
            );

            return;
        }

        transfer.state = "ACCEPTED";

        console.log(
            `[TRANSFER] Transfer ${response.transferId} accepted`
        );
    }

    private handleTransferReject(
        response: FileTransferReject
    ): void {
        console.log(
            `[TRANSFER] FILE_TRANSFER_REJECT received`
        );

        console.log(
            `[TRANSFER] Reason: ${response.reason}`
        );

        this.transfers.delete(
            response.transferId
        );
    }

    private handleFileMetadata(
        metadata: FileMetadata
    ): void {
        console.log(
            `[TRANSFER] FILE_METADATA received`
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
    }

    private handleFileChunk(
        chunk: FileChunk
    ): void {
        console.log(
            `[TRANSFER] FILE_CHUNK received`
        );

        console.log(
            `[TRANSFER] Transfer ID: ${chunk.transferId}`
        );

        console.log(
            `[TRANSFER] Chunk: ${chunk.chunkIndex + 1}/${chunk.totalChunks}`
        );

        /*
         * The actual Base64 decoding and file writing
         * will be implemented in the next step.
         */
    }

    private handleTransferComplete(
        socket: net.Socket,
        message: FileTransferComplete
    ): void {
        console.log(
            `[TRANSFER] FILE_TRANSFER_COMPLETE received`
        );

        console.log(
            `[TRANSFER] Transfer ID: ${message.transferId}`
        );

        const ack: FileTransferAck = {
            type:
                TransferMessageType.FILE_TRANSFER_ACK,

            version: TRANSFER_VERSION,

            transferId: message.transferId,

            timestamp: Date.now(),
        };

        this.sendMessage(
            socket,
            ack
        );

        console.log(
            `[TRANSFER] FILE_TRANSFER_ACK sent`
        );
    }

    private handleTransferAck(
        message: FileTransferAck
    ): void {
        console.log(
            `[TRANSFER] FILE_TRANSFER_ACK received`
        );

        const transfer =
            this.transfers.get(
                message.transferId
            );

        if (!transfer) {
            console.log(
                `[TRANSFER] Unknown transfer: ${message.transferId}`
            );

            return;
        }

        transfer.state = "COMPLETED";

        console.log(
            `[TRANSFER] Transfer ${message.transferId} completed`
        );
    }

    private sendMessage(
        socket: net.Socket,
        message: object
    ): void {
        const payload = encodeMessage(
            message
        );

        socket.write(payload);
    }
}