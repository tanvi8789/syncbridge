import dgram from "node:dgram";

const DISCOVERY_PORT = 41234;
const BROADCAST_ADDRESS = "192.168.111.255";

export type MessageHandler = (
    message: Buffer,
    remote: dgram.RemoteInfo
) => void;

export class DiscoverySocket {
    private socket: dgram.Socket;

    constructor(private onMessage: MessageHandler) {
        this.socket = dgram.createSocket("udp4");

        this.socket.on("error", (error) => {
            console.error("[UDP] Socket error:", error);
        });

        this.socket.on("listening", () => {
            const address = this.socket.address();

            console.log(
                `[UDP] Discovery socket listening on ${address.address}:${address.port}`
            );

            this.socket.setBroadcast(true);

            console.log("[UDP] Broadcast enabled");
        });

        this.socket.on("message", (message, remote) => {
            this.onMessage(message, remote);
        });
    }

    start(): void {
        this.socket.bind(DISCOVERY_PORT);
    }

    sendBroadcast(message: Buffer): void {
        this.socket.send(
            message,
            0,
            message.length,
            DISCOVERY_PORT,
            BROADCAST_ADDRESS,
            (error) => {
                if (error) {
                    console.error("[UDP] Broadcast failed:", error);
                    return;
                }

                console.log("[UDP] Broadcast sent");
            }
        );
    }

    send(message: Buffer, address: string, port: number): void {
        this.socket.send(
            message,
            0,
            message.length,
            port,
            address,
            (error) => {
                if (error) {
                    console.error("[UDP] Send failed:", error);
                    return;
                }

                console.log(
                    `[UDP] Response sent to ${address}:${port}`
                );
            }
        );
    }

    stop(): void {
        console.log("[UDP] Closing discovery socket...");
        this.socket.close();
    }
}