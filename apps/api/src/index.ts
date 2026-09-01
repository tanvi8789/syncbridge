import http from "node:http";

import {
    NetworkingEngine,
} from "networking";

const API_HOST = "127.0.0.1";
const API_PORT = 41235;

const networking =
    new NetworkingEngine();

async function start(): Promise<void> {
    try {
        await networking.start();

        console.log(
            "[API] Networking engine started"
        );

        const server =
            http.createServer(
                (request, response) => {
                    response.setHeader(
                        "Content-Type",
                        "application/json"
                    );

                    response.setHeader(
                        "Access-Control-Allow-Origin",
                        "http://localhost:5173"
                    );

                    response.setHeader(
                        "Access-Control-Allow-Methods",
                        "GET,POST,PUT,DELETE,OPTIONS"
                    );

                    response.setHeader(
                        "Access-Control-Allow-Headers",
                        "Content-Type"
                    );

                    if (
                        request.method === "OPTIONS"
                    ) {
                        response.writeHead(204);
                        response.end();
                        return;
                    }

                    if (
                        request.method === "GET" &&
                        request.url === "/health"
                    ) {
                        response.writeHead(
                            200
                        );

                        response.end(
                            JSON.stringify({
                                status: "ok",
                                service:
                                    "syncbridge-api",
                            })
                        );

                        return;
                    }

                    if (
                        request.method === "GET" &&
                        request.url === "/api/device"
                    ) {
                        response.writeHead(
                            200
                        );

                        response.end(
                            JSON.stringify(
                                networking.getDeviceInfo()
                            )
                        );

                        return;
                    }

                    if (
                        request.method === "GET" &&
                        request.url === "/api/devices"
                    ) {
                        response.writeHead(
                            200
                        );

                        response.end(
                            JSON.stringify(
                                networking
                                    .getDiscoveredDevices()
                            )
                        );

                        return;
                    }

                    if (
                        request.method === "GET" &&
                        request.url === "/api/connections"
                    ) {
                        response.writeHead(
                            200
                        );

                        response.end(
                            JSON.stringify(
                                networking
                                    .getConnections()
                            )
                        );

                        return;
                    }

                    if (
                        request.method === "POST" &&
                        request.url === "/api/connections"
                    ) {
                        let body = "";

                        request.on(
                            "data",
                            (chunk) => {
                                body +=
                                    chunk.toString();
                            }
                        );

                        request.on(
                            "end",
                            async () => {
                                try {
                                    const parsed =
                                        JSON.parse(
                                            body
                                        );

                                    if (
                                        typeof parsed.deviceId !==
                                        "string"
                                    ) {
                                        response.writeHead(
                                            400
                                        );

                                        response.end(
                                            JSON.stringify({
                                                error:
                                                    "deviceId is required",
                                            })
                                        );

                                        return;
                                    }

                                    const devices =
                                        networking.getDiscoveredDevices();

                                    const device =
                                        devices.find(
                                            (item) =>
                                                item.deviceId ===
                                                parsed.deviceId
                                        );

                                    if (!device) {
                                        response.writeHead(
                                            404
                                        );

                                        response.end(
                                            JSON.stringify({
                                                error:
                                                    "Device not found",
                                            })
                                        );

                                        return;
                                    }

                                    await networking.connectionManager.connectToDevice(
                                        device
                                    );

                                    response.writeHead(
                                        200
                                    );

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

                                    response.writeHead(
                                        500
                                    );

                                    response.end(
                                        JSON.stringify({
                                            error:
                                                "Failed to connect to device",
                                        })
                                    );
                                }
                            }
                        );

                        return;
                    }

                    if (
                        request.method === "GET" &&
                        request.url === "/api/transfers"
                    ) {
                        response.writeHead(
                            200
                        );

                        response.end(
                            JSON.stringify(
                                networking
                                    .getTransfers()
                            )
                        );

                        return;
                    }

                    response.writeHead(
                        404
                    );

                    response.end(
                        JSON.stringify({
                            error:
                                "Not found",
                        })
                    );
                }
            );

        server.listen(
            API_PORT,
            API_HOST,
            () => {
                console.log(
                    `[API] Server listening on ${API_HOST}:${API_PORT}`
                );
            }
        );

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