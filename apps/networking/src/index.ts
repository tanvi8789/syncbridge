import { NetworkingEngine } from "./networking-engine";

console.log("====================================");
console.log("     SyncBridge Networking Engine");
console.log("     Version 1.0.0");
console.log("====================================");

console.log("Starting networking engine...");
console.log("");

const networking =
    new NetworkingEngine();

console.log(
    `[DEVICE] Device ID: ${networking.deviceIdentity.deviceId}`
);

async function start(): Promise<void> {
    try {
        await networking.start();
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
    console.log(
        "Shutting down SyncBridge..."
    );

    networking.stop();

    console.log(
        "[SHUTDOWN] Networking engine stopped"
    );
}

process.on(
    "SIGINT",
    shutdown
);

process.on(
    "SIGTERM",
    shutdown
);

start();