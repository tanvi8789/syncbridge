import { useCallback, useEffect, useState } from "react";

import {
    getHistory,
    type HistoryPage,
    type HistoryTransfer,
} from "./api";

import {
    formatBytes,
    formatDuration,
    formatMs,
    formatRate,
} from "./format";

const PAGE_SIZE = 25;

type DirectionFilter = "" | "sent" | "received";

export function TransferHistory({
    collapsed,
    onToggle,
    explainMode,
    refreshKey,
}: {
    collapsed: boolean;
    onToggle: () => void;
    explainMode: boolean;
    refreshKey: number;
}) {
    const [page, setPage] = useState<HistoryPage | null>(null);
    const [offset, setOffset] = useState(0);
    const [search, setSearch] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [direction, setDirection] = useState<DirectionFilter>("");
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [expandedId, setExpandedId] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setLoading(true);

            setPage(
                await getHistory({
                    limit: PAGE_SIZE,
                    offset,
                    search: debouncedSearch.trim() || undefined,
                    direction: direction || undefined,
                })
            );

            setError(null);
        } catch (err) {
            setError(
                err instanceof Error ? err.message : "Failed to load history"
            );
        } finally {
            setLoading(false);
        }
    }, [offset, debouncedSearch, direction]);

    /*
     * Only the search box is debounced, and only the term itself —
     * so the first load, a page change and a filter change all go
     * out immediately, while typing doesn't fire a query per
     * keystroke.
     */
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(search), 250);

        return () => clearTimeout(timer);
    }, [search]);

    useEffect(() => {
        if (!collapsed) {
            void load();
        }
    }, [collapsed, load, refreshKey]);

    // A new filter invalidates the current page position.
    useEffect(() => setOffset(0), [debouncedSearch, direction]);

    const total = page?.total ?? 0;
    const transfers = page?.transfers ?? [];

    return (
        <section className="card">
            <div className="card-header">
                <button
                    type="button"
                    className="section-toggle"
                    aria-expanded={!collapsed}
                    onClick={onToggle}
                >
                    <span
                        className={`chevron${collapsed ? " collapsed" : ""}`}
                        aria-hidden="true"
                    >
                        ▾
                    </span>

                    <h2>Transfer History</h2>
                </button>

                <span className="count">{total}</span>
            </div>

            {collapsed ? null : (
                <>
                    {explainMode && (
                        <div className="explain-panel">
                            Unlike the live Transfers list, this survives
                            restarting the app — every transfer that reached a
                            final state is written to a SQLite database in
                            <span className="mono"> ~/.syncbridge/history.db</span>.
                        </div>
                    )}

                    <div className="history-filters">
                        <input
                            className="sync-name-input"
                            type="search"
                            placeholder="Search by file name"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                        />

                        <select
                            className="sync-peer-select"
                            value={direction}
                            onChange={(event) =>
                                setDirection(
                                    event.target.value as DirectionFilter
                                )
                            }
                        >
                            <option value="">Sent and received</option>
                            <option value="sent">Sent only</option>
                            <option value="received">Received only</option>
                        </select>
                    </div>

                    {error ? (
                        <div className="empty-state compact">
                            <strong>History unavailable</strong>
                            <p>{error}</p>
                        </div>
                    ) : page === null ? (
                        <p className="viz-empty">Loading…</p>
                    ) : transfers.length === 0 ? (
                        <div className="empty-state compact">
                            <strong>
                                {search || direction
                                    ? "No matching transfers"
                                    : "No saved transfers yet"}
                            </strong>

                            <p>
                                {search || direction
                                    ? "Try a different search or filter."
                                    : "Completed and cancelled transfers are saved here automatically."}
                            </p>
                        </div>
                    ) : (
                        <div className="history-list">
                            {transfers.map((transfer) => (
                                <HistoryRow
                                    key={transfer.transferId}
                                    transfer={transfer}
                                    expanded={
                                        expandedId === transfer.transferId
                                    }
                                    onToggle={() =>
                                        setExpandedId((current) =>
                                            current === transfer.transferId
                                                ? null
                                                : transfer.transferId
                                        )
                                    }
                                />
                            ))}
                        </div>
                    )}

                    {total > PAGE_SIZE && (
                        <div className="history-pager">
                            <button
                                type="button"
                                className="connect-button"
                                disabled={offset === 0 || loading}
                                onClick={() =>
                                    setOffset((value) =>
                                        Math.max(0, value - PAGE_SIZE)
                                    )
                                }
                            >
                                Previous
                            </button>

                            <span>
                                {offset + 1}–
                                {Math.min(offset + PAGE_SIZE, total)} of {total}
                            </span>

                            <button
                                type="button"
                                className="connect-button"
                                disabled={
                                    offset + PAGE_SIZE >= total || loading
                                }
                                onClick={() =>
                                    setOffset((value) => value + PAGE_SIZE)
                                }
                            >
                                Next
                            </button>
                        </div>
                    )}
                </>
            )}
        </section>
    );
}

function HistoryRow({
    transfer,
    expanded,
    onToggle,
}: {
    transfer: HistoryTransfer;
    expanded: boolean;
    onToggle: () => void;
}) {
    const peer =
        transfer.peerDeviceName ?? transfer.peerDeviceId.slice(0, 8);

    return (
        <div className={`history-row${expanded ? " expanded" : ""}`}>
            <button
                type="button"
                className="history-row-main"
                aria-expanded={expanded}
                onClick={onToggle}
            >
                <span className="file-icon">
                    {transfer.direction === "received" ? "↓" : "↑"}
                </span>

                <span className="history-row-info">
                    <strong title={transfer.fileName}>
                        {transfer.relativePath ?? transfer.fileName}
                    </strong>

                    <span>
                        {transfer.direction === "received"
                            ? "From"
                            : "To"}{" "}
                        {peer} · {formatBytes(transfer.fileSize)} ·{" "}
                        {new Date(transfer.completedAt).toLocaleString()}
                    </span>
                </span>

                <span
                    className={`sync-file-status status-${
                        transfer.succeeded ? "completed" : "failed"
                    }`}
                >
                    {transfer.state}
                </span>
            </button>

            {expanded && (
                <dl className="history-detail">
                    <div>
                        <dt>Duration</dt>
                        <dd>{formatDuration(transfer.durationMs)}</dd>
                    </div>

                    <div>
                        <dt>Speed</dt>
                        <dd>{formatRate(transfer.throughputBps)}</dd>
                    </div>

                    <div>
                        <dt>Chunks</dt>
                        <dd>{transfer.totalChunks}</dd>
                    </div>

                    <div>
                        <dt>Retries</dt>
                        <dd>{transfer.retryCount}</dd>
                    </div>

                    <div>
                        <dt>RTT avg</dt>
                        <dd>{formatMs(transfer.rttAvgMs)}</dd>
                    </div>

                    <div>
                        <dt>RTT range</dt>
                        <dd>
                            {transfer.rttMinMs !== undefined
                                ? `${formatMs(transfer.rttMinMs)} – ${formatMs(
                                      transfer.rttMaxMs
                                  )}`
                                : "—"}
                        </dd>
                    </div>

                    {transfer.savedPath && (
                        <div className="history-detail-wide">
                            <dt>Saved to</dt>

                            <dd className="mono">
                                {transfer.savedPath}

                                {window.electronAPI?.showInFolder && (
                                    <button
                                        type="button"
                                        className="connect-button"
                                        onClick={() =>
                                            window.electronAPI.showInFolder(
                                                transfer.savedPath!
                                            )
                                        }
                                    >
                                        Show in Folder
                                    </button>
                                )}
                            </dd>
                        </div>
                    )}

                    {transfer.checksum && (
                        <div className="history-detail-wide">
                            <dt>SHA-256</dt>
                            <dd className="mono">{transfer.checksum}</dd>
                        </div>
                    )}
                </dl>
            )}
        </div>
    );
}
