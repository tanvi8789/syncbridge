import net from "node:net";
import { createHash, randomUUID } from "node:crypto";

import { encodeMessage } from "../connection/framing";

import {
    ClipboardMessageType,
    type ClipboardUpdate,
} from "./clipboard-messages";

import type {
    ClipboardEvent,
    ClipboardEventListener,
} from "./clipboard-event";

const CLIPBOARD_VERSION = "1.0.0";

/*
 * Clipboard payloads ride the same framed-JSON channel as control
 * messages, so they stay well under the 16 MiB frame cap. 256 KiB is
 * far more text than a person ever copies deliberately, and it keeps
 * a runaway paste from stalling the connection.
 */
export const MAX_CLIPBOARD_BYTES = 256 * 1024;

const PREVIEW_LENGTH = 120;
const MAX_HISTORY = 20;

export interface ClipboardEntry {
    clipboardId: string;

    /** "local" when this device produced it, otherwise the peer's id. */
    origin: string;
    direction: "sent" | "received";

    content: string;
    contentHash: string;
    length: number;

    timestamp: number;
}

export interface PeerSocket {
    deviceId: string;
    socket: net.Socket;
}

function hashContent(content: string): string {
    return createHash("sha256")
        .update(content, "utf8")
        .digest("hex");
}

function previewOf(content: string): string {
    const collapsed = content
        .replace(/\s+/g, " ")
        .trim();

    return collapsed.length > PREVIEW_LENGTH
        ? `${collapsed.slice(0, PREVIEW_LENGTH)}…`
        : collapsed;
}

/**
 * Keeps a shared text clipboard across connected peers.
 *
 * The device that owns the OS clipboard (the Electron main process)
 * watches it and calls `publish`; incoming updates are surfaced as
 * `CLIPBOARD_RECEIVED` events, which the desktop app writes back to
 * its own OS clipboard. `lastHash` is the loop-breaker shared by both
 * directions.
 */
export class ClipboardManager {
    private enabled = true;

    /**
     * The content hash this device last sent OR received. Any publish
     * matching it is an echo of something already in circulation.
     */
    private lastHash?: string;

    private latest?: ClipboardEntry;
    private history: ClipboardEntry[] = [];

    constructor(
        private readonly deviceId: string,
        private readonly getPeerSockets: () => PeerSocket[],
        private readonly onEvent?: ClipboardEventListener,
        private readonly getSessionId?: (
            peerDeviceId: string
        ) => string | undefined
    ) {}

    isEnabled(): boolean {
        return this.enabled;
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;

        console.log(
            `[CLIPBOARD] Sharing ${enabled ? "enabled" : "disabled"}`
        );
    }

    getLatest(): ClipboardEntry | undefined {
        return this.latest;
    }

    getHistory(): ClipboardEntry[] {
        return [...this.history];
    }

    /**
     * Share locally-copied text with every connected peer.
     *
     * Returns how many peers it reached, or -1 when the update was
     * dropped (disabled, too large, or an echo).
     */
    publish(content: string): number {
        if (!this.enabled) {
            return -1;
        }

        if (content.length === 0) {
            return -1;
        }

        const byteLength = Buffer.byteLength(content, "utf8");

        if (byteLength > MAX_CLIPBOARD_BYTES) {
            console.warn(
                `[CLIPBOARD] Ignoring ${byteLength} byte clipboard (max ${MAX_CLIPBOARD_BYTES})`
            );

            this.emit({
                type: "CLIPBOARD_BLOCKED",
                preview: previewOf(content),
                length: byteLength,
                detail: `Clipboard exceeds the ${MAX_CLIPBOARD_BYTES / 1024} KiB limit`,
            });

            return -1;
        }

        const contentHash = hashContent(content);

        /*
         * Either we already sent this, or we just received it and
         * wrote it to the local clipboard. Sending it again would
         * bounce it around the mesh forever.
         */
        if (contentHash === this.lastHash) {
            return -1;
        }

        this.lastHash = contentHash;

        const peers = this.getPeerSockets();

        const entry: ClipboardEntry = {
            clipboardId: randomUUID(),
            origin: "local",
            direction: "sent",
            content,
            contentHash,
            length: byteLength,
            timestamp: Date.now(),
        };

        this.record(entry);

        const message: ClipboardUpdate = {
            type: ClipboardMessageType.CLIPBOARD_UPDATE,
            version: CLIPBOARD_VERSION,
            clipboardId: entry.clipboardId,
            senderDeviceId: this.deviceId,
            format: "text",
            content,
            contentHash,
            timestamp: entry.timestamp,
        };

        for (const peer of peers) {
            this.sendMessage(peer.socket, message);
        }

        console.log(
            `[CLIPBOARD] Shared ${byteLength} bytes with ${peers.length} peer(s)`
        );

        this.emit({
            type: "CLIPBOARD_SENT",
            preview: previewOf(content),
            length: byteLength,
        });

        return peers.length;
    }

