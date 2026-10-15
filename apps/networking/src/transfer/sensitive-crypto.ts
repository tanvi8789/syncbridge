import fs from "node:fs";
import path from "node:path";
import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
    scryptSync,
} from "node:crypto";

/*
 * Sensitive files are encrypted on the sender before a single byte
 * is chunked, so the bytes on the wire and the file saved on the
 * receiver are ciphertext. The key comes from a PIN the two people
 * share themselves (the app never transmits it).
 *
 *   file  = "SBENC1" | salt(16) | iv(12) | AES-256-GCM ciphertext | tag(16)
 *   plain = nameLength(u16 BE) | name (UTF-8) | file bytes
 *
 * The original file name travels inside the ciphertext, so it is
 * hidden too. GCM authentication means a wrong PIN (or any
 * tampering) fails cleanly instead of producing garbage.
 */

export const SENSITIVE_EXTENSION = ".sbenc";
export const SENSITIVE_MIN_PIN_LENGTH = 6;

const MAGIC = Buffer.from("SBENC1");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;
const IO_CHUNK = 1024 * 1024;

export class WrongPinError extends Error {
    constructor() {
        super("Incorrect PIN, or the file was modified in transit");
        this.name = "WrongPinError";
    }
}

export function validateSensitivePin(pin: unknown): asserts pin is string {
    if (
        typeof pin !== "string" ||
        pin.length < SENSITIVE_MIN_PIN_LENGTH ||
        pin.length > 128
    ) {
        throw new Error(
            `A sensitive file needs a PIN of at least ${SENSITIVE_MIN_PIN_LENGTH} characters`
        );
    }
}

function deriveKey(pin: string, salt: Buffer): Buffer {
    return scryptSync(pin, salt, 32, {
        N: 1 << 15,
        r: 8,
        p: 1,
        maxmem: 128 * 1024 * 1024,
    });
}

/** Encrypt `sourcePath` into `destPath`. */
export function encryptFileWithPin(
    sourcePath: string,
    destPath: string,
    pin: string
): void {
    validateSensitivePin(pin);

    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", deriveKey(pin, salt), iv);

    const name = Buffer.from(path.basename(sourcePath), "utf8");

    if (name.length > 0xffff) {
        throw new Error("File name is too long");
    }

    const nameHeader = Buffer.alloc(2);
    nameHeader.writeUInt16BE(name.length);

    const input = fs.openSync(sourcePath, "r");
    const output = fs.openSync(destPath, "w", 0o600);

    try {
        fs.writeSync(output, MAGIC);
        fs.writeSync(output, salt);
        fs.writeSync(output, iv);
        fs.writeSync(
            output,
            cipher.update(Buffer.concat([nameHeader, name]))
        );

        const buffer = Buffer.alloc(IO_CHUNK);
        let bytesRead: number;

        while ((bytesRead = fs.readSync(input, buffer, 0, IO_CHUNK, null)) > 0) {
            fs.writeSync(output, cipher.update(buffer.subarray(0, bytesRead)));
        }

        fs.writeSync(output, cipher.final());
        fs.writeSync(output, cipher.getAuthTag());
    } finally {
        fs.closeSync(input);
        fs.closeSync(output);
    }
}

/**
 * Decrypt an `.sbenc` file into `destDirectory`, under its original
 * name (made unique if something with that name already exists).
 * Throws WrongPinError if the PIN is wrong; nothing is left behind.
 */
export function decryptFileWithPin(
    encryptedPath: string,
    destDirectory: string,
    pin: string
): string {
    const input = fs.openSync(encryptedPath, "r");
    const partPath = path.join(
        destDirectory,
        `.${path.basename(encryptedPath)}.${randomBytes(4).toString("hex")}.part`
    );
    let output: number | undefined;

    try {
        const size = fs.fstatSync(input).size;

        if (size < HEADER_BYTES + TAG_BYTES) {
            throw new Error("Not a SyncBridge sensitive file");
        }

        const header = Buffer.alloc(HEADER_BYTES);
        fs.readSync(input, header, 0, HEADER_BYTES, 0);

        if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
            throw new Error("Not a SyncBridge sensitive file");
        }

        const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
        const iv = header.subarray(MAGIC.length + SALT_BYTES);

        const tag = Buffer.alloc(TAG_BYTES);
        fs.readSync(input, tag, 0, TAG_BYTES, size - TAG_BYTES);

        const decipher = createDecipheriv(
            "aes-256-gcm",
            deriveKey(pin, salt),
            iv
        );
        decipher.setAuthTag(tag);

        fs.mkdirSync(destDirectory, { recursive: true });
        output = fs.openSync(partPath, "w", 0o600);

        /*
         * The first plaintext bytes are the name header; collect them
         * until the full name is known, then everything after it is
         * file content.
         */
        let head = Buffer.alloc(0);
        let name: string | undefined;

        const consume = (plain: Buffer) => {
            if (name !== undefined) {
                fs.writeSync(output!, plain);
                return;
            }

            head = Buffer.concat([head, plain]);

            if (head.length < 2) {
                return;
            }

            const nameLength = head.readUInt16BE(0);

            if (head.length < 2 + nameLength) {
                return;
            }

            name = head.subarray(2, 2 + nameLength).toString("utf8");
            fs.writeSync(output!, head.subarray(2 + nameLength));
        };

        let position = HEADER_BYTES;
        const end = size - TAG_BYTES;
        const buffer = Buffer.alloc(IO_CHUNK);

        while (position < end) {
            const want = Math.min(IO_CHUNK, end - position);
            const got = fs.readSync(input, buffer, 0, want, position);

            if (got === 0) {
                break;
            }

            consume(decipher.update(buffer.subarray(0, got)));
            position += got;
        }

        try {
            consume(decipher.final());
        } catch {
            throw new WrongPinError();
        }

        if (name === undefined) {
            throw new Error("Not a SyncBridge sensitive file");
        }

        fs.closeSync(output);
        output = undefined;

        const finalPath = uniquePath(destDirectory, safeName(name));
        fs.renameSync(partPath, finalPath);

        return finalPath;
    } catch (error) {
        if (output !== undefined) {
            fs.closeSync(output);
            output = undefined;
        }

        fs.rmSync(partPath, { force: true });
        throw error;
    } finally {
        fs.closeSync(input);

        if (output !== undefined) {
            fs.closeSync(output);
        }
    }
}

function safeName(name: string): string {
    const base = path.basename(name.replace(/\\/g, "/"));

    return base && base !== "." && base !== ".." ? base : "received-file";
}

function uniquePath(directory: string, fileName: string): string {
    const parsed = path.parse(fileName);
    let candidate = path.join(directory, fileName);

    for (let n = 1; fs.existsSync(candidate); n++) {
        candidate = path.join(directory, `${parsed.name} (${n})${parsed.ext}`);
    }

    return candidate;
}
