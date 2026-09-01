import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
    ConnectionManager,
} from "../connection/connection-manager";

import {
    TcpServer,
} from "../connection/tcp-server";

const TCP_PORT = 41236;

const TEST_FILE =
    path.resolve(
        process.cwd(),
        "test-files",
        "10mb.bin"
    );

const RECEIVED_FILE =
    path.resolve(
        process.cwd(),
        "received",
        "10mb.bin"
    );

const serverDeviceId =
    randomUUID();

const clientDeviceId =
    randomUUID();

async function main(): Promise<void> {
    console.log("====================================");
    console.log("   SyncBridge File Transfer Test");
    console.log("====================================");

    console.log(
        `[TEST] Server device ID: ${serverDeviceId}`
    );

    console.log(
        `[TEST] Client device ID: ${clientDeviceId}`
    );

    /*
     * Create a test file.
     */
    if (!fs.existsSync(TEST_FILE)) {
        throw new Error(
            `Missing test file: ${TEST_FILE}`
        );
    }

    console.log(
        `[TEST] Test file created: ${TEST_FILE}`
    );

    /*
     * Server-side ConnectionManager.
     *
     * This side will use the real
     * TransferReceiver.
     */
    const serverConnection =
        new ConnectionManager(
            serverDeviceId
        );

    /*
     * Real TCP server.
     */
    const tcpServer =
        new TcpServer(
            (socket) => {
                serverConnection.handleIncomingConnection(
                    socket
                );
            }
        );

    tcpServer.start();

    /*
     * Give the TCP server time to start.
     */
    await delay(500);

    /*
     * Client-side ConnectionManager.
     *
     * This side will use the real
     * TransferSender.
     */
    const clientConnection =
        new ConnectionManager(
            clientDeviceId
        );

    /*
     * Simulate a discovered device.
     */
    const serverDevice = {
        deviceId: serverDeviceId,
        deviceName: "SyncBridge Test Server",
        ip: "127.0.0.1",
        platform: process.platform,
        lastSeen: Date.now(),
    };

    console.log(
        `[TEST] Connecting to server on 127.0.0.1:${TCP_PORT}`
    );

    /*
     * Real ConnectionManager connection.
     */
    await clientConnection.connectToDevice(
        serverDevice
    );

    console.log(
        "[TEST] TCP connection established"
    );

    /*
     * Wait for CONNECT_REQUEST /
     * CONNECT_ACCEPT to complete.
     */
    await waitForConnection(
        clientConnection,
        serverDeviceId
    );

    console.log(
        "[TEST] TCP handshake successful"
    );

    console.log(
        "[TEST] Starting file transfer..."
    );

    /*
     * Start the actual transfer.
     *
     * This invokes:
     *
     * ConnectionManager
     *      ↓
     * TransferManager
     *      ↓
     * TransferSender
     */
    await clientConnection.sendFile(
        serverDeviceId,
        TEST_FILE
    );

    /*
     * The transfer continues asynchronously
     * after FILE_TRANSFER_ACCEPT.
     *
     * Give the receiver time to reconstruct
     * and save the file.
     */
    await delay(8000);

    /*
     * Verify that the receiver created
     * the file.
     */
    if (
        !fs.existsSync(
            RECEIVED_FILE
        )
    ) {
        console.error(
            `[TEST] Received file not found: ${RECEIVED_FILE}`
        );

        tcpServer.stop();
        process.exit(1);
    }

    const original =
        fs.readFileSync(
            TEST_FILE
        );

    const received =
        fs.readFileSync(
            RECEIVED_FILE
        );

    console.log(
        `[TEST] Original size: ${original.length} bytes`
    );

    console.log(
        `[TEST] Received size: ${received.length} bytes`
    );

    /*
     * Compare the actual bytes.
     */
    if (
        !original.equals(received)
    ) {
        console.error(
            "[TEST] File contents do not match"
        );

        tcpServer.stop();
        process.exit(1);
    }

    console.log(
        "[TEST] File contents verified"
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

    tcpServer.stop();

    /*
     * Give the server a moment to close.
     */
    await delay(100);

    process.exit(0);
}

async function waitForConnection(
    connectionManager: ConnectionManager,
    deviceId: string
): Promise<void> {
    const timeout =
        Date.now() + 5000;

    while (
        Date.now() < timeout
    ) {
        const connectedDevices =
            connectionManager.getConnectedDevices();

        if (
            connectedDevices.includes(
                deviceId
            )
        ) {
            return;
        }

        await delay(100);
    }

    throw new Error(
        `Timed out waiting for connection to ${deviceId}`
    );
}

function delay(
    milliseconds: number
): Promise<void> {
    return new Promise(
        (resolve) => {
            setTimeout(
                resolve,
                milliseconds
            );
        }
    );
}

main().catch(
    (error) => {
        console.error(
            "[TEST] Test failed:",
            error
        );

        process.exit(1);
    }
);