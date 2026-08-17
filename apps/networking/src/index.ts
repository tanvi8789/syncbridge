import { DiscoveryService } from "./discovery/discovery";

console.log("====================================");
console.log("     SyncBridge Networking Engine");
console.log("     Version 1.0.0");
console.log("====================================");

console.log("\nStarting networking engine...\n");

const discovery = new DiscoveryService();

discovery.start();

process.on("SIGINT", () => {
    console.log("\nShutting down SyncBridge...");
    discovery.stop();
});