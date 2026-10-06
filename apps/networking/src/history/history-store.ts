import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Transfer } from "../transfer/transfer-state";
import type { SessionSummary } from "../session/session-store";

/*
 * Everything else in SyncBridge is in-memory, which means a restart
 * loses every transfer the app has ever done. This is the one
 * durable store: completed and failed transfers, the sessions they
 * happened over, and the devices involved.
 *
 * node:sqlite is used rather than better-sqlite3 so the project
 * keeps its "Node standard library only" property — no native
 * module, no rebuild step against Electron's ABI.
 */

export const HISTORY_SCHEMA_VERSION = 1;

const DEFAULT_DB_PATH = path.join(
    os.homedir(),
    ".syncbridge",
    "history.db"
);

export interface HistoryTransfer {
    transferId: string;
    direction: "sent" | "received";

    peerDeviceId: string;
    peerDeviceName?: string;

    fileName: string;
    fileSize: number;
    totalChunks: number;

    checksum?: string;
    savedPath?: string;

    syncPairId?: string;
    relativePath?: string;
    sessionId?: string;

    state: string;
    succeeded: boolean;

    startedAt?: number;
    completedAt: number;
    durationMs?: number;

    bytesTransferred: number;
    retryCount: number;

    /** Bytes per second over the transfer's own duration. */
    throughputBps?: number;

    rttAvgMs?: number;
    rttMinMs?: number;
    rttMaxMs?: number;
    rttSamples?: number;
}

export interface HistoryQuery {
    limit?: number;
    offset?: number;
    peerDeviceId?: string;
    direction?: "sent" | "received";
    search?: string;
    since?: number;
}

export interface HistoryPage {
    transfers: HistoryTransfer[];
    total: number;
    limit: number;
    offset: number;
}

export interface AnalyticsPeer {
    peerDeviceId: string;
    peerDeviceName?: string;
    transfers: number;
    bytes: number;
    avgThroughputBps?: number;
}

export interface AnalyticsBucket {
    /** Start of the day, as a local-midnight epoch milliseconds. */
    bucketStart: number;
    transfers: number;
    bytes: number;
    avgThroughputBps?: number;
    avgRttMs?: number;
}

export interface Analytics {
    since?: number;
    generatedAt: number;

    totals: {
        transfers: number;
        succeeded: number;
        failed: number;
        successRate?: number;

        bytes: number;
        bytesSent: number;
        bytesReceived: number;

        totalRetries: number;
        transfersWithRetries: number;
    };

    throughput: {
        avgBps?: number;
        peakBps?: number;
        avgDurationMs?: number;
    };

    latency: {
        avgRttMs?: number;
        minRttMs?: number;
        maxRttMs?: number;
        samples: number;
    };

    largestTransfer?: {
        fileName: string;
        fileSize: number;
        throughputBps?: number;
    };

    byPeer: AnalyticsPeer[];
    byDay: AnalyticsBucket[];

    sessions: {
        total: number;
        avgDurationMs?: number;
    };

    devicesSeen: number;
}

/** Terminal states — a transfer is only worth persisting once it stops moving. */
const TERMINAL_STATES = new Set([
    "COMPLETED",
    "REJECTED",
    "CANCELLED",
]);

export function isTerminalTransferState(state: string): boolean {
    return TERMINAL_STATES.has(state);
}

type Row = Record<string, unknown>;

function num(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
}

function str(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0
        ? value
        : undefined;
}

export class HistoryStore {
    private readonly db: DatabaseSync;

