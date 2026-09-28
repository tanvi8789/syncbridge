import http from "node:http";

import {
    NetworkingEngine,
} from "networking";
import type { ProtocolEvent, TransferEvent, SyncEvent } from "networking";

const API_HOST = "127.0.0.1";
const API_PORT = 41235;
const ALLOWED_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);

const networking =
    new NetworkingEngine();

async function readBody(
    request: http.IncomingMessage
): Promise<string> {
    const chunks: Buffer[] = [];

    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 1_048_576) throw new Error("Request body exceeds 1 MiB");
        chunks.push(
            Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk)
        );
    }

    return Buffer.concat(chunks).toString("utf8");
}

async function start(): Promise<void> {
    try {
        await networking.start();

        console.log(
            "[API] Networking engine started"
        );

        const server =
            http.createServer(
                async (request, response) => {
                    response.setHeader(
                        "Content-Type",
                        "application/json"
                    );

                    const origin = request.headers.origin;
                    if (origin && ALLOWED_ORIGINS.has(origin)) {
                        response.setHeader(
                            "Access-Control-Allow-Origin",
                            origin
                        );
                    }

                    response.setHeader(
                        "Access-Control-Allow-Methods",
                        "GET,POST,PUT,DELETE,OPTIONS"
                    );

                    response.setHeader(
                        "Access-Control-Allow-Headers",
                        "Content-Type, Authorization"
                    );

                    // -------------------------
                    // CORS preflight
                    // -------------------------

                    if (
                        request.method === "OPTIONS"
                    ) {
                        response.writeHead(204);
                        response.end();
                        return;
                    }

                    // -------------------------
                    // Health
                    // -------------------------

                    if (
                        request.method === "GET" &&
                        request.url === "/health"
                    ) {
                        response.writeHead(200);

                        response.end(
                            JSON.stringify({
                                status: "ok",
                                service:
                                    "syncbridge-api",
                            })
                        );

                        return;
                    }

                    // -------------------------
                    // My device
                    // -------------------------

                    if (
                        request.method === "GET" &&
                        request.url === "/api/device"
                    ) {
                        response.writeHead(200);

                        response.end(
                            JSON.stringify(
                                networking.getDeviceInfo()
                            )
                        );

                        return;
                    }

                    // -------------------------
                    // Live networking events
                    // -------------------------

                    if (
                        request.method === "GET" &&
                        request.url === "/api/events"
                    ) {
                        response.writeHead(200, {
                            "Content-Type": "text/event-stream",
                            "Cache-Control": "no-cache, no-transform",
                            Connection: "keep-alive",
                        });

                        response.write("retry: 3000\n\n");

                        const sendEvent = (event: ProtocolEvent) => {
                            response.write(
                                `event: protocol-event\ndata: ${JSON.stringify(event)}\n\n`
                            );
                        };

                        const sendTransferEvent = (event: TransferEvent) => {
                            response.write(
                                `event: transfer-event\ndata: ${JSON.stringify(event)}\n\n`
                            );
                        };

                        const sendSyncEvent = (event: SyncEvent) => {
                            response.write(
                                `event: sync-event\ndata: ${JSON.stringify(event)}\n\n`
                            );
                        };

                        networking.on("protocol-event", sendEvent);
                        networking.on("transfer-event", sendTransferEvent);
                        networking.on("sync-event", sendSyncEvent);
                        request.on("close", () => {
                            networking.off("protocol-event", sendEvent);
                            networking.off("transfer-event", sendTransferEvent);
                            networking.off("sync-event", sendSyncEvent);
                        });

                        return;
                    }

                    // -------------------------
                    // Discovered devices
                    // -------------------------

                    if (
                        request.method === "GET" &&
                        request.url === "/api/devices"
                    ) {
                        response.writeHead(200);

                        response.end(
                            JSON.stringify(
                                networking
                                    .getDiscoveredDevices()
                            )
                        );

                        return;
                    }

                    // -------------------------
                    // Connections
                    // -------------------------

                    if (
                        request.method === "GET" &&
                        request.url === "/api/connections"
                    ) {
                        response.writeHead(200);

                        response.end(
                            JSON.stringify(
                                networking
                                    .getConnections()
                            )
                        );

                        return;
                    }

                    // -------------------------
                    // Connect to device
                    // -------------------------

                    if (
                        request.method === "POST" &&
                        request.url === "/api/connections"
                    ) {
                        try {
                            const body =
                                await readBody(request);

                            const parsed =
                                JSON.parse(body);

                            if (
                                typeof parsed.deviceId !==
                                "string"
                            ) {
                                response.writeHead(400);

                                response.end(
                                    JSON.stringify({
                                        error:
                                            "deviceId is required",
                                    })
                                );

                                return;
                            }

                            const devices =
                                networking
                                    .getDiscoveredDevices();

                            const device =
                                devices.find(
                                    (item) =>
                                        item.deviceId ===
                                        parsed.deviceId
                                );

                            if (!device) {
                                response.writeHead(404);

                                response.end(
                                    JSON.stringify({
                                        error:
                                            "Device not found",
                                    })
                                );

                                return;
                            }

                            await networking
                                .connectionManager
                                .connectToDevice(
                                    device
                                );

                            response.writeHead(200);

                            response.end(
                                JSON.stringify({
                                    status:
                                        "connecting",
                                    deviceId:
                                        device.deviceId,
                                })
                            );
                        } catch (error) {
                            console.error(
                                "[API] Connection request failed:",
                                error
                            );

                            response.writeHead(500);

                            response.end(
                                JSON.stringify({
                                    error:
                                        error instanceof Error
                                            ? error.message
                                            : "Failed to connect to device",
                                })
                            );
                        }

                        return;
                    }

                    // -------------------------
                    // Disconnect device
                    // -------------------------

                    if (
                        (request.method === "DELETE" &&
                            request.url?.startsWith("/api/connections")) ||
                        (request.method === "POST" &&
                            request.url === "/api/connections/disconnect")
                    ) {
                        try {
                            let targetDeviceId: string | null = null;
                            const urlObj = new URL(
                                request.url,
                                `http://${request.headers.host || "127.0.0.1"}`
                            );
                            targetDeviceId =
                                urlObj.searchParams.get("deviceId");

                            if (!targetDeviceId) {
                                const body =
                                    await readBody(request);
                                if (body) {
                                    try {
                                        const parsed =
                                            JSON.parse(body);
                                        if (
                                            typeof parsed.deviceId ===
                                            "string"
                                        ) {
                                            targetDeviceId =
                                                parsed.deviceId;
                                        }
                                    } catch {
                                        // Ignore JSON parse error if body is not JSON
                                    }
                                }
                            }

                            if (!targetDeviceId) {
                                response.writeHead(400);
                                response.end(
                                    JSON.stringify({
                                        error:
                                            "deviceId is required",
                                    })
                                );
                                return;
                            }

                            const disconnected =
                                networking.disconnectDevice(
                                    targetDeviceId
                                );

                            response.writeHead(200);
                            response.end(
                                JSON.stringify({
                                    status: disconnected
                                        ? "disconnected"
                                        : "not_found",
                                    deviceId:
                                        targetDeviceId,
                                })
                            );
                        } catch (error) {
                            console.error(
                                "[API] Disconnect failed:",
                                error
                            );

                            response.writeHead(500);
                            response.end(
                                JSON.stringify({
                                    error:
                                        error instanceof Error
                                            ? error.message
                                            : "Failed to disconnect",
                                })
                            );
                        }

                        return;
                    }

                    // -------------------------
                    // Transfers
                    // -------------------------

                    if (
                        request.method === "GET" &&
                        request.url === "/api/transfers"
                    ) {
                        response.writeHead(200);

                        response.end(
                            JSON.stringify(
                                networking
                                    .getTransfers()
                            )
                        );

                        return;
                    }

                    // -------------------------
                    // Start file transfer
                    // -------------------------

                    if (
                        request.method === "POST" &&
                        request.url === "/api/transfers"
                    ) {
                        try {
                            const body =
                                await readBody(request);

                            const parsed =
                                JSON.parse(body);

                            if (
                                typeof parsed.deviceId !==
                                "string" ||
                                typeof parsed.filePath !==
                                "string"
                            ) {
                                response.writeHead(400);

                                response.end(
                                    JSON.stringify({
                                        error:
                                            "deviceId and filePath are required",
                                    })
                                );

                                return;
                            }

                            const transferId =
                                networking
                                    .requestFileTransfer(
                                        parsed.deviceId,
                                        parsed.filePath
                                    );

                            if (!transferId) {
                                response.writeHead(400);

                                response.end(
                                    JSON.stringify({
                                        error:
                                            "Failed to start transfer: file not found or not a file",
                                    })
                                );

                                return;
                            }

                            response.writeHead(201);

                            response.end(
                                JSON.stringify({
                                    transferId,
                                })
                            );
                        } catch (error) {
                            console.error(
                                "[API] File transfer request failed:",
                                error
                            );

                            response.writeHead(400);

                            response.end(
                                JSON.stringify({
                                    error:
                                        error instanceof Error
                                            ? error.message
                                            : "Failed to start transfer",
                                })
                            );
                        }

                        return;
                    }

                    // -------------------------
                    // Sync pairs
                    // -------------------------

                    if (
                        request.method === "GET" &&
                        request.url === "/api/sync-pairs"
                    ) {
                        response.writeHead(200);

                        response.end(
                            JSON.stringify(
                                networking.getSyncPairs()
                            )
                        );

                        return;
                    }

                    if (
                        request.method === "POST" &&
                        request.url === "/api/sync-pairs"
                    ) {
                        try {
                            const body =
                                await readBody(request);

                            const parsed =
                                JSON.parse(body);

                            if (
                                typeof parsed.peerDeviceId !== "string" ||
                                typeof parsed.localFolder !== "string" ||
                                typeof parsed.name !== "string"
                            ) {
                                response.writeHead(400);

                                response.end(
                                    JSON.stringify({
                                        error:
                                            "peerDeviceId, localFolder, and name are required",
                                    })
                                );

                                return;
                            }

                            const pair = networking.createSyncPair(
                                parsed.peerDeviceId,
                                parsed.localFolder,
                                parsed.name
                            );

                            response.writeHead(201);

                            response.end(
                                JSON.stringify(pair)
                            );
                        } catch (error) {
                            console.error(
                                "[API] Failed to create sync pair:",
                                error
                            );

                            response.writeHead(400);

                            response.end(
                                JSON.stringify({
                                    error:
                                        error instanceof Error
                                            ? error.message
                                            : "Failed to create sync pair",
                                })
                            );
                        }

                        return;
                    }

                    const syncPairActionMatch =
                        request.method === "POST" && request.url
                            ? request.url.match(
                                  /^\/api\/sync-pairs\/([^/]+)\/sync-now$/
                              )
                            : null;

                    if (syncPairActionMatch) {
                        const [, pairId] = syncPairActionMatch;

                        try {
                            networking.syncNow(pairId);

                            response.writeHead(200);

                            response.end(
                                JSON.stringify({
                                    status: "syncing",
                                    pairId,
                                })
                            );
                        } catch (error) {
                            response.writeHead(400);

                            response.end(
                                JSON.stringify({
                                    error:
                                        error instanceof Error
                                            ? error.message
                                            : "Failed to sync",
                                })
                            );
                        }

                        return;
                    }

                    const removeSyncPairMatch =
                        request.method === "DELETE" && request.url
                            ? request.url.match(
                                  /^\/api\/sync-pairs\/([^/]+)$/
                              )
                            : null;

                    if (removeSyncPairMatch) {
                        const [, pairId] = removeSyncPairMatch;

                        try {
                            networking.removeSyncPair(pairId);

                            response.writeHead(200);

                            response.end(
                                JSON.stringify({
                                    status: "removed",
                                    pairId,
                                })
                            );
                        } catch (error) {
                            response.writeHead(400);

                            response.end(
                                JSON.stringify({
                                    error:
                                        error instanceof Error
                                            ? error.message
                                            : "Failed to remove sync pair",
                                })
                            );
                        }

                        return;
                    }

                    // -------------------------
                    // Protocol timeline / sessions
                    // -------------------------

                    if (
                        request.method === "GET" &&
                        request.url === "/api/sessions"
                    ) {
                        response.writeHead(200);

                        response.end(
                            JSON.stringify(
                                networking.getSessions()
                            )
                        );

                        return;
                    }

                    const sessionTimelineMatch =
                        request.method === "GET" && request.url
                            ? request.url.match(
                                  /^\/api\/sessions\/([^/]+)\/timeline$/
                              )
                            : null;

                    if (sessionTimelineMatch) {
                        const [, sessionId] = sessionTimelineMatch;

                        response.writeHead(200);

                        response.end(
                            JSON.stringify(
                                networking.getSessionTimeline(sessionId)
                            )
                        );

                        return;
                    }

                    // -------------------------
                    // Pause / resume / cancel a transfer
                    // -------------------------

                    const transferActionMatch =
                        request.method === "POST" && request.url
                            ? request.url.match(
                                  /^\/api\/transfers\/([^/]+)\/(pause|resume|cancel)$/
                              )
                            : null;

                    if (transferActionMatch) {
                        const [, transferId, action] = transferActionMatch;

                        try {
                            if (action === "pause") {
                                networking.pauseTransfer(transferId);
                            } else if (action === "resume") {
                                networking.resumeTransfer(transferId);
                            } else {
                                networking.cancelTransfer(transferId);
                            }

                            response.writeHead(200);

                            response.end(
                                JSON.stringify({
                                    status: action,
                                    transferId,
                                })
                            );
                        } catch (error) {
                            console.error(
                                `[API] Transfer ${action} failed:`,
                                error
                            );

                            response.writeHead(400);

                            response.end(
                                JSON.stringify({
                                    error:
                                        error instanceof Error
                                            ? error.message
                                            : `Failed to ${action} transfer`,
                                })
                            );
                        }

                        return;
                    }

                    // -------------------------
                    // 404
                    // -------------------------

                    response.writeHead(404);

                    response.end(
                        JSON.stringify({
                            error: "Not found",
                        })
                    );
                }
            );

        // -------------------------
        // Start API server
        // -------------------------

        server.listen(
            API_PORT,
            API_HOST,
            () => {
                console.log(
                    `[API] Server listening on ${API_HOST}:${API_PORT}`
                );
            }
        );

        // -------------------------
        // Graceful shutdown
        // -------------------------

        let shuttingDown = false;

        function shutdown(): void {
            if (shuttingDown) {
                return;
            }

            shuttingDown = true;

            console.log(
                "[API] Shutting down..."
            );

            networking.stop();

            server.close(() => {
                console.log(
                    "[API] Server stopped"
                );
            });
        }

        process.on(
            "SIGINT",
            shutdown
        );

        process.on(
            "SIGTERM",
            shutdown
        );
    } catch (error) {
        console.error(
            "[API] Failed to start:",
            error
        );

        process.exit(1);
    }
}

start();