    handleMessage(
        _socket: net.Socket,
        message: object,
        peerDeviceId: string
    ): void {
        if (
            !("type" in message) ||
            message.type !== ClipboardMessageType.CLIPBOARD_UPDATE
        ) {
            return;
        }

        const update = message as ClipboardUpdate;

        if (
            typeof update.content !== "string" ||
            typeof update.contentHash !== "string" ||
            update.format !== "text"
        ) {
            console.warn(
                "[CLIPBOARD] Ignoring malformed CLIPBOARD_UPDATE"
            );

            return;
        }

        const byteLength = Buffer.byteLength(update.content, "utf8");

        if (byteLength > MAX_CLIPBOARD_BYTES) {
            console.warn(
                `[CLIPBOARD] Ignoring oversized incoming clipboard (${byteLength} bytes)`
            );

            return;
        }

        if (hashContent(update.content) !== update.contentHash) {
            console.warn(
                "[CLIPBOARD] Ignoring CLIPBOARD_UPDATE with a mismatched hash"
            );

            return;
        }

        if (!this.enabled) {
            this.emit({
                type: "CLIPBOARD_BLOCKED",
                deviceId: peerDeviceId,
                preview: previewOf(update.content),
                length: byteLength,
                detail: "Clipboard sharing is turned off on this device",
            });

            return;
        }

        // Already in circulation — nothing new to surface.
        if (update.contentHash === this.lastHash) {
            return;
        }

        this.lastHash = update.contentHash;

        const entry: ClipboardEntry = {
            clipboardId: update.clipboardId,
            origin: peerDeviceId,
            direction: "received",
            content: update.content,
            contentHash: update.contentHash,
            length: byteLength,
            timestamp: Date.now(),
        };

        this.record(entry);

        console.log(
            `[CLIPBOARD] Received ${byteLength} bytes from ${peerDeviceId}`
        );

        this.emit({
            type: "CLIPBOARD_RECEIVED",
            deviceId: peerDeviceId,
            preview: previewOf(update.content),
            length: byteLength,
            sessionId: this.getSessionId?.(peerDeviceId),
        });
    }

    /**
     * Called when an incoming clipboard has been written to the OS
     * clipboard, so the local watcher doesn't treat it as new.
     */
    acknowledgeLocalWrite(contentHash: string): void {
        this.lastHash = contentHash;
    }

    private record(entry: ClipboardEntry): void {
        this.latest = entry;

        this.history.unshift(entry);

        if (this.history.length > MAX_HISTORY) {
            this.history.length = MAX_HISTORY;
        }
    }

    private emit(
        event: Omit<ClipboardEvent, "id" | "timestamp">
    ): void {
        this.onEvent?.({
            ...event,
            id: randomUUID(),
            timestamp: Date.now(),
        });
    }

    private sendMessage(
        socket: net.Socket,
        message: object
    ): void {
        try {
            socket.write(encodeMessage(message));
        } catch (error) {
            console.error(
                "[CLIPBOARD] Failed to send clipboard update:",
                error
            );
        }
    }
}