    constructor(dbPath: string = DEFAULT_DB_PATH) {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });

        this.db = new DatabaseSync(dbPath);

        /*
         * WAL lets the API read while a write is in flight, and
         * NORMAL synchronous is the right trade for a cache of
         * history that can be rebuilt by simply using the app.
         */
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA synchronous = NORMAL");

        this.migrate();
    }

    private migrate(): void {
        const [{ user_version: version } = { user_version: 0 }] =
            this.db
                .prepare("PRAGMA user_version")
                .all() as Array<{ user_version: number }>;

        if (version >= HISTORY_SCHEMA_VERSION) {
            return;
        }

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS transfers (
                transfer_id      TEXT PRIMARY KEY,
                direction        TEXT NOT NULL,
                peer_device_id   TEXT NOT NULL,
                peer_device_name TEXT,
                file_name        TEXT NOT NULL,
                file_size        INTEGER NOT NULL,
                total_chunks     INTEGER NOT NULL,
                checksum         TEXT,
                saved_path       TEXT,
                sync_pair_id     TEXT,
                relative_path    TEXT,
                session_id       TEXT,
                state            TEXT NOT NULL,
                succeeded        INTEGER NOT NULL,
                started_at       INTEGER,
                completed_at     INTEGER NOT NULL,
                duration_ms      INTEGER,
                bytes_transferred INTEGER NOT NULL,
                retry_count      INTEGER NOT NULL,
                throughput_bps   REAL,
                rtt_avg_ms       REAL,
                rtt_min_ms       REAL,
                rtt_max_ms       REAL,
                rtt_samples      INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_transfers_completed
                ON transfers (completed_at DESC);
            CREATE INDEX IF NOT EXISTS idx_transfers_peer
                ON transfers (peer_device_id);

            CREATE TABLE IF NOT EXISTS sessions (
                session_id       TEXT PRIMARY KEY,
                peer_device_id   TEXT,
                peer_device_name TEXT,
                started_at       INTEGER NOT NULL,
                ended_at         INTEGER,
                status           TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS devices (
                device_id     TEXT PRIMARY KEY,
                device_name   TEXT,
                platform      TEXT,
                first_seen_at INTEGER NOT NULL,
                last_seen_at  INTEGER NOT NULL
            );
        `);

        this.db.exec(`PRAGMA user_version = ${HISTORY_SCHEMA_VERSION}`);
    }

    /**
     * Persist a transfer that has reached a terminal state.
     *
     * Upsert rather than insert: the engine sweeps its live transfer
     * list rather than relying on catching one specific event, so
     * the same transfer is offered repeatedly and must not duplicate.
     */
    recordTransfer(
        transfer: Transfer,
        peerDeviceName?: string
    ): void {
        if (!isTerminalTransferState(transfer.state)) {
            return;
        }

        const completedAt =
            transfer.lastProgressAt ?? Date.now();

        const durationMs =
            transfer.startedAt !== undefined
                ? Math.max(0, completedAt - transfer.startedAt)
                : undefined;

        /*
         * Throughput is only meaningful for a transfer that both
         * finished and took measurable time; a sub-millisecond
         * duration would otherwise produce an absurd rate.
         */
        const throughputBps =
            transfer.state === "COMPLETED" &&
            durationMs !== undefined &&
            durationMs > 0
                ? (transfer.bytesTransferred / durationMs) * 1000
                : undefined;

        const rttAvgMs =
            transfer.rttSamples && transfer.rttTotalMs !== undefined
                ? transfer.rttTotalMs / transfer.rttSamples
                : undefined;

        this.db
            .prepare(
                `INSERT INTO transfers (
                    transfer_id, direction, peer_device_id, peer_device_name,
                    file_name, file_size, total_chunks, checksum, saved_path,
                    sync_pair_id, relative_path, session_id, state, succeeded,
                    started_at, completed_at, duration_ms, bytes_transferred,
                    retry_count, throughput_bps,
                    rtt_avg_ms, rtt_min_ms, rtt_max_ms, rtt_samples
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
                ON CONFLICT(transfer_id) DO UPDATE SET
                    peer_device_name  = COALESCE(excluded.peer_device_name, peer_device_name),
                    state             = excluded.state,
                    succeeded         = excluded.succeeded,
                    completed_at      = excluded.completed_at,
                    duration_ms       = excluded.duration_ms,
                    bytes_transferred = excluded.bytes_transferred,
                    retry_count       = excluded.retry_count,
                    throughput_bps    = excluded.throughput_bps,
                    checksum          = COALESCE(excluded.checksum, checksum),
                    saved_path        = COALESCE(excluded.saved_path, saved_path),
                    rtt_avg_ms        = COALESCE(excluded.rtt_avg_ms, rtt_avg_ms),
                    rtt_min_ms        = COALESCE(excluded.rtt_min_ms, rtt_min_ms),
                    rtt_max_ms        = COALESCE(excluded.rtt_max_ms, rtt_max_ms),
                    rtt_samples       = COALESCE(excluded.rtt_samples, rtt_samples)`
            )
            .run(
                transfer.transferId,
                transfer.direction,
                transfer.peerDeviceId,
                peerDeviceName ?? null,
                transfer.fileName,
                transfer.fileSize,
                transfer.totalChunks,
                transfer.checksum ?? null,
                transfer.savedPath ?? null,
                transfer.syncPairId ?? null,
                transfer.relativePath ?? null,
                transfer.sessionId ?? null,
                transfer.state,
                transfer.state === "COMPLETED" ? 1 : 0,
                transfer.startedAt ?? null,
                completedAt,
                durationMs ?? null,
                transfer.bytesTransferred,
                transfer.retryCount,
                throughputBps ?? null,
                rttAvgMs ?? null,
                transfer.rttMinMs ?? null,
                transfer.rttMaxMs ?? null,
                transfer.rttSamples ?? null
            );
    }

    recordSession(summary: SessionSummary): void {
        this.db
            .prepare(
                `INSERT INTO sessions (
                    session_id, peer_device_id, peer_device_name,
                    started_at, ended_at, status
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    peer_device_name = COALESCE(excluded.peer_device_name, peer_device_name),
                    ended_at         = excluded.ended_at,
                    status           = excluded.status`
            )
            .run(
                summary.sessionId,
                summary.peerDeviceId || null,
                summary.peerDeviceName ?? null,
                summary.startedAt,
                summary.endedAt ?? null,
                summary.status
            );
    }

    recordDevice(device: {
        deviceId: string;
        deviceName?: string;
        platform?: string;
    }): void {
        const now = Date.now();

        this.db
            .prepare(
                `INSERT INTO devices (
                    device_id, device_name, platform, first_seen_at, last_seen_at
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(device_id) DO UPDATE SET
                    device_name  = COALESCE(excluded.device_name, device_name),
                    platform     = COALESCE(excluded.platform, platform),
                    last_seen_at = excluded.last_seen_at`
            )
            .run(
                device.deviceId,
                device.deviceName ?? null,
                device.platform ?? null,
                now,
                now
            );
    }

    getTransfers(query: HistoryQuery = {}): HistoryPage {
        const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
        const offset = Math.max(query.offset ?? 0, 0);

        const where: string[] = [];
        const params: Array<string | number> = [];

        if (query.peerDeviceId) {
            where.push("peer_device_id = ?");
            params.push(query.peerDeviceId);
        }

        if (query.direction) {
            where.push("direction = ?");
            params.push(query.direction);
        }

        if (query.since !== undefined) {
            where.push("completed_at >= ?");
            params.push(query.since);
        }

        if (query.search) {
            where.push(
                "(file_name LIKE ? ESCAPE '\\' " +
                    "OR relative_path LIKE ? ESCAPE '\\')"
            );

            // Escaped so a user typing % or _ searches for the literal.
            const pattern = `%${query.search.replace(/[%_\\]/g, "\\$&")}%`;
            params.push(pattern, pattern);
        }

        const whereSql =
            where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

        const [{ count } = { count: 0 }] = this.db
            .prepare(
                `SELECT COUNT(*) AS count FROM transfers ${whereSql}`
            )
            .all(...params) as Array<{ count: number }>;

        const rows = this.db
            .prepare(
                `SELECT * FROM transfers ${whereSql}
                 ORDER BY completed_at DESC
                 LIMIT ? OFFSET ?`
            )
            .all(...params, limit, offset) as Row[];

        return {
            transfers: rows.map(rowToTransfer),
            total: count,
            limit,
            offset,
        };
    }

    getAnalytics(since?: number): Analytics {
        const where = since !== undefined ? "WHERE completed_at >= ?" : "";
        const p: number[] = since !== undefined ? [since] : [];

        const [totals = {} as Row] = this.db
            .prepare(
                `SELECT
                    COUNT(*)                                        AS transfers,
                    COALESCE(SUM(succeeded), 0)                     AS succeeded,
                    COALESCE(SUM(bytes_transferred), 0)             AS bytes,
                    COALESCE(SUM(CASE WHEN direction = 'sent'
                        THEN bytes_transferred ELSE 0 END), 0)      AS bytes_sent,
                    COALESCE(SUM(CASE WHEN direction = 'received'
                        THEN bytes_transferred ELSE 0 END), 0)      AS bytes_received,
                    COALESCE(SUM(retry_count), 0)                   AS total_retries,
                    COALESCE(SUM(CASE WHEN retry_count > 0
                        THEN 1 ELSE 0 END), 0)                      AS with_retries,
                    AVG(throughput_bps)                             AS avg_bps,
                    MAX(throughput_bps)                             AS peak_bps,
                    AVG(duration_ms)                                AS avg_duration,
                    MIN(rtt_min_ms)                                 AS min_rtt,
                    MAX(rtt_max_ms)                                 AS max_rtt,
                    COALESCE(SUM(rtt_samples), 0)                   AS rtt_samples
                 FROM transfers ${where}`
            )
            .all(...p) as Row[];

        /*
         * Averaging the per-transfer averages would weight a
         * three-chunk file the same as a thousand-chunk one, so the
         * mean RTT is recovered from the sample totals instead.
         */
        const [rtt = {} as Row] = this.db
            .prepare(
                `SELECT
                    COALESCE(SUM(rtt_avg_ms * rtt_samples), 0) AS weighted,
                    COALESCE(SUM(rtt_samples), 0)              AS samples
                 FROM transfers ${where} ${where ? "AND" : "WHERE"}
                    rtt_samples IS NOT NULL AND rtt_avg_ms IS NOT NULL`
            )
            .all(...p) as Row[];

        const rttSamples = num(rtt.samples) ?? 0;

        const byPeer = (
            this.db
                .prepare(
                    `SELECT
                        peer_device_id,
                        MAX(peer_device_name)               AS peer_device_name,
                        COUNT(*)                            AS transfers,
                        COALESCE(SUM(bytes_transferred), 0) AS bytes,
                        AVG(throughput_bps)                 AS avg_bps
                     FROM transfers ${where}
                     GROUP BY peer_device_id
                     ORDER BY bytes DESC`
                )
                .all(...p) as Row[]
        ).map((row) => ({
            peerDeviceId: String(row.peer_device_id ?? ""),
            peerDeviceName: str(row.peer_device_name),
            transfers: num(row.transfers) ?? 0,
            bytes: num(row.bytes) ?? 0,
            avgThroughputBps: num(row.avg_bps),
        }));

        /*
         * Bucketed with SQLite's localtime modifier so a "day" means
         * the user's day, not UTC's — a late-evening transfer should
         * not land on tomorrow's bar.
         */
        const byDay = (
            this.db
                .prepare(
                    `SELECT
                        CAST(strftime('%s', date(completed_at / 1000, 'unixepoch', 'localtime')) AS INTEGER) * 1000
                            AS bucket_start,
                        COUNT(*)                            AS transfers,
                        COALESCE(SUM(bytes_transferred), 0) AS bytes,
                        AVG(throughput_bps)                 AS avg_bps,
                        AVG(rtt_avg_ms)                     AS avg_rtt
                     FROM transfers ${where}
                     GROUP BY bucket_start
                     ORDER BY bucket_start ASC`
                )
                .all(...p) as Row[]
        ).map((row) => ({
            bucketStart: num(row.bucket_start) ?? 0,
            transfers: num(row.transfers) ?? 0,
            bytes: num(row.bytes) ?? 0,
            avgThroughputBps: num(row.avg_bps),
            avgRttMs: num(row.avg_rtt),
        }));

        const [largest] = this.db
            .prepare(
                `SELECT file_name, file_size, throughput_bps
                 FROM transfers ${where}
                 ORDER BY file_size DESC LIMIT 1`
            )
            .all(...p) as Row[];

        const [sessions = {} as Row] = this.db
            .prepare(
                `SELECT
                    COUNT(*) AS total,
                    AVG(CASE WHEN ended_at IS NOT NULL
                        THEN ended_at - started_at END) AS avg_duration
                 FROM sessions`
            )
            .all() as Row[];

        const [devices = {} as Row] = this.db
            .prepare("SELECT COUNT(*) AS total FROM devices")
            .all() as Row[];

        const transfers = num(totals.transfers) ?? 0;
        const succeeded = num(totals.succeeded) ?? 0;

        return {
            since,
            generatedAt: Date.now(),

            totals: {
                transfers,
                succeeded,
                failed: transfers - succeeded,
                successRate:
                    transfers > 0 ? succeeded / transfers : undefined,
                bytes: num(totals.bytes) ?? 0,
                bytesSent: num(totals.bytes_sent) ?? 0,
                bytesReceived: num(totals.bytes_received) ?? 0,
                totalRetries: num(totals.total_retries) ?? 0,
                transfersWithRetries: num(totals.with_retries) ?? 0,
            },

            throughput: {
                avgBps: num(totals.avg_bps),
                peakBps: num(totals.peak_bps),
                avgDurationMs: num(totals.avg_duration),
            },

            latency: {
                avgRttMs:
                    rttSamples > 0
                        ? (num(rtt.weighted) ?? 0) / rttSamples
                        : undefined,
                minRttMs: num(totals.min_rtt),
                maxRttMs: num(totals.max_rtt),
                samples: rttSamples,
            },

            largestTransfer: largest
                ? {
                      fileName: String(largest.file_name ?? ""),
                      fileSize: num(largest.file_size) ?? 0,
                      throughputBps: num(largest.throughput_bps),
                  }
                : undefined,

            byPeer,
            byDay,

            sessions: {
                total: num(sessions.total) ?? 0,
                avgDurationMs: num(sessions.avg_duration),
            },

            devicesSeen: num(devices.total) ?? 0,
        };
    }

    clear(): void {
        this.db.exec("DELETE FROM transfers");
        this.db.exec("DELETE FROM sessions");
        this.db.exec("DELETE FROM devices");
    }

    close(): void {
        this.db.close();
    }
}

function rowToTransfer(row: Row): HistoryTransfer {
    return {
        transferId: String(row.transfer_id ?? ""),
        direction: row.direction === "received" ? "received" : "sent",

        peerDeviceId: String(row.peer_device_id ?? ""),
        peerDeviceName: str(row.peer_device_name),

        fileName: String(row.file_name ?? ""),
        fileSize: num(row.file_size) ?? 0,
        totalChunks: num(row.total_chunks) ?? 0,

        checksum: str(row.checksum),
        savedPath: str(row.saved_path),

        syncPairId: str(row.sync_pair_id),
        relativePath: str(row.relative_path),
        sessionId: str(row.session_id),

        state: String(row.state ?? ""),
        succeeded: row.succeeded === 1,

        startedAt: num(row.started_at),
        completedAt: num(row.completed_at) ?? 0,
        durationMs: num(row.duration_ms),

        bytesTransferred: num(row.bytes_transferred) ?? 0,
        retryCount: num(row.retry_count) ?? 0,
        throughputBps: num(row.throughput_bps),

        rttAvgMs: num(row.rtt_avg_ms),
        rttMinMs: num(row.rtt_min_ms),
        rttMaxMs: num(row.rtt_max_ms),
        rttSamples: num(row.rtt_samples),
    };
}
