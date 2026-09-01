import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
    encodeMessage,
    MessageFramer,
} from "../connection/framing";

import {
    MessageType,
} from "../message-types";

import {
    TransferMessageType,
    type FileTransferRequest,
    type FileMetadata,
    type FileChunk,
    type FileTransferComplete,
} from "./transfer-messages";

const TCP_HOST = "127.0.0.1";
const TCP_PORT = 41236;

const OUTPUT_DIRECTORY =
    path.resolve(
        process.cwd(),
        "received"
    );

console.log("====================================");
console.log("   SyncBridge File Transfer Peer");
console.log("====================================");

const deviceId = randomUUID();

console.log(
    `[TEST PEER] Device ID: ${deviceId}`
);

const socket = new net.Socket();
const framer = new MessageFramer();

let receivedFileName = "";
let receivedFileSize = 0;
let receivedTotalChunks = 0;

const receivedChunks =
    new Map<number, Buffer>();

function sendMessage(
    message: object
): void {
    const payload =
        encodeMessage(message);

    socket.write(payload);
}

function sendConnectRequest(): void {
    const message = {
        type:
            MessageType.CONNECT_REQUEST,

        version: "1.0.0",

        requestId:
            randomUUID(),

        deviceId,

        timestamp:
            Date.now(),
    };

    sendMessage(message);

    console.log(
        "[TEST PEER] CONNECT_REQUEST sent"
    );
}

function handleConnectAccept(
    message: object
): void {
    console.log(
        "[TEST PEER] CONNECT_ACCEPT received"
    );

    console.log(
        `[TEST PEER] Server device ID: ${String(
            "deviceId" in message
                ? message.deviceId
                : "unknown"
        )}`
    );

    console.log(
        "[TEST PEER] Connection established"
    );
}

function handleTransferRequest(
    message: FileTransferRequest
): void {
    console.log(
        "[TEST PEER] FILE_TRANSFER_REQUEST received"
    );

    console.log(
        `[TEST PEER] Transfer ID: ${message.transferId}`
    );

    console.log(
        `[TEST PEER] File: ${message.fileName}`
    );

    const response = {
        type:
            TransferMessageType.FILE_TRANSFER_ACCEPT,

        version: "1.0.0",

        transferId:
            message.transferId,

        deviceId,

        timestamp:
            Date.now(),
    };

    sendMessage(response);

    console.log(
        "[TEST PEER] FILE_TRANSFER_ACCEPT sent"
    );
}

function handleMetadata(
    message: FileMetadata
): void {
    console.log(
        "[TEST PEER] FILE_METADATA received"
    );

    receivedFileName =
        path.basename(
            message.fileName
        );

    receivedFileSize =
        message.fileSize;

    receivedTotalChunks =
        message.totalChunks;

    receivedChunks.clear();

    console.log(
        `[TEST PEER] File: ${receivedFileName}`
    );

    console.log(
        `[TEST PEER] Size: ${receivedFileSize} bytes`
    );

    console.log(
        `[TEST PEER] Total chunks: ${receivedTotalChunks}`
    );
}

function handleChunk(
    message: FileChunk
): void {
    console.log(
        `[TEST PEER] FILE_CHUNK received: ${
            message.chunkIndex + 1
        }/${message.totalChunks}`
    );

    if (
        receivedChunks.has(
            message.chunkIndex
        )
    ) {
        console.log(
            `[TEST PEER] Duplicate chunk ignored: ${message.chunkIndex}`
        );

        return;
    }

    let chunkBuffer: Buffer;

    try {
        chunkBuffer =
            Buffer.from(
                message.data,
                "base64"
            );
    } catch {
        console.error(
            `[TEST PEER] Failed to decode chunk ${message.chunkIndex}`
        );

        return;
    }

    receivedChunks.set(
        message.chunkIndex,
        chunkBuffer
    );

    console.log(
        `[TEST PEER] Chunk size: ${chunkBuffer.length} bytes`
    );
}

function handleTransferComplete(
    message: FileTransferComplete
): void {
    console.log(
        "[TEST PEER] FILE_TRANSFER_COMPLETE received"
    );

    console.log(
        `[TEST PEER] Transfer ID: ${message.transferId}`
    );

    if (
        receivedChunks.size !==
        receivedTotalChunks
    ) {
        console.error(
            `[TEST PEER] Missing chunks: ${
                receivedChunks.size
            }/${receivedTotalChunks}`
        );

        return;
    }

    const orderedChunks: Buffer[] = [];

    for (
        let index = 0;
        index < receivedTotalChunks;
        index++
    ) {
        const chunk =
            receivedChunks.get(index);

        if (!chunk) {
            console.error(
                `[TEST PEER] Missing chunk: ${index}`
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
        `[TEST PEER] Reconstructed size: ${fileBuffer.length} bytes`
    );

    if (
        fileBuffer.length !==
        receivedFileSize
    ) {
        console.error(
            "[TEST PEER] File size mismatch"
        );

        console.error(
            `[TEST PEER] Expected: ${receivedFileSize}`
        );

        console.error(
            `[TEST PEER] Received: ${fileBuffer.length}`
        );

        return;
    }

    fs.mkdirSync(
        OUTPUT_DIRECTORY,
        {
            recursive: true,
        }
    );

    const outputPath =
        path.join(
            OUTPUT_DIRECTORY,
            receivedFileName
        );

    fs.writeFileSync(
        outputPath,
        fileBuffer
    );

    console.log(
        `[TEST PEER] File saved: ${outputPath}`
    );

    const ack = {
        type:
            TransferMessageType.FILE_TRANSFER_ACK,

        version: "1.0.0",

        transferId:
            message.transferId,

        timestamp:
            Date.now(),
    };

    sendMessage(ack);

    console.log(
        "[TEST PEER] FILE_TRANSFER_ACK sent"
    );

    console.log("");
    console.log(
        "===================================="
    );
    console.log(
        "   FILE TRANSFER TEST SUCCESSFUL"
    );
    console.log(
        "===================================="
    );
}

function handleMessage(
    message: object
): void {
    if (
        !("type" in message)
    ) {
        console.error(
            "[TEST PEER] Invalid message"
        );

        return;
    }

    switch (message.type) {
        case MessageType.CONNECT_ACCEPT:
            handleConnectAccept(
                message
            );
            break;

        case TransferMessageType.FILE_TRANSFER_REQUEST:
            handleTransferRequest(
                message as FileTransferRequest
            );
            break;

        case TransferMessageType.FILE_METADATA:
            handleMetadata(
                message as FileMetadata
            );
            break;

        case TransferMessageType.FILE_CHUNK:
            handleChunk(
                message as FileChunk
            );
            break;

        case TransferMessageType.FILE_TRANSFER_COMPLETE:
            handleTransferComplete(
                message as FileTransferComplete
            );
            break;

        default:
            console.log(
                `[TEST PEER] Received: ${String(
                    message.type
                )}`
            );
    }
}

socket.on(
    "data",
    (data) => {
        const buffer =
            Buffer.isBuffer(data)
                ? data
                : Buffer.from(data);

        const messages =
            framer.addData(buffer);

        for (
            const message of messages
        ) {
            handleMessage(
                message
            );
        }
    }
);

socket.on(
    "connect",
    () => {
        console.log(
            `[TEST PEER] TCP connection established`
        );

        sendConnectRequest();
    }
);

socket.on(
    "error",
    (error) => {
        console.error(
            "[TEST PEER] Connection error:",
            error
        );
    }
);

socket.on(
    "close",
    () => {
        console.log(
            "[TEST PEER] Connection closed"
        );
    }
);

process.on(
    "SIGINT",
    () => {
        console.log(
            "\n[TEST PEER] Shutting down..."
        );

        socket.destroy();

        process.exit(0);
    }
);

console.log(
    `[TEST PEER] Connecting to ${TCP_HOST}:${TCP_PORT}`
);

socket.connect(
    TCP_PORT,
    TCP_HOST
);