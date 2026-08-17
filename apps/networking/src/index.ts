import { DeviceIdentity } from "./discovery/device-identity";
import { DiscoveryService } from "./discovery/discovery";
import { ConnectionManager } from "./connection/connection-manager";
import { TcpServer } from "./connection/tcp-server";

console.log("====================================");
console.log("     SyncBridge Networking Engine");
console.log("     Version 1.0.0");
console.log("====================================");

console.log("Starting networking engine...");
console.log("");

const deviceIdentity = new DeviceIdentity();

const deviceId = deviceIdentity.deviceId;

console.log(`[DEVICE] Device ID: ${deviceId}`);

const discovery = new DiscoveryService(
    deviceIdentity
);

const connectionManager = new ConnectionManager(
    deviceId
);

const tcpServer = new TcpServer(
    (socket) => {
        connectionManager.handleIncomingConnection(
            socket
        );
    }
);

async function start(): Promise<void> {
    try {
        await discovery.start();

        tcpServer.start();
    } catch (error) {
        console.error(
            "[STARTUP] Failed to start networking engine:",
            error
        );

        process.exit(1);
    }
}

let shuttingDown = false;

function shutdown(): void {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    console.log("");
    console.log("Shutting down SyncBridge...");

    discovery.stop();
    tcpServer.stop();

    console.log("[SHUTDOWN] Networking engine stopped");
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();