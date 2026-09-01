import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";

import {
    MessageFramer,
    encodeMessage,
} from "../connection/framing";

import {
    MessageType,
} from "../message-types";

const TCP_HOST = "127.0.0.1";
const TCP_PORT = 41236;

const TEST_FILE = path.resolve(
    process.cwd(),
    "test-transfer.txt"
);

const peerDeviceId = randomUUID();

const socket = new net.Socket();
const framer = new MessageFramer();

console.log("====================================");
console.log("   SyncBridge File Transfer Sender");
console.log("====================================");

console.log(
    `[TEST SENDER] Device ID: ${peerDeviceId}`
);

if (!fs.existsSync(TEST_FILE)) {
    fs.writeFileSync(
        TEST_FILE,
        "Hello from SyncBridge!\nThis is a file transfer test.\n"
    );

    console.log(
        `[TEST SENDER] Created test file: ${TEST_FILE}`
    );
}

function sendMessage(
    message: object
): void {
    socket.write(
        encodeMessage(message)
    );
}

function sendConnectRequest(): void {
    const request = {
        type:
            MessageType.CONNECT_REQUEST,

        version: "1.0.0",

        requestId:
            randomUUID(),

        deviceId:
            peerDeviceId,

        timestamp:
            Date.now(),
    };

    sendMessage(request);

    console.log(
        "[TEST SENDER] CONNECT_REQUEST sent"
    );
}

socket.on(
    "connect",
    () => {
        console.log(
            "[TEST SENDER] TCP connection established"
        );

        sendConnectRequest();
    }
);

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
            console.log(
                "[TEST SENDER] Received:",
                message
            );

            if (
                "type" in message &&
                message.type ===
                    MessageType.CONNECT_ACCEPT
            ) {
                console.log(
                    "[TEST SENDER] CONNECT_ACCEPT received"
                );

                console.log(
                    "[TEST SENDER] Handshake successful"
                );

                /*
                 * The actual file transfer is
                 * triggered by the SyncBridge
                 * ConnectionManager.
                 */
            }
        }
    }
);

socket.on(
    "error",
    (error) => {
        console.error(
            "[TEST SENDER] Connection error:",
            error
        );
    }
);

socket.on(
    "close",
    () => {
        console.log(
            "[TEST SENDER] Connection closed"
        );
    }
);

process.on(
    "SIGINT",
    () => {
        socket.destroy();
        process.exit(0);
    }
);

console.log(
    `[TEST SENDER] Connecting to ${TCP_HOST}:${TCP_PORT}`
);

socket.connect(
    TCP_PORT,
    TCP_HOST
);