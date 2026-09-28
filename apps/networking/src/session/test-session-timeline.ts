import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { ConnectionManager } from "../connection/connection-manager";
import { TcpServer } from "../connection/tcp-server";
import { SessionStore } from "./session-store";

const TCP_PORT = 41236;

const TEST_FILE = path.resolve(process.cwd(), "test-files", "10mb.bin");

const RECEIVED_FILE = path.join(
    os.homedir(),
    "SyncBridge",
    "Received",
    "10mb.bin"
);

const serverDeviceId = randomUUID();
const clientDeviceId = randomUUID();

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) {
        passed++;
        console.log(`  ✓ ${message}`);
    } else {
        failed++;
        console.error(`  ✗ ${message}`);
    }
}

/**
 * Wires a ConnectionManager up to its own event bus + SessionStore,
 * exactly the way NetworkingEngine does internally — this test uses
 * bare ConnectionManagers (like the existing transfer tests) rather
 * than two full NetworkingEngines, since both would try to bind the
 * same default TCP port in-process.
 */
function createNode(deviceId: string, name: string) {
    const bus = new EventEmitter();

    const connectionManager = new ConnectionManager(
        deviceId,
        name,
        TCP_PORT,
        undefined,
        (event) => bus.emit("protocol-event", event),
        (event) => bus.emit("transfer-event", event),
        (event) => bus.emit("sync-event", event)
    );

    const sessionStore = new SessionStore(bus);

    return { connectionManager, sessionStore };
}

async function main(): Promise<void> {
    console.log("====================================");
    console.log("   SyncBridge Protocol Timeline Test");
    console.log("====================================");

    if (!fs.existsSync(TEST_FILE)) {
        throw new Error(`Missing test file: ${TEST_FILE}`);
    }

    if (fs.existsSync(RECEIVED_FILE)) {
        fs.unlinkSync(RECEIVED_FILE);
    }

    const server = createNode(serverDeviceId, "Test Server");
    const client = createNode(clientDeviceId, "Test Client");

    const tcpServer = new TcpServer((socket) => {
        server.connectionManager.handleIncomingConnection(socket);
    });

    tcpServer.start();
    await delay(500);

    const serverDevice = {
        deviceId: serverDeviceId,
        deviceName: "Test Server",
        ip: "127.0.0.1",
        platform: process.platform,
        lastSeen: Date.now(),
    };

    await client.connectionManager.connectToDevice(serverDevice);
    await waitForConnection(client.connectionManager, serverDeviceId);

    console.log("\n[TEST] Connection established");

    const clientSessions = client.sessionStore.getSessions();
    assert(clientSessions.length === 1, "client recorded exactly one session");
    assert(
        clientSessions[0]?.status === "active",
        `client session status is "active" (was "${clientSessions[0]?.status}")`
    );

    const sessionId = clientSessions[0].sessionId;

    const serverSessions = server.sessionStore.getSessions();
    assert(
        serverSessions.some((s) => s.sessionId === sessionId),
        "server recorded the same sessionId as the client"
    );

    console.log("\n[TEST] Sending file...");
    await client.connectionManager.sendFile(serverDeviceId, TEST_FILE);
    await delay(8000);

    assert(fs.existsSync(RECEIVED_FILE), "receiver wrote the transferred file");

    const clientTimeline = client.sessionStore.getSessionTimeline(sessionId);
    const serverTimeline = server.sessionStore.getSessionTimeline(sessionId);

    console.log(`\n[TEST] Client timeline: ${clientTimeline.length} entries`);
    console.log(`[TEST] Server timeline: ${serverTimeline.length} entries`);

    assertOrdered(clientTimeline, "connection", "CONNECT_ATTEMPT", "metadata", "TRANSFER_REQUESTED");
    assertOrdered(clientTimeline, "metadata", "TRANSFER_REQUESTED", "chunk-transfer", "CHUNK_SENT");
    assertOrdered(clientTimeline, "chunk-transfer", "CHUNK_SENT", "completion", "TRANSFER_COMPLETED");

    assertOrdered(serverTimeline, "connection", "CONNECT_REQUEST_RECEIVED", "metadata", "TRANSFER_REQUESTED");
    assertOrdered(serverTimeline, "metadata", "TRANSFER_REQUESTED", "verification", "TRANSFER_VERIFIED");
    assertOrdered(serverTimeline, "verification", "TRANSFER_VERIFIED", "completion", "TRANSFER_COMPLETED");

    console.log("\n[TEST] Creating sync pair...");

    const syncFolder = fs.mkdtempSync(
        path.join(os.tmpdir(), "sb-session-timeline-")
    );

    const pair = client.connectionManager.createSyncPair(
        serverDeviceId,
        syncFolder,
        "Timeline Test Pair"
    );

    await delay(1000);

    const clientTimelineAfterSync = client.sessionStore.getSessionTimeline(sessionId);
    const serverTimelineAfterSync = server.sessionStore.getSessionTimeline(sessionId);

    assert(
        clientTimelineAfterSync.some((entry) => entry.stage === "sync"),
        "client timeline includes a sync-stage entry after pairing"
    );
    assert(
        serverTimelineAfterSync.some((entry) => entry.stage === "sync"),
        "server timeline includes a sync-stage entry after pairing"
    );

    console.log("\n[TEST] Disconnecting...");
    client.connectionManager.disconnectDevice(serverDeviceId);
    await delay(200);

    const closedSession = client.sessionStore
        .getSessions()
        .find((s) => s.sessionId === sessionId);

    assert(closedSession?.status === "closed", "session status flips to \"closed\" after disconnect");
    assert(closedSession?.endedAt !== null, "closed session has an endedAt timestamp");

    console.log(`\n[TEST] Cleaning up sync pair "${pair.name}"`);
    fs.rmSync(syncFolder, { recursive: true, force: true });

    tcpServer.stop();
    await delay(100);

    console.log("\n====================================");
    console.log(`   ${passed}/${passed + failed} ASSERTIONS PASSED`);
    console.log("====================================");

    process.exit(failed > 0 ? 1 : 0);
}

function assertOrdered(
    timeline: ReturnType<SessionStore["getSessionTimeline"]>,
    stageA: string,
    typeA: string,
    stageB: string,
    typeB: string
): void {
    const indexA = timeline.findIndex(
        (entry) => entry.stage === stageA && (entry.event as { type?: string }).type === typeA
    );
    const indexB = timeline.findIndex(
        (entry) => entry.stage === stageB && (entry.event as { type?: string }).type === typeB
    );

    assert(
        indexA !== -1 && indexB !== -1 && indexA < indexB,
        `"${typeA}" (${stageA}) occurs before "${typeB}" (${stageB})`
    );
}

async function waitForConnection(
    connectionManager: ConnectionManager,
    deviceId: string
): Promise<void> {
    const timeout = Date.now() + 5000;

    while (Date.now() < timeout) {
        if (connectionManager.getConnectedDevices().includes(deviceId)) {
            return;
        }

        await delay(100);
    }

    throw new Error(`Timed out waiting for connection to ${deviceId}`);
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

main().catch((error) => {
    console.error("[TEST] Test failed:", error);
    process.exit(1);
});
