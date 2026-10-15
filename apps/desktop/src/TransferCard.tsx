import type { Transfer } from "./api";
import { formatBytes, formatDuration, formatRate } from "./format";


interface TransferCardProps {
    transfer: Transfer;
    peerName: string;
    syncPairName?: string;
    onOpen: () => void;
    onPause: () => void;
    onResume: () => void;
    onCancel: () => void;
    onUnlock: () => void;
    onShowInFolder?: (path: string) => void;
}

const STATE_LABEL: Record<string, string> = {
    REQUESTED: "Waiting for peer",
    ACCEPTED: "Starting",
    TRANSFERRING: "Transferring",
    PAUSED: "Paused",
    COMPLETED: "Completed",
    REJECTED: "Rejected",
    CANCELLED: "Cancelled",
};

import { isLiveTransfer } from "./transfer-status";

/**
 * One transfer, with live progress. Speed and ETA are derived from
 * the transfer's own start time and byte count, so the card needs no
 * history of its own.
 */
export function TransferCard({
    transfer,
    peerName,
    syncPairName,
    onOpen,
    onPause,
    onResume,
    onCancel,
    onUnlock,
    onShowInFolder,
}: TransferCardProps) {
    const sent = transfer.direction === "sent";
    const live = isLiveTransfer(transfer);
    const done = transfer.state === "COMPLETED";

    const percent =
        transfer.fileSize > 0
            ? Math.min(
                  100,
                  Math.round(
                      (transfer.bytesTransferred / transfer.fileSize) * 100
                  )
              )
            : done
              ? 100
              : 0;

    const elapsedMs =
        transfer.startedAt && transfer.lastProgressAt
            ? transfer.lastProgressAt - transfer.startedAt
            : 0;

    const speed =
        elapsedMs > 500 ? transfer.bytesTransferred / (elapsedMs / 1000) : 0;

    const remaining = transfer.fileSize - transfer.bytesTransferred;
    const eta =
        transfer.state === "TRANSFERRING" && speed > 0
            ? (remaining / speed) * 1000
            : undefined;

    const name =
        transfer.sensitive && sent
            ? transfer.originalFileName ?? transfer.fileName
            : transfer.sensitive && transfer.locked
              ? "Sensitive file"
              : transfer.fileName;

    const detail = [
        sent ? `To ${peerName}` : `From ${peerName}`,
        transfer.fileSize > 0 ? formatBytes(transfer.fileSize) : undefined,
        transfer.state === "TRANSFERRING" && speed > 0
            ? formatRate(speed)
            : undefined,
        eta !== undefined ? `${formatDuration(eta)} left` : undefined,
        transfer.retryCount > 0
            ? `${transfer.retryCount} retr${transfer.retryCount === 1 ? "y" : "ies"}`
            : undefined,
    ].filter(Boolean);

    return (
        <article
            className={`transfer-card transfer-${transfer.state.toLowerCase()}`}
        >
            <button type="button" className="transfer-main" onClick={onOpen}>
                <span className="transfer-direction">
                    {sent ? "Outgoing" : "Incoming"}
                </span>

                <span className="transfer-title">
                    <strong title={name}>{name}</strong>

                    {transfer.sensitive && (
                        <span className="tag tag-warn">
                            {transfer.locked ? "Locked" : "Sensitive"}
                        </span>
                    )}

                    {syncPairName && (
                        <span className="tag">Sync: {syncPairName}</span>
                    )}
                </span>

                <span className="transfer-detail">{detail.join("  ·  ")}</span>

                {transfer.savedPath && !transfer.locked && (
                    <span className="transfer-path mono">
                        {transfer.savedPath}
                    </span>
                )}
            </button>

            <div className="transfer-side">
                <span className={`state-pill state-${transfer.state.toLowerCase()}`}>
                    {STATE_LABEL[transfer.state] ?? transfer.state}
                </span>

                <div className="transfer-actions">
                    {sent && transfer.state === "TRANSFERRING" && (
                        <button type="button" className="btn btn-sm" onClick={onPause}>
                            Pause
                        </button>
                    )}

                    {sent && transfer.state === "PAUSED" && (
                        <button type="button" className="btn btn-sm" onClick={onResume}>
                            Resume
                        </button>
                    )}

                    {sent && live && (
                        <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            onClick={onCancel}
                        >
                            Cancel
                        </button>
                    )}

                    {!sent && done && transfer.locked && (
                        <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={onUnlock}
                        >
                            Unlock
                        </button>
                    )}

                    {!sent &&
                        done &&
                        !transfer.locked &&
                        transfer.savedPath &&
                        onShowInFolder && (
                            <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => onShowInFolder(transfer.savedPath!)}
                            >
                                Show in folder
                            </button>
                        )}
                </div>
            </div>

            {(live || done) && (
                <div
                    className="progress"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                >
                    <div
                        className={`progress-fill${
                            transfer.state === "TRANSFERRING" ? " active" : ""
                        }`}
                        style={{ width: `${percent}%` }}
                    />
                </div>
            )}
        </article>
    );
}
