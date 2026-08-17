import net from "node:net";

const TCP_PORT = 41236;
const TCP_HOST = "0.0.0.0";

export class TcpServer {
    private server: net.Server;

    constructor(
        private readonly onConnection: (
            socket: net.Socket
        ) => void
    ) {
        this.server = net.createServer(
            (socket) => {
                console.log(
                    `[TCP] Incoming connection from ${socket.remoteAddress}:${socket.remotePort}`
                );

                this.onConnection(socket);
            }
        );

        this.server.on("error", (error) => {
            console.error(
                "[TCP] Server error:",
                error
            );
        });
    }

    start(): void {
        this.server.listen(
            TCP_PORT,
            TCP_HOST,
            () => {
                console.log(
                    `[TCP] Server listening on ${TCP_HOST}:${TCP_PORT}`
                );
            }
        );
    }

    stop(): void {
        this.server.close(() => {
            console.log("[TCP] Server stopped");
        });
    }
}