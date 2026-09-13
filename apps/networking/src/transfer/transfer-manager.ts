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
    type FileChunkAck,
    type FileTransferComplete,
    type FileTransferAck,
    type FileTransferPause,
    type FileTransferResume,
    type FileTransferCancel,
} from "./transfer-messages";

import {
    TRANSFER_VERSION,
    CHUNK_SIZE,
} from "./transfer-config";

const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

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

import type {
    TransferEventListener,
} from "./transfer-event";

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

    constructor(
        private readonly onEvent?: TransferEventListener
    ) {
        this.sender =
            new TransferSender(onEvent);

        this.receiver =
            new TransferReceiver(this.transfers, onEvent);
    }

    /**
     * Request a file transfer from
     * a connected peer.
     */
    requestTransfer(
        socket: net.Socket,
        senderDeviceId: string,
        filePath: string,
        peerDeviceId: string
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

        if (fileSize > MAX_FILE_BYTES) {
            throw new Error("Files larger than 2 GiB are not supported");
        }

        const totalChunks =
            Math.ceil(
                fileSize / CHUNK_SIZE
            );

        const transfer: Transfer = {
            transferId,

            direction: "sent",
            peerDeviceId,

            fileName,

            fileSize,

            totalChunks,

            chunksAcked: 0,
            bytesTransferred: 0,
            retryCount: 0,
            paused: false,

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
     * Pause a transfer this device is sending. Only meaningful for
     * outgoing transfers, since the sender is the only side that
     * actually controls whether chunks keep flowing.
     */
    pauseTransfer(
        transferId: string
    ): void {
        const outgoing =
            this.outgoingTransfers.get(
                transferId
            );

        if (!outgoing) {
            throw new Error(
                `No outgoing transfer to pause: ${transferId}`
            );
        }

        const { transfer, socket } = outgoing;

        transfer.state = "PAUSED";
        transfer.paused = true;

        this.sender.pause(transferId);

        const pause: FileTransferPause = {
            type: TransferMessageType.FILE_TRANSFER_PAUSE,
            version: TRANSFER_VERSION,
            transferId,
            timestamp: Date.now(),
        };

        this.sendMessage(socket, pause);

        this.onEvent?.({
            transferId,
            type: "TRANSFER_PAUSED",
            chunksAcked: transfer.chunksAcked,
            totalChunks: transfer.totalChunks,
            bytesTransferred: transfer.bytesTransferred,
            fileSize: transfer.fileSize,
            timestamp: Date.now(),
        });
    }

    resumeTransfer(
        transferId: string
    ): void {
        const outgoing =
            this.outgoingTransfers.get(
                transferId
            );

        if (!outgoing) {
            throw new Error(
                `No outgoing transfer to resume: ${transferId}`
            );
        }

        const { transfer, socket } = outgoing;

        transfer.state = "TRANSFERRING";
        transfer.paused = false;

        this.sender.resume(transferId);

        const resume: FileTransferResume = {
            type: TransferMessageType.FILE_TRANSFER_RESUME,
            version: TRANSFER_VERSION,
            transferId,
            timestamp: Date.now(),
        };

        this.sendMessage(socket, resume);

        this.onEvent?.({
            transferId,
            type: "TRANSFER_RESUMED",
            chunksAcked: transfer.chunksAcked,
            totalChunks: transfer.totalChunks,
            bytesTransferred: transfer.bytesTransferred,
            fileSize: transfer.fileSize,
            timestamp: Date.now(),
        });
    }

    cancelTransfer(
        transferId: string
    ): void {
        const outgoing =
            this.outgoingTransfers.get(
                transferId
            );

        if (!outgoing) {
            throw new Error(
                `No outgoing transfer to cancel: ${transferId}`
            );
        }

        const { transfer, socket } = outgoing;

        this.sender.cancel(transferId);

        transfer.state = "CANCELLED";

        const cancel: FileTransferCancel = {
            type: TransferMessageType.FILE_TRANSFER_CANCEL,
            version: TRANSFER_VERSION,
            transferId,
            reason: "Cancelled by sender",
            timestamp: Date.now(),
        };

        this.sendMessage(socket, cancel);

        this.outgoingTransfers.delete(transferId);
    }

    /**
     * Route incoming transfer messages
     * to the appropriate component.
     */
    handleMessage(
        socket: net.Socket,
        message: object,
        peerDeviceId: string
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
                    message as FileTransferRequest,
                    peerDeviceId
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
                    socket,
                    message as FileChunk
                );

                break;

            case TransferMessageType.FILE_CHUNK_ACK:
                this.handleChunkAck(
                    message as FileChunkAck
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

            case TransferMessageType.FILE_TRANSFER_PAUSE:
                this.handleRemotePause(
                    message as FileTransferPause
                );

                break;

            case TransferMessageType.FILE_TRANSFER_RESUME:
                this.handleRemoteResume(
                    message as FileTransferResume
                );

                break;

            case TransferMessageType.FILE_TRANSFER_CANCEL:
                this.handleRemoteCancel(
                    message as FileTransferCancel
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
        request: FileTransferRequest,
        peerDeviceId: string
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
         * Register a placeholder transfer immediately so it shows up
         * in the UI while the request is being accepted; the real
         * fileSize/totalChunks/checksum are filled in once FILE_METADATA
         * arrives (see TransferReceiver.handleMetadata).
         */
        this.transfers.set(request.transferId, {
            transferId: request.transferId,
            direction: "received",
            peerDeviceId,
            fileName: request.fileName,
            fileSize: 0,
            totalChunks: 0,
            chunksAcked: 0,
            bytesTransferred: 0,
            retryCount: 0,
            paused: false,
            state: "REQUESTED",
        });

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

    /**
     * A FILE_CHUNK_ACK confirms delivery of a chunk we sent. Acks
     * arrive in order (the receiver processes chunks as TCP delivers
     * them), so the acked index is a safe cumulative progress marker.
     */
    private handleChunkAck(
        ack: FileChunkAck
    ): void {
        const transfer =
            this.transfers.get(
                ack.transferId
            );

        if (!transfer) {
            return;
        }

        const chunksAcked =
            ack.chunkIndex + 1;

        if (chunksAcked > transfer.chunksAcked) {
            transfer.chunksAcked = chunksAcked;

            transfer.bytesTransferred =
                Math.min(
                    chunksAcked * CHUNK_SIZE,
                    transfer.fileSize
                );

            transfer.lastProgressAt = Date.now();
        }

        this.sender.notifyAck(ack.transferId);

        this.onEvent?.({
            transferId: ack.transferId,
            type: "CHUNK_ACKED",
            chunkIndex: ack.chunkIndex,
            chunksAcked: transfer.chunksAcked,
            totalChunks: transfer.totalChunks,
            bytesTransferred: transfer.bytesTransferred,
            fileSize: transfer.fileSize,
            timestamp: Date.now(),
        });
    }

    /**
     * The peer paused/resumed the transfer it's sending us; reflect
     * that in our own view so this device's UI shows it accurately.
     */
    private handleRemotePause(
        message: FileTransferPause
    ): void {
        const transfer =
            this.transfers.get(
                message.transferId
            );

        if (!transfer) {
            return;
        }

        transfer.state = "PAUSED";
        transfer.paused = true;

        this.onEvent?.({
            transferId: message.transferId,
            type: "TRANSFER_PAUSED",
            chunksAcked: transfer.chunksAcked,
            totalChunks: transfer.totalChunks,
            bytesTransferred: transfer.bytesTransferred,
            fileSize: transfer.fileSize,
            timestamp: Date.now(),
        });
    }

    private handleRemoteResume(
        message: FileTransferResume
    ): void {
        const transfer =
            this.transfers.get(
                message.transferId
            );

        if (!transfer) {
            return;
        }

        transfer.state = "TRANSFERRING";
        transfer.paused = false;

        this.onEvent?.({
            transferId: message.transferId,
            type: "TRANSFER_RESUMED",
            chunksAcked: transfer.chunksAcked,
            totalChunks: transfer.totalChunks,
            bytesTransferred: transfer.bytesTransferred,
            fileSize: transfer.fileSize,
            timestamp: Date.now(),
        });
    }

    private handleRemoteCancel(
        message: FileTransferCancel
    ): void {
        console.log(
            `[TRANSFER] FILE_TRANSFER_CANCEL received: ${message.reason}`
        );

        const transfer =
            this.transfers.get(
                message.transferId
            );

        if (transfer) {
            transfer.state = "CANCELLED";
        }

        if (this.outgoingTransfers.has(message.transferId)) {
            this.sender.cancel(message.transferId);
            this.outgoingTransfers.delete(message.transferId);
        } else {
            this.receiver.handleCancel(message.transferId);
        }
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
