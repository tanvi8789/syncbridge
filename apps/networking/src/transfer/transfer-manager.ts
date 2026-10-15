import fs from "node:fs";
import os from "node:os";
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
    SENSITIVE_EXTENSION,
    WrongPinError,
    decryptFileWithPin,
    encryptFileWithPin,
    validateSensitivePin,
} from "./sensitive-crypto";

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

    /** Holds the encrypted copy of a sensitive file until the transfer ends. */
    tempDirectory?: string;
}

const UNLOCK_MAX_ATTEMPTS = 5;
const UNLOCK_LOCKOUT_MS = 30_000;

export class TransferManager {
    private transfers =
        new Map<string, Transfer>();

    private outgoingTransfers =
        new Map<string, OutgoingTransfer>();

    private unlockAttempts =
        new Map<string, { failures: number; lockedUntil: number }>();

    private sender: TransferSender;
    private receiver: TransferReceiver;

    constructor(
        private readonly onEvent?: TransferEventListener,
        getSyncFolder?: (syncPairId: string) => string | undefined,
        onSyncConflict?: (info: {
            transferId: string;
            syncPairId: string;
            relativePath: string;
            conflictPath: string;
        }) => void,
        private readonly getSessionId?: (peerDeviceId: string) => string | undefined
    ) {
        this.sender =
            new TransferSender(onEvent);

        this.receiver =
            new TransferReceiver(
                this.transfers,
                onEvent,
                getSyncFolder,
                onSyncConflict
            );
    }

    /**
     * Request a file transfer from
     * a connected peer.
     */
    requestTransfer(
        socket: net.Socket,
        senderDeviceId: string,
        filePath: string,
        peerDeviceId: string,
        syncInfo?: { syncPairId: string; relativePath: string },
        sensitive?: { pin: string }
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

        if (stats.size > MAX_FILE_BYTES) {
            throw new Error("Files larger than 2 GiB are not supported");
        }

        /*
         * A sensitive file is encrypted into a temp copy first, and
         * that copy is what goes through the normal chunked pipeline —
         * so nothing readable is ever sent, and its name is hidden.
         */
        let sendPath = filePath;
        let tempDirectory: string | undefined;

        if (sensitive) {
            validateSensitivePin(sensitive.pin);

            tempDirectory = fs.mkdtempSync(
                path.join(os.tmpdir(), "syncbridge-")
            );
            sendPath = path.join(
                tempDirectory,
                `sensitive-${transferId.slice(0, 8)}${SENSITIVE_EXTENSION}`
            );

            try {
                encryptFileWithPin(filePath, sendPath, sensitive.pin);
            } catch (error) {
                fs.rmSync(tempDirectory, { recursive: true, force: true });
                throw error;
            }
        }

        const fileName =
            path.basename(sendPath);

        const fileSize =
            fs.statSync(sendPath).size;

        const totalChunks =
            Math.ceil(
                fileSize / CHUNK_SIZE
            );

        const sessionId = this.getSessionId?.(peerDeviceId);

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

            syncPairId: syncInfo?.syncPairId,
            relativePath: syncInfo?.relativePath,
            sessionId,

            sensitive: sensitive ? true : undefined,
            originalFileName: sensitive
                ? path.basename(filePath)
                : undefined,

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
                filePath: sendPath,
                socket,
                tempDirectory,
            }
        );

        this.onEvent?.({
            transferId,
            type: "TRANSFER_REQUESTED",
            sessionId,
            chunksAcked: 0,
            totalChunks,
            bytesTransferred: 0,
            fileSize,
            timestamp: Date.now(),
        });

        const request:
            FileTransferRequest = {
            type:
                TransferMessageType.FILE_TRANSFER_REQUEST,

            version:
                TRANSFER_VERSION,

            transferId,

            senderDeviceId,

            fileName,

            syncPairId: syncInfo?.syncPairId,
            relativePath: syncInfo?.relativePath,
            sourceModifiedAt: syncInfo ? stats.mtimeMs : undefined,

            sensitive: sensitive ? true : undefined,

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
            sessionId: transfer.sessionId,
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
            sessionId: transfer.sessionId,
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

        this.releaseOutgoing(transferId);
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
        const sessionId = this.getSessionId?.(peerDeviceId);

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
            syncPairId: request.syncPairId,
            relativePath: request.relativePath,
            sessionId,
            sensitive:
                request.sensitive === true && !request.syncPairId
                    ? true
                    : undefined,
            state: "REQUESTED",
        });

        this.onEvent?.({
            transferId: request.transferId,
            type: "TRANSFER_REQUESTED",
            sessionId,
            chunksAcked: 0,
            totalChunks: 0,
            bytesTransferred: 0,
            fileSize: 0,
            timestamp: Date.now(),
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

        this.releaseOutgoing(response.transferId);

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
         * The transfer is no longer actively
         * sending, so remove the outgoing entry.
         */
        this.releaseOutgoing(message.transferId);
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

        this.sender.notifyAck(ack.transferId, ack.chunkIndex, transfer);

        this.onEvent?.({
            transferId: ack.transferId,
            type: "CHUNK_ACKED",
            sessionId: transfer.sessionId,
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
            sessionId: transfer.sessionId,
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
            sessionId: transfer.sessionId,
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
            this.releaseOutgoing(message.transferId);
        } else {
            this.receiver.handleCancel(message.transferId);
        }
    }

    /** Forget an outgoing transfer and shred its encrypted temp copy. */
    private releaseOutgoing(transferId: string): void {
        const outgoing = this.outgoingTransfers.get(transferId);

        if (outgoing?.tempDirectory) {
            fs.rmSync(outgoing.tempDirectory, {
                recursive: true,
                force: true,
            });
        }

        this.outgoingTransfers.delete(transferId);
    }

    /**
     * Decrypt a received sensitive file with the PIN the sender
     * shared. The encrypted copy is deleted once decryption works.
     */
    unlockTransfer(transferId: string, pin: string): Transfer {
        const transfer = this.transfers.get(transferId);

        if (
            !transfer ||
            transfer.direction !== "received" ||
            !transfer.sensitive
        ) {
            throw new Error("Not a received sensitive transfer");
        }

        if (!transfer.locked || !transfer.savedPath) {
            throw new Error("This file is not locked");
        }

        const attempts = this.unlockAttempts.get(transferId) ?? {
            failures: 0,
            lockedUntil: 0,
        };

        if (Date.now() < attempts.lockedUntil) {
            throw new Error(
                `Too many wrong PINs — try again in ${Math.ceil(
                    (attempts.lockedUntil - Date.now()) / 1000
                )}s`
            );
        }

        let unlockedPath: string;

        try {
            unlockedPath = decryptFileWithPin(
                transfer.savedPath,
                path.dirname(transfer.savedPath),
                pin
            );
        } catch (error) {
            if (error instanceof WrongPinError) {
                attempts.failures++;

                if (attempts.failures >= UNLOCK_MAX_ATTEMPTS) {
                    attempts.failures = 0;
                    attempts.lockedUntil = Date.now() + UNLOCK_LOCKOUT_MS;
                }

                this.unlockAttempts.set(transferId, attempts);
            }

            throw error;
        }

        fs.rmSync(transfer.savedPath, { force: true });

        transfer.savedPath = unlockedPath;
        transfer.fileName = path.basename(unlockedPath);
        transfer.locked = false;
        this.unlockAttempts.delete(transferId);

        return transfer;
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
