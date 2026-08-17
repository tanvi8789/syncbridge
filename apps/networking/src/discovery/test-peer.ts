import dgram from "node:dgram";
import { randomUUID } from "node:crypto";

const TEST_PORT = 41235;
const DISCOVERY_PORT = 41234;
const DISCOVERY_ADDRESS = "127.0.0.1";

const socket = dgram.createSocket("udp4");

const deviceId = randomUUID();
const deviceName = "Test Peer";

const discoverMessage = {
    type: "DISCOVER",
    version: "1.0.0",
    deviceId,
    timestamp: Date.now(),
};

socket.on("error", (error) => {
    console.error("[TEST PEER] Socket error:", error);
    socket.close();
});

socket.on("message", (message, remote) => {
    console.log(
        `[TEST PEER] Received packet from ${remote.address}:${remote.port}`
    );

    let parsedMessage: unknown;

    try {
        parsedMessage = JSON.parse(message.toString());
    } catch {
        console.log("[TEST PEER] Invalid JSON received");
        return;
    }

    console.log(
        "[TEST PEER] Parsed message:",
        parsedMessage
    );

    if (
        typeof parsedMessage === "object" &&
        parsedMessage !== null &&
        "type" in parsedMessage &&
        parsedMessage.type === "DISCOVER_RESPONSE"
    ) {
        console.log("");
        console.log("====================================");
        console.log("   DISCOVERY RESPONSE RECEIVED");
        console.log("====================================");

        console.log("Device ID:", deviceId);
        console.log("Device Name:", deviceName);
        console.log("IP:", "127.0.0.1");
        console.log("Platform:", "test");

        console.log("====================================");

        // Send our own DISCOVER_RESPONSE back to SyncBridge
        const response = {
            type: "DISCOVER_RESPONSE",
            deviceId,
            deviceName,
            ip: "127.0.0.1",
            platform: "test",
        };

        const responsePayload = Buffer.from(
            JSON.stringify(response)
        );

        socket.send(
            responsePayload,
            DISCOVERY_PORT,
            DISCOVERY_ADDRESS,
            (error) => {
                if (error) {
                    console.error(
                        "[TEST PEER] Failed to send DISCOVER_RESPONSE:",
                        error
                    );
                    return;
                }

                console.log(
                    `[TEST PEER] DISCOVER_RESPONSE sent to ${DISCOVERY_ADDRESS}:${DISCOVERY_PORT}`
                );
            }
        );
    }
});

socket.bind(TEST_PORT, "127.0.0.1", () => {
    console.log("====================================");
    console.log("     SyncBridge Discovery Test Peer");
    console.log("====================================");

    console.log(`[TEST PEER] Device ID: ${deviceId}`);

    console.log(
        `[TEST PEER] Listening on 127.0.0.1:${TEST_PORT}`
    );

    const payload = Buffer.from(
        JSON.stringify(discoverMessage)
    );

    socket.send(
        payload,
        DISCOVERY_PORT,
        DISCOVERY_ADDRESS,
        (error) => {
            if (error) {
                console.error(
                    "[TEST PEER] Failed to send DISCOVER:",
                    error
                );
                return;
            }

            console.log(
                `[TEST PEER] DISCOVER sent to ${DISCOVERY_ADDRESS}:${DISCOVERY_PORT}`
            );
        }
    );
});

process.on("SIGINT", () => {
    console.log("\n[TEST PEER] Shutting down...");
    socket.close();
});