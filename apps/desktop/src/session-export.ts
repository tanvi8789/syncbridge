/*
 * Turns a session export into something a person can read, keep, or
 * paste into a report: raw JSON, a Markdown write-up, or a Mermaid
 * sequence diagram of the actual messages that crossed the wire.
 */

import type { SessionExport, TimelineEntry } from "./api";

function timeOf(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString();
}

function durationOf(ms: number | undefined): string {
    if (ms === undefined) {
        return "—";
    }

    if (ms < 1000) {
        return `${ms} ms`;
    }

    return `${(ms / 1000).toFixed(1)} s`;
}

function eventType(entry: TimelineEntry): string {
    return (entry.event as { type?: string }).type ?? "UNKNOWN";
}

export function toJson(data: SessionExport): string {
    return JSON.stringify(data, null, 2);
}

export function toMarkdown(
    data: SessionExport,
    peerLabel: string
): string {
    const lines: string[] = [];

    lines.push(`# SyncBridge session — ${peerLabel}`);
    lines.push("");
    lines.push(`- **Session ID:** \`${data.session.sessionId}\``);
    lines.push(
        `- **Local device:** ${data.device.deviceName} (${data.device.platform})`
    );
    lines.push(`- **Peer device ID:** \`${data.session.peerDeviceId}\``);
    lines.push(`- **Status:** ${data.session.status}`);
    lines.push(
        `- **Started:** ${new Date(data.session.startedAt).toLocaleString()}`
    );
    lines.push(
        `- **Ended:** ${
            data.session.endedAt
                ? new Date(data.session.endedAt).toLocaleString()
                : "still open"
        }`
    );
    lines.push(`- **Captured span:** ${durationOf(data.stats.spanMs)}`);
    lines.push(`- **Exported:** ${new Date(data.exportedAt).toLocaleString()}`);
    lines.push("");

    lines.push("## Event counts");
    lines.push("");
    lines.push("| Stage | Events |");
    lines.push("| --- | --- |");

    for (const [stage, count] of Object.entries(data.stats.eventsByStage)) {
        lines.push(`| ${stage} | ${count} |`);
    }

    lines.push(`| **Total** | **${data.stats.totalEvents}** |`);
    lines.push("");

    lines.push("## Message types");
    lines.push("");
    lines.push("| Type | Count |");
    lines.push("| --- | --- |");

    const sortedTypes = Object.entries(data.stats.eventsByType).sort(
        (a, b) => b[1] - a[1]
    );

    for (const [type, count] of sortedTypes) {
        lines.push(`| \`${type}\` | ${count} |`);
    }

    lines.push("");

    lines.push("## Timeline");
    lines.push("");
    lines.push("| Time | Stage | Source | Event |");
    lines.push("| --- | --- | --- | --- |");

    for (const entry of data.timeline) {
        lines.push(
            `| ${timeOf(entry.timestamp)} | ${entry.stage} | ${
                entry.source
            } | \`${eventType(entry)}\` |`
        );
    }

    lines.push("");

    return lines.join("\n");
}

/*
 * Events that describe something leaving this device versus arriving
 * at it. Anything not listed is drawn as a note on the local device,
 * since it is internal state rather than a message on the wire.
 */
const OUTBOUND = new Set([
    "DISCOVER_SENT",
    "DISCOVER_RESPONSE_SENT",
    "CONNECT_REQUEST_SENT",
    "CHUNK_SENT",
    "FILE_QUEUED",
]);

const INBOUND = new Set([
    "DISCOVER_RECEIVED",
    "CONNECT_REQUEST_RECEIVED",
    "CONNECT_ACCEPTED",
    "CONNECT_REJECTED",
    "CHUNK_ACKED",
    "TRANSFER_REQUESTED",
]);

export function toMermaid(
    data: SessionExport,
    peerLabel: string
): string {
    const local = data.device.deviceName || "This device";
    const peer = peerLabel || data.session.peerDeviceId.slice(0, 8);

    const safe = (value: string) => value.replace(/[^\w .-]/g, "");

    const localId = "Local";
    const peerId = "Peer";

    const lines: string[] = [];

    lines.push("sequenceDiagram");
    lines.push(`    autonumber`);
    lines.push(`    participant ${localId} as ${safe(local)}`);
    lines.push(`    participant ${peerId} as ${safe(peer)}`);
    lines.push("");

    let currentStage = "";

    for (const entry of data.timeline) {
        if (entry.stage !== currentStage) {
            currentStage = entry.stage;
            lines.push(`    Note over ${localId},${peerId}: ${currentStage}`);
        }

        const type = eventType(entry);

        if (OUTBOUND.has(type)) {
            lines.push(`    ${localId}->>${peerId}: ${type}`);
        } else if (INBOUND.has(type)) {
            lines.push(`    ${peerId}-->>${localId}: ${type}`);
        } else {
            lines.push(`    Note right of ${localId}: ${type}`);
        }
    }

    return lines.join("\n");
}

export function downloadText(
    fileName: string,
    contents: string,
    mimeType: string
): void {
    const blob = new Blob([contents], {
        type: `${mimeType};charset=utf-8`,
    });

    const url = URL.createObjectURL(blob);

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(url);
}
