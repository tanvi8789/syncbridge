import http from "node:http";

import {
    NetworkingEngine,
} from "networking";
import type { ProtocolEvent } from "networking";

const API_HOST = "127.0.0.1";
const API_PORT = 41235;

const networking =
    new NetworkingEngine();

async function readBody(
    request: http.IncomingMessage
): Promise<string> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
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
                    if (origin) {
                        response.setHeader(
                            "Access-Control-Allow-Origin",
                            origin
                        );
                    } else {
                        response.setHeader(
                            "Access-Control-Allow-Origin",
                            "*"
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

                        networking.on("protocol-event", sendEvent);
                        request.on("close", () => {
                            networking.off("protocol-event", sendEvent);
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

                            const transfer =
                                networking
                                    .requestFileTransfer(
                                        parsed.deviceId,
                                        parsed.filePath
                                    );

                            response.writeHead(201);

                            response.end(
                                JSON.stringify(
                                    transfer
                                )
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
