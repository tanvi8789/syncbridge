import net from "node:net";
import { randomUUID } from "node:crypto";

import { MessageType } from "../message-types";
import { encodeMessage, MessageFramer } from "./framing";
import { ConnectionManager } from "./connection-manager";
import { ConnectionState } from "./connection-state";
import type { ConnectAccept, ConnectReject } from "../connection-messages";

const TEST_PORT = 41299;
const SERVER_DEVICE_ID = "server-" + randomUUID().slice(0, 8);

function createClientSocket(): { socket: net.Socket; framer: MessageFramer } {
    const socket = new net.Socket();
    const framer = new MessageFramer();
    return { socket, framer };
}

function sendJson(socket: net.Socket, obj: object): void {
    const payload = encodeMessage(obj);
    socket.write(payload);
}

function waitForMessage(socket: net.Socket, framer: MessageFramer): Promise<any> {
    return new Promise((resolve, reject) => {
        const onData = (data: Buffer) => {
            const msgs = framer.addData(data);
            if (msgs.length > 0) {
                socket.off("data", onData);
                resolve(msgs[0]);
            }
        };
        socket.on("data", onData);
        socket.once("error", reject);
        socket.once("close", () => {
            setTimeout(() => reject(new Error("Socket closed before message")), 50);
        });
    });
}

async function runTests() {
    console.log("==================================================");
    console.log("   SyncBridge Connection & Session Lifecycle Test");
    console.log("==================================================");

    const connectionManager = new ConnectionManager(
        SERVER_DEVICE_ID,
        "Test Server Node",
        TEST_PORT
    );

    // Create and start TCP server on TEST_PORT
    const server = net.createServer((socket) => {
        connectionManager.handleIncomingConnection(socket);
    });

    await new Promise<void>((resolve) => {
        server.listen(TEST_PORT, "127.0.0.1", () => {
            console.log(`[TEST] Test server listening on 127.0.0.1:${TEST_PORT}`);
            resolve();
        });
    });

    let passedTests = 0;

    try {
        // -------------------------------------------------------------
        // Test 1: Successful Handshake & Session ID Generation
        // -------------------------------------------------------------
        console.log("\n--- Test 1: Handshake & Session ID Generation ---");
        const client1Id = "client1-" + randomUUID().slice(0, 8);
        const { socket: socket1, framer: framer1 } = createClientSocket();

        await new Promise<void>((resolve) => socket1.connect(TEST_PORT, "127.0.0.1", resolve));

        sendJson(socket1, {
            type: MessageType.CONNECT_REQUEST,
            version: "1.0.0",
            requestId: randomUUID(),
            messageId: randomUUID(),
            sequence: 0,
            deviceId: client1Id,
            deviceName: "Client One",
            platform: "darwin",
            timestamp: Date.now(),
        });

        const resp1 = (await waitForMessage(socket1, framer1)) as ConnectAccept;
        if (
            resp1.type === MessageType.CONNECT_ACCEPT &&
            resp1.deviceId === SERVER_DEVICE_ID &&
            typeof resp1.sessionId === "string" &&
            resp1.sessionId.length > 0
        ) {
            console.log(`✓ Test 1 Passed: Handshake accepted with Session ID: ${resp1.sessionId}`);
            passedTests++;
        } else {
            throw new Error(`Test 1 Failed: Unexpected response: ${JSON.stringify(resp1)}`);
        }

        // Check ConnectionManager tracking
        const conns = connectionManager.getConnections();
        const serverConn1 = conns.find((c) => c.deviceId === client1Id);
        if (!serverConn1 || serverConn1.state !== ConnectionState.CONNECTED || !serverConn1.sessionId) {
            throw new Error(`Test 1 Failed: Server connection state not tracked properly: ${JSON.stringify(serverConn1)}`);
        }
        console.log(`✓ Server correctly tracks session state: ${serverConn1.state}, sessionId: ${serverConn1.sessionId}`);

        // -------------------------------------------------------------
        // Test 2: Reject Duplicate Connection
        // -------------------------------------------------------------
        console.log("\n--- Test 2: Reject Duplicate Connection ---");
        const { socket: socketDup, framer: framerDup } = createClientSocket();
        await new Promise<void>((resolve) => socketDup.connect(TEST_PORT, "127.0.0.1", resolve));

        sendJson(socketDup, {
            type: MessageType.CONNECT_REQUEST,
            version: "1.0.0",
            requestId: randomUUID(),
            messageId: randomUUID(),
            sequence: 1,
            deviceId: client1Id, // Same device ID as client1!
            deviceName: "Duplicate Client",
            platform: "darwin",
            timestamp: Date.now(),
        });

        const respDup = (await waitForMessage(socketDup, framerDup)) as ConnectReject;
        if (
            respDup.type === MessageType.CONNECT_REJECT &&
            respDup.reason === "DUPLICATE_CONNECTION"
        ) {
            console.log("✓ Test 2 Passed: Duplicate connection correctly rejected with DUPLICATE_CONNECTION");
            passedTests++;
        } else {
            throw new Error(`Test 2 Failed: Expected CONNECT_REJECT with DUPLICATE_CONNECTION, got: ${JSON.stringify(respDup)}`);
        }

        // -------------------------------------------------------------
        // Test 3: Reject Incompatible Protocol Version
        // -------------------------------------------------------------
        console.log("\n--- Test 3: Incompatible Protocol Version ---");
        const clientVersionMismatchId = "client-v2-" + randomUUID().slice(0, 8);
        const { socket: socketVer, framer: framerVer } = createClientSocket();
        await new Promise<void>((resolve) => socketVer.connect(TEST_PORT, "127.0.0.1", resolve));

        sendJson(socketVer, {
            type: MessageType.CONNECT_REQUEST,
            version: "9.9.9", // Incompatible version
            requestId: randomUUID(),
            messageId: randomUUID(),
            sequence: 2,
            deviceId: clientVersionMismatchId,
            timestamp: Date.now(),
        });

        const respVer = (await waitForMessage(socketVer, framerVer)) as ConnectReject;
        if (
            respVer.type === MessageType.CONNECT_REJECT &&
            respVer.reason === "VERSION_MISMATCH"
        ) {
            console.log("✓ Test 3 Passed: Incompatible version correctly rejected with VERSION_MISMATCH");
            passedTests++;
        } else {
            throw new Error(`Test 3 Failed: Expected VERSION_MISMATCH, got: ${JSON.stringify(respVer)}`);
        }

        // -------------------------------------------------------------
        // Test 4: Reject Self-Connection
        // -------------------------------------------------------------
        console.log("\n--- Test 4: Self-Connection Rejection ---");
        const { socket: socketSelf, framer: framerSelf } = createClientSocket();
        await new Promise<void>((resolve) => socketSelf.connect(TEST_PORT, "127.0.0.1", resolve));

        sendJson(socketSelf, {
            type: MessageType.CONNECT_REQUEST,
            version: "1.0.0",
            requestId: randomUUID(),
            messageId: randomUUID(),
            sequence: 3,
            deviceId: SERVER_DEVICE_ID, // Connecting with server's own device ID
            timestamp: Date.now(),
        });

        const respSelf = (await waitForMessage(socketSelf, framerSelf)) as ConnectReject;
        if (
            respSelf.type === MessageType.CONNECT_REJECT &&
            respSelf.reason === "SELF_CONNECTION"
        ) {
            console.log("✓ Test 4 Passed: Self-connection correctly rejected with SELF_CONNECTION");
            passedTests++;
        } else {
            throw new Error(`Test 4 Failed: Expected SELF_CONNECTION, got: ${JSON.stringify(respSelf)}`);
        }

        // -------------------------------------------------------------
        // Test 5: Clean Disconnect Handling
        // -------------------------------------------------------------
        console.log("\n--- Test 5: Clean Disconnect Handling ---");
        const disconnected = connectionManager.disconnectDevice(client1Id);
        if (!disconnected) {
            throw new Error("Test 5 Failed: disconnectDevice returned false");
        }

        const remaining = connectionManager.getConnections();
        if (remaining.some((c) => c.deviceId === client1Id)) {
            throw new Error("Test 5 Failed: Client still present in connections after disconnect");
        }
        console.log("✓ Test 5 Passed: Session cleanly destroyed and removed from connections");
        passedTests++;

        console.log("\n==================================================");
        console.log(`   ALL ${passedTests}/5 TESTS PASSED SUCCESSFULLY!`);
        console.log("==================================================");
    } finally {
        server.close();
    }
}

runTests().catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
