import net from "node:net";
import { randomUUID } from "node:crypto";

import { MessageType } from "../message-types";
import {
    encodeMessage,
    MessageFramer,
} from "./framing";

const TCP_PORT = 41236;
const TCP_HOST = "127.0.0.1";

const TEST_DEVICE_ID = randomUUID();

const socket = new net.Socket();
const framer = new MessageFramer();

console.log("====================================");
console.log("     SyncBridge TCP Test Peer");
console.log("====================================");

console.log(
    `[TEST PEER] Device ID: ${TEST_DEVICE_ID}`
);

console.log(
    `[TEST PEER] Connecting to ${TCP_HOST}:${TCP_PORT}`
);

socket.connect(TCP_PORT, TCP_HOST, () => {
    console.log(
        "[TEST PEER] TCP connection established"
    );

    const connectRequest = {
        type: MessageType.CONNECT_REQUEST,
        version: "1.0.0",
        requestId: randomUUID(),
        deviceId: TEST_DEVICE_ID,
        timestamp: Date.now(),
    };

    const payload = encodeMessage(
        connectRequest
    );

    socket.write(payload);

    console.log(
        "[TEST PEER] CONNECT_REQUEST sent"
    );

    console.log(
        `[TEST PEER] Sent ${payload.length} bytes`
    );
});

socket.on("data", (data) => {
    const buffer = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);

    const messages = framer.addData(buffer);

    for (const message of messages) {
        console.log(
            "[TEST PEER] Received message:",
            message
        );

        if (
            "type" in message &&
            message.type ===
                MessageType.CONNECT_ACCEPT
        ) {
            console.log("");
            console.log(
                "===================================="
            );
            console.log(
                "   TCP HANDSHAKE SUCCESSFUL"
            );
            console.log(
                "===================================="
            );
            console.log(
                "[TEST PEER] CONNECT_ACCEPT received"
            );
            console.log(
                "[TEST PEER] Connection established"
            );
            console.log(
                "===================================="
            );
        }

        if (
            "type" in message &&
            message.type ===
                MessageType.CONNECT_REJECT
        ) {
            console.log("");
            console.log(
                "===================================="
            );
            console.log(
                "   TCP HANDSHAKE REJECTED"
            );
            console.log(
                "===================================="
            );
        }
    }
});

socket.on("close", () => {
    console.log(
        "[TEST PEER] Connection closed"
    );
});

socket.on("error", (error) => {
    console.error(
        "[TEST PEER] Connection error:",
        error
    );
});

process.on("SIGINT", () => {
    console.log(
        "\n[TEST PEER] Shutting down..."
    );

    socket.destroy();
});