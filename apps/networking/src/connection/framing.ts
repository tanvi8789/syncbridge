export const FRAME_HEADER_BYTES = 4;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeMessage(message: object): Buffer {
    const payload = Buffer.from(
        JSON.stringify(message),
        "utf-8"
    );

    if (payload.length > MAX_FRAME_BYTES) {
        throw new Error("Message exceeds the maximum frame size");
    }

    const header = Buffer.alloc(FRAME_HEADER_BYTES);

    header.writeUInt32BE(payload.length, 0);

    return Buffer.concat([
        header,
        payload,
    ]);
}

export class MessageFramer {
    private buffer = Buffer.alloc(0);

    constructor(
        private readonly onMalformed?: (detail: string) => void
    ) {}

    addData(data: Buffer): object[] {
        this.buffer = Buffer.concat([
            this.buffer,
            data,
        ]);

        const messages: object[] = [];

        while (this.buffer.length >= FRAME_HEADER_BYTES) {
            const payloadLength =
                this.buffer.readUInt32BE(0);

            if (payloadLength > MAX_FRAME_BYTES) {
                this.buffer = Buffer.alloc(0);
                const detail = "Frame exceeds the maximum size";
                console.error(`[FRAMING] ${detail}`);
                this.onMalformed?.(detail);
                return messages;
            }

            // Wait until the complete payload arrives
            if (
                this.buffer.length <
                4 + payloadLength
            ) {
                break;
            }

            const payload = this.buffer.subarray(
                4,
                4 + payloadLength
            );

            this.buffer = this.buffer.subarray(
                4 + payloadLength
            );

            try {
                const message = JSON.parse(
                    payload.toString("utf-8")
                );

                if (
                    typeof message === "object" &&
                    message !== null
                ) {
                    messages.push(message);
                }
            } catch {
                const detail = "Invalid JSON payload";
                console.error(`[FRAMING] ${detail}`);
                this.onMalformed?.(detail);
            }
        }

        return messages;
    }
}
