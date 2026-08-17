export function encodeMessage(message: object): Buffer {
    const payload = Buffer.from(
        JSON.stringify(message),
        "utf-8"
    );

    const header = Buffer.alloc(4);

    header.writeUInt32BE(payload.length, 0);

    return Buffer.concat([
        header,
        payload,
    ]);
}

export class MessageFramer {
    private buffer = Buffer.alloc(0);

    addData(data: Buffer): object[] {
        this.buffer = Buffer.concat([
            this.buffer,
            data,
        ]);

        const messages: object[] = [];

        while (this.buffer.length >= 4) {
            const payloadLength =
                this.buffer.readUInt32BE(0);

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
                console.error(
                    "[FRAMING] Invalid JSON payload"
                );
            }
        }

        return messages;
    }
}