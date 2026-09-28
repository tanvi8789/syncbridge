import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SyncPairStatus =
    | "PENDING"
    | "ACTIVE"
    | "REJECTED"
    | "REMOVED";

export interface SyncPair {
    pairId: string;
    name: string;
    peerDeviceId: string;
    localFolder: string;
    status: SyncPairStatus;

    createdAt: number;
    lastSyncAt?: number;

    /** Threads this pair back to the connection session it was created over. */
    sessionId?: string;
}

export interface BaselineEntry {
    size: number;
    mtimeMs: number;
    checksum: string;
}

/**
 * The last state of a sync folder that this device knows both sides
 * agreed on. Compared against a fresh scan to detect local changes,
 * and against completed sync transfers to record new agreement.
 */
export type Baseline = Map<string, BaselineEntry>;

const syncStateDirectory = path.join(
    os.homedir(),
    "SyncBridge",
    "sync-state"
);

function baselinePath(pairId: string): string {
    return path.join(
        syncStateDirectory,
        `${pairId}.json`
    );
}

export function loadBaseline(
    pairId: string
): Baseline {
    try {
        const raw = fs.readFileSync(
            baselinePath(pairId),
            "utf8"
        );

        const parsed = JSON.parse(raw) as Record<
            string,
            BaselineEntry
        >;

        return new Map(Object.entries(parsed));
    } catch {
        return new Map();
    }
}

export function saveBaseline(
    pairId: string,
    baseline: Baseline
): void {
    try {
        fs.mkdirSync(
            syncStateDirectory,
            { recursive: true }
        );

        fs.writeFileSync(
            baselinePath(pairId),
            JSON.stringify(
                Object.fromEntries(baseline)
            )
        );
    } catch (error) {
        console.error(
            `[SYNC] Failed to persist baseline for pair ${pairId}:`,
            error
        );
    }
}

export function deleteBaseline(
    pairId: string
): void {
    try {
        fs.unlinkSync(baselinePath(pairId));
    } catch {
        // Nothing to remove.
    }
}
