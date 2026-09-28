import type { EventEmitter } from "node:events";

import type { ProtocolEvent } from "../protocol-event";
import type { TransferEvent } from "../transfer/transfer-event";
import type { SyncEvent } from "../sync/sync-event";

export type SessionStatus =
    | "connecting"
    | "active"
    | "closed"
    | "rejected"
    | "failed";

export interface SessionSummary {
    sessionId: string;
    peerDeviceId: string;
    peerDeviceName?: string;
    startedAt: number;
    endedAt: number | null;
    status: SessionStatus;
}

export type TimelineStage =
    | "discovery"
    | "connection"
    | "authentication"
    | "metadata"
    | "chunk-transfer"
    | "verification"
    | "completion"
    | "sync";

export interface TimelineEntry {
    stage: TimelineStage;
    source: "protocol" | "transfer" | "sync";
    timestamp: number;
    event: ProtocolEvent | TransferEvent | SyncEvent;
}

export const SESSION_EXPORT_FORMAT_VERSION = "1.0.0";

export interface SessionExportStats {
    totalEvents: number;
    protocolEvents: number;
    transferEvents: number;
    syncEvents: number;

    firstEventAt?: number;
    lastEventAt?: number;
    spanMs?: number;

    eventsByStage: Record<string, number>;
    eventsByType: Record<string, number>;
}

export interface SessionExport {
    formatVersion: string;
    exportedAt: number;

    session: SessionSummary;
    stats: SessionExportStats;
    timeline: TimelineEntry[];
}

interface SessionRecord {
    summary: SessionSummary;
    protocolEvents: ProtocolEvent[];
    transferEvents: TransferEvent[];
    syncEvents: SyncEvent[];
}

interface DiscoverySighting {
    deviceId: string;
    timestamp: number;
    event: ProtocolEvent;
}

const DEFAULT_MAX_SESSIONS = 50;
const DEFAULT_MAX_EVENTS_PER_SESSION = 5000;
const DEFAULT_MAX_DISCOVERY_SIGHTINGS = 500;
const DEFAULT_DISCOVERY_LOOKBACK_MS = 2 * 60 * 1000;

/**
 * A minimal subset of NetworkingEngine's shape (it's a plain
 * EventEmitter emitting these three event names) so this module
 * doesn't need to import the class itself and create a cycle.
 */
type NetworkingEventSource = Pick<EventEmitter, "on">;

/**
 * Correlates the app's three independent event streams
 * (protocol/transfer/sync) into per-session timelines, in memory
 * only, so the desktop UI can list recent sessions and replay one
 * even after the fact — a client that only opens the UI once a
 * session is already over would otherwise see nothing, since the
 * SSE stream itself has no history.
 */
export class SessionStore {
    private sessions = new Map<string, SessionRecord>();
    private sessionOrder: string[] = [];
    private discoverySightings: DiscoverySighting[] = [];

    private readonly maxSessions: number;
    private readonly maxEventsPerSession: number;
    private readonly discoveryLookbackMs: number;

    constructor(
        networkingEngine: NetworkingEventSource,
        opts?: {
            maxSessions?: number;
            maxEventsPerSession?: number;
            discoveryLookbackMs?: number;
        }
    ) {
        this.maxSessions = opts?.maxSessions ?? DEFAULT_MAX_SESSIONS;
        this.maxEventsPerSession =
            opts?.maxEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION;
        this.discoveryLookbackMs =
            opts?.discoveryLookbackMs ?? DEFAULT_DISCOVERY_LOOKBACK_MS;

        networkingEngine.on("protocol-event", (event: ProtocolEvent) =>
            this.handleProtocolEvent(event)
        );
        networkingEngine.on("transfer-event", (event: TransferEvent) =>
            this.handleTransferEvent(event)
        );
        networkingEngine.on("sync-event", (event: SyncEvent) =>
            this.handleSyncEvent(event)
        );
    }

    getSessions(): SessionSummary[] {
        return this.sessionOrder
            .map((id) => this.sessions.get(id)?.summary)
            .filter((summary): summary is SessionSummary => Boolean(summary))
            .reverse();
    }

    getSessionTimeline(sessionId: string): TimelineEntry[] {
        const record = this.sessions.get(sessionId);

        if (!record) {
            return [];
        }

        const entries: TimelineEntry[] = [
            ...record.protocolEvents.map((event) => ({
                stage: stageForProtocolEvent(event),
                source: "protocol" as const,
                timestamp: event.timestamp,
                event,
            })),
            ...record.transferEvents.map((event) => ({
                stage: stageForTransferEvent(event),
                source: "transfer" as const,
                timestamp: event.timestamp,
                event,
            })),
            ...record.syncEvents.map((event) => ({
                stage: "sync" as const,
                source: "sync" as const,
                timestamp: event.timestamp,
                event,
            })),
        ];

        const discoveryEntries: TimelineEntry[] = this.discoverySightings
            .filter(
                (sighting) =>
                    sighting.deviceId === record.summary.peerDeviceId &&
                    sighting.timestamp <= record.summary.startedAt &&
                    sighting.timestamp >=
                        record.summary.startedAt - this.discoveryLookbackMs
            )
            .map((sighting) => ({
                stage: "discovery" as const,
                source: "protocol" as const,
                timestamp: sighting.timestamp,
                event: sighting.event,
            }));

        return [...discoveryEntries, ...entries].sort(
            (a, b) => a.timestamp - b.timestamp
        );
    }

    /**
     * A self-contained record of one session: the summary, the full
     * correlated timeline, and derived statistics.
     *
     * This is what the desktop app downloads as a shareable artefact,
     * so it deliberately carries everything a reader needs without
     * having to query the running engine again.
     */
    getSessionExport(
        sessionId: string
    ): SessionExport | undefined {
        const record = this.sessions.get(sessionId);

        if (!record) {
            return undefined;
        }

        const timeline = this.getSessionTimeline(sessionId);

        const eventsByStage: Record<string, number> = {};
        const eventsByType: Record<string, number> = {};

        for (const entry of timeline) {
            eventsByStage[entry.stage] =
                (eventsByStage[entry.stage] ?? 0) + 1;

            const type = (entry.event as { type?: string }).type;

            if (type) {
                eventsByType[type] = (eventsByType[type] ?? 0) + 1;
            }
        }

        const first = timeline[0]?.timestamp;
        const last = timeline[timeline.length - 1]?.timestamp;

        return {
            formatVersion: SESSION_EXPORT_FORMAT_VERSION,
            exportedAt: Date.now(),
            session: record.summary,
            stats: {
                totalEvents: timeline.length,
                protocolEvents: record.protocolEvents.length,
                transferEvents: record.transferEvents.length,
                syncEvents: record.syncEvents.length,
                firstEventAt: first,
                lastEventAt: last,
                spanMs:
                    first !== undefined && last !== undefined
                        ? last - first
                        : undefined,
                eventsByStage,
                eventsByType,
            },
            timeline,
        };
    }

    private handleProtocolEvent(event: ProtocolEvent): void {
        if (event.layer === "discovery") {
            if (event.deviceId) {
                this.discoverySightings.push({
                    deviceId: event.deviceId,
                    timestamp: event.timestamp,
                    event,
                });

                if (this.discoverySightings.length > DEFAULT_MAX_DISCOVERY_SIGHTINGS) {
                    this.discoverySightings.shift();
                }
            }

            return;
        }

        if (!event.sessionId) {
            // Pre-handshake noise (e.g. a malformed frame before any
            // CONNECT_REQUEST is parsed) isn't attributable to a session.
            return;
        }

        const record = this.getOrCreateSession(event.sessionId, event.deviceId);

        this.pushCapped(record.protocolEvents, event);

        if (event.type === "CONNECT_ACCEPTED") {
            record.summary.status = "active";
        } else if (event.type === "CONNECT_REJECTED") {
            record.summary.status = "rejected";
            record.summary.endedAt = event.timestamp;
        } else if (event.type === "CONNECTION_CLOSED") {
            record.summary.status =
                record.summary.status === "active" ? "closed" : "failed";
            record.summary.endedAt = event.timestamp;
        }
    }

    private handleTransferEvent(event: TransferEvent): void {
        if (!event.sessionId) {
            return;
        }

        const record = this.sessions.get(event.sessionId);

        if (!record) {
            return;
        }

        this.pushCapped(record.transferEvents, event);
    }

    private handleSyncEvent(event: SyncEvent): void {
        if (!event.sessionId) {
            return;
        }

        const record = this.sessions.get(event.sessionId);

        if (!record) {
            return;
        }

        this.pushCapped(record.syncEvents, event);
    }

    private getOrCreateSession(
        sessionId: string,
        peerDeviceId?: string
    ): SessionRecord {
        const existing = this.sessions.get(sessionId);

        if (existing) {
            if (peerDeviceId && !existing.summary.peerDeviceId) {
                existing.summary.peerDeviceId = peerDeviceId;
            }

            return existing;
        }

        const record: SessionRecord = {
            summary: {
                sessionId,
                peerDeviceId: peerDeviceId ?? "",
                startedAt: Date.now(),
                endedAt: null,
                status: "connecting",
            },
            protocolEvents: [],
            transferEvents: [],
            syncEvents: [],
        };

        this.sessions.set(sessionId, record);
        this.sessionOrder.push(sessionId);

        if (this.sessionOrder.length > this.maxSessions) {
            const evicted = this.sessionOrder.shift();
            if (evicted) {
                this.sessions.delete(evicted);
            }
        }

        return record;
    }

    private pushCapped<T>(list: T[], item: T): void {
        list.push(item);

        if (list.length > this.maxEventsPerSession) {
            list.shift();
        }
    }
}

function stageForProtocolEvent(event: ProtocolEvent): TimelineStage {
    if (event.layer === "discovery") {
        return "discovery";
    }

    return "connection";
}

function stageForTransferEvent(event: TransferEvent): TimelineStage {
    switch (event.type) {
        case "TRANSFER_REQUESTED":
            return "metadata";
        case "TRANSFER_VERIFIED":
            return "verification";
        case "TRANSFER_COMPLETED":
            return "completion";
        default:
            return "chunk-transfer";
    }
}
