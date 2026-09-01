import fs from "node:fs";
import path from "node:path";
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
} from "../connection/framing";

import {
    TransferSender,
} from "./transfer-sender";

import {
    TransferReceiver,
} from "./transfer-receiver";

import type {
    Transfer,
} from "./transfer-state";

interface OutgoingTransfer {
    transfer: Transfer;
    filePath: string;
    socket: net.Socket;
}

export class TransferManager {
    private transfers =
        new Map<string, Transfer>();

    private outgoingTransfers =
        new Map<string, OutgoingTransfer>();

    private sender: TransferSender;
    private receiver: TransferReceiver;

    constructor() {
        this.sender =
            new TransferSender();

        this.receiver =
            new TransferReceiver();
    }

    /**
     * Request a file transfer from
     * a connected peer.
     */
    requestTransfer(
        socket: net.Socket,
        senderDeviceId: string,
        filePath: string
    ): string | undefined {
        /*
         * Make sure the file exists.
         */
        if (!fs.existsSync(filePath)) {
            console.error(
                `[TRANSFER] File does not exist: ${filePath}`
            );

            return undefined;
        }

        /*
         * Make sure the path points to
         * an actual file.
         */
        const stats =
            fs.statSync(filePath);

        if (!stats.isFile()) {
            console.error(
                `[TRANSFER] Path is not a file: ${filePath}`
            );

            return undefined;
        }

        const transferId =
            randomUUID();

        const fileName =
            path.basename(filePath);

        const fileSize =
            stats.size;

        const totalChunks =
            Math.ceil(
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

        this.outgoingTransfers.set(
            transferId,
            {
                transfer,
                filePath,
                socket,
            }
        );

        const request:
            FileTransferRequest = {
            type:
                TransferMessageType.FILE_TRANSFER_REQUEST,

            version:
                TRANSFER_VERSION,

            transferId,

            senderDeviceId,

            fileName,

            timestamp:
                Date.now(),
        };

        this.sendMessage(
            socket,
            request
        );

        console.log(
            "[TRANSFER] FILE_TRANSFER_REQUEST sent"
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
     * Start sending an accepted transfer.
     */
    async sendFile(
        transferId: string
    ): Promise<void> {
        const outgoing =
            this.outgoingTransfers.get(
                transferId
            );

        if (!outgoing) {
            console.error(
                `[TRANSFER] Unknown outgoing transfer: ${transferId}`
            );

            return;
        }

        const {
            transfer,
            filePath,
            socket,
        } = outgoing;

        if (
            transfer.state !==
            "ACCEPTED"
        ) {
            console.error(
                `[TRANSFER] Transfer is not accepted: ${transferId}`
            );

            return;
        }

        await this.sender.sendFile(
            socket,
            transfer,
            filePath
        );
    }

    /**
     * Route incoming transfer messages
     * to the appropriate component.
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
                this.receiver.handleMetadata(
                    message as FileMetadata
                );

                break;

            case TransferMessageType.FILE_CHUNK:
                this.receiver.handleChunk(
                    message as FileChunk
                );

                break;

            case TransferMessageType.FILE_TRANSFER_COMPLETE:
                this.receiver.handleComplete(
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
            "[TRANSFER] FILE_TRANSFER_REQUEST received"
        );

        console.log(
            `[TRANSFER] Transfer ID: ${request.transferId}`
        );

        console.log(
            `[TRANSFER] File: ${request.fileName}`
        );

        /*
         * For now, automatically accept.
         */
        const response:
            FileTransferAccept = {
            type:
                TransferMessageType.FILE_TRANSFER_ACCEPT,

            version:
                TRANSFER_VERSION,

            transferId:
                request.transferId,

            deviceId:
                "local-device",

            timestamp:
                Date.now(),
        };

        this.sendMessage(
            socket,
            response
        );

        console.log(
            "[TRANSFER] FILE_TRANSFER_ACCEPT sent"
        );
    }

    private handleTransferAccept(
        response: FileTransferAccept
    ): void {
        console.log(
            "[TRANSFER] FILE_TRANSFER_ACCEPT received"
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

        transfer.state =
            "ACCEPTED";

        console.log(
            `[TRANSFER] Transfer ${response.transferId} accepted`
        );

        /*
         * Automatically start sending the
         * file after it has been accepted.
         */
        this.sendFile(
            response.transferId
        ).catch((error) => {
            console.error(
                `[TRANSFER] Failed to send file ${response.transferId}:`,
                error
            );
        });
    }

    private handleTransferReject(
        response: FileTransferReject
    ): void {
        console.log(
            "[TRANSFER] FILE_TRANSFER_REJECT received"
        );

        console.log(
            `[TRANSFER] Reason: ${response.reason}`
        );

        const transfer =
            this.transfers.get(
                response.transferId
            );

        if (transfer) {
            transfer.state =
                "REJECTED";
        }

        this.outgoingTransfers.delete(
            response.transferId
        );

        this.transfers.delete(
            response.transferId
        );
    }

    private handleTransferAck(
        message: FileTransferAck
    ): void {
        console.log(
            "[TRANSFER] FILE_TRANSFER_ACK received"
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

        transfer.state =
            "COMPLETED";

        console.log(
            `[TRANSFER] Transfer ${message.transferId} completed`
        );

        /*
         * The transfer is no longer actively
         * sending, so remove the outgoing entry.
         */
        this.outgoingTransfers.delete(
            message.transferId
        );
    }

    getTransfer(
        transferId: string
    ): Transfer | undefined {
        return this.transfers.get(
            transferId
        );
    }

    getTransfers(): Transfer[] {
        return Array.from(
            this.transfers.values()
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