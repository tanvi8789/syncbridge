import type { SyncEvent, Transfer } from "./api";

export type SyncFileStatus =
    | "queued"
    | "transferring"
    | "paused"
    | "completed"
    | "failed"
    | "deleted"
    | "conflict";

/**
 * One row in a sync pair's file list: what happened to a single
 * file, and how far along it is.
 *
 * A folder sync is really just a stream of ordinary file transfers
 * tagged with a pair id, so this merges the two sources that know
 * about them — sync events (a file was noticed, deleted, or
 * conflicted) and the transfer list (actual bytes on the wire).
 */
export interface SyncFileActivity {
    relativePath: string;
    direction: "sent" | "received" | "local";
    status: SyncFileStatus;
    timestamp: number;

    bytesTransferred?: number;
    fileSize?: number;
    chunksAcked?: number;
    totalChunks?: number;
    transferId?: string;
}

function syncStatusForTransfer(transfer: Transfer): SyncFileStatus {
    switch (transfer.state) {
        case "REQUESTED":
        case "ACCEPTED":
            return "queued";
        case "TRANSFERRING":
            return "transferring";
        case "PAUSED":
            return "paused";
        case "COMPLETED":
            return "completed";
        default:
            return "failed";
    }
}

export const SYNC_STATUS_LABEL: Record<SyncFileStatus, string> = {
    queued: "Queued",
    transferring: "Transferring",
    paused: "Paused",
    completed: "Up to date",
    failed: "Failed",
    deleted: "Deleted",
    conflict: "Conflict copy",
};

/**
 * Collapse both event sources into one row per file per pair,
 * keeping whichever observation is newest.
 *
 * Transfers with no timestamp yet fall back to 0 so a fresh
 * FILE_QUEUED — which means the file changed again — correctly
 * supersedes an older completed transfer for the same path.
 */
export function buildSyncActivity(
    syncEvents: SyncEvent[],
    transfers: Transfer[]
): Map<string, SyncFileActivity[]> {
    const byPair = new Map<string, Map<string, SyncFileActivity>>();

    const put = (pairId: string, activity: SyncFileActivity) => {
        let files = byPair.get(pairId);

        if (!files) {
            files = new Map();
            byPair.set(pairId, files);
        }

        const existing = files.get(activity.relativePath);

        if (!existing || activity.timestamp >= existing.timestamp) {
            files.set(activity.relativePath, activity);
        }
    };

    for (const event of syncEvents) {
        if (!event.relativePath) {
            continue;
        }

        put(event.pairId, {
            relativePath: event.relativePath,
            direction: "local",
            status:
                event.type === "FILE_DELETED"
                    ? "deleted"
                    : event.type === "CONFLICT"
                      ? "conflict"
                      : "queued",
            timestamp: event.timestamp,
        });
    }

    for (const transfer of transfers) {
        if (!transfer.syncPairId) {
            continue;
        }

        put(transfer.syncPairId, {
            relativePath: transfer.relativePath ?? transfer.fileName,
            direction: transfer.direction,
            status: syncStatusForTransfer(transfer),
            timestamp:
                transfer.lastProgressAt ?? transfer.startedAt ?? 0,
            bytesTransferred: transfer.bytesTransferred,
            fileSize: transfer.fileSize,
            chunksAcked: transfer.chunksAcked,
            totalChunks: transfer.totalChunks,
            transferId: transfer.transferId,
        });
    }

    return new Map(
        Array.from(byPair, ([pairId, files]) => [
            pairId,
            Array.from(files.values()).sort(
                (a, b) => b.timestamp - a.timestamp
            ),
        ])
    );
}
