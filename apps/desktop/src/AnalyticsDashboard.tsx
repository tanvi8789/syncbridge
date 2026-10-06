import { useCallback, useEffect, useState } from "react";

import {
    clearHistory,
    getAnalytics,
    type Analytics,
} from "./api";

import {
    ColumnChart,
    LineChart,
    RankedBars,
    SplitBar,
    StatTile,
    type ChartPoint,
} from "./charts";

import {
    formatBytes,
    formatCount,
    formatDay,
    formatDuration,
    formatMs,
    formatPercent,
    formatRate,
} from "./format";

const RANGES = [
    { label: "24 hours", days: 1 },
    { label: "7 days", days: 7 },
    { label: "30 days", days: 30 },
    { label: "All time", days: 0 },
] as const;

const PEER_LIMIT = 6;

export function AnalyticsDashboard({
    collapsed,
    onToggle,
    explainMode,
    refreshKey,
}: {
    collapsed: boolean;
    onToggle: () => void;
    explainMode: boolean;
    /** Bumped by the parent when a transfer finishes, to force a reload. */
    refreshKey: number;
}) {
    const [rangeDays, setRangeDays] = useState<number>(7);
    const [analytics, setAnalytics] = useState<Analytics | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showTable, setShowTable] = useState(false);

    const load = useCallback(async () => {
        try {
            setLoading(true);

            const since =
                rangeDays > 0
                    ? Date.now() - rangeDays * 24 * 60 * 60 * 1000
                    : undefined;

            setAnalytics(await getAnalytics(since));
            setError(null);
        } catch (err) {
            setError(
                err instanceof Error ? err.message : "Failed to load analytics"
            );
        } finally {
            setLoading(false);
        }
    }, [rangeDays]);

    useEffect(() => {
        if (!collapsed) {
            void load();
        }
    }, [collapsed, load, refreshKey]);

    const handleClear = async () => {
        if (
            !window.confirm(
                "Delete all saved transfer history and analytics? This cannot be undone."
            )
        ) {
            return;
        }

        try {
            await clearHistory();
            await load();
        } catch (err) {
            setError(
                err instanceof Error ? err.message : "Failed to clear history"
            );
        }
    };

    const totals = analytics?.totals;

    const bytesByDay: ChartPoint[] =
        analytics?.byDay.map((bucket) => ({
            label: formatDay(bucket.bucketStart),
            value: bucket.bytes,
            detail: [
                `${formatCount(bucket.transfers)} transfer${
                    bucket.transfers === 1 ? "" : "s"
                }`,
            ],
        })) ?? [];

    const throughputByDay: ChartPoint[] =
        analytics?.byDay
            .filter((bucket) => bucket.avgThroughputBps !== undefined)
            .map((bucket) => ({
                label: formatDay(bucket.bucketStart),
                value: bucket.avgThroughputBps ?? 0,
            })) ?? [];

    const rttByDay: ChartPoint[] =
        analytics?.byDay
            .filter((bucket) => bucket.avgRttMs !== undefined)
            .map((bucket) => ({
                label: formatDay(bucket.bucketStart),
                value: bucket.avgRttMs ?? 0,
            })) ?? [];

    const peerPoints: ChartPoint[] =
        analytics?.byPeer.slice(0, PEER_LIMIT).map((peer) => ({
            label: peer.peerDeviceName ?? peer.peerDeviceId.slice(0, 8),
            value: peer.bytes,
            detail: [
                `${formatCount(peer.transfers)} transfer${
                    peer.transfers === 1 ? "" : "s"
                }`,
            ],
        })) ?? [];

    const isEmpty = !loading && totals !== undefined && totals.transfers === 0;

    return (
        <section className="card viz">
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

                    <h2>Analytics</h2>
                </button>

                {!collapsed && (
                    <div className="viz-controls">
                        {RANGES.map((range) => (
                            <button
                                key={range.label}
                                type="button"
                                className={`range-button${
                                    rangeDays === range.days ? " active" : ""
                                }`}
                                onClick={() => setRangeDays(range.days)}
                            >
                                {range.label}
                            </button>
                        ))}

                        <button
                            type="button"
                            className="connect-button"
                            onClick={() => void load()}
                            disabled={loading}
                        >
                            {loading ? "..." : "Refresh"}
                        </button>
                    </div>
                )}
            </div>

            {collapsed ? null : error ? (
                <div className="empty-state compact">
                    <strong>Analytics unavailable</strong>
                    <p>{error}</p>
                </div>
            ) : isEmpty ? (
                <div className="empty-state compact">
                    <strong>No transfers recorded yet</strong>

                    <p>
                        Completed transfers are saved to a local database and
                        summarised here. Send a file to a connected device to
                        populate the dashboard.
                    </p>
                </div>
            ) : !analytics ? (
                <p className="viz-empty">Loading…</p>
            ) : (
                <>
                    {explainMode && (
                        <div className="explain-panel">
                            Every figure here comes from transfers saved to a
                            SQLite database on this machine, so it survives
                            restarting the app. Throughput is each transfer's
                            bytes divided by its own duration. RTT is the time
                            between a chunk leaving this device and its
                            acknowledgement arriving, measured only on the
                            sending side and only for chunks that were never
                            resent.
                        </div>
                    )}

                    <div className="stat-grid">
                        <StatTile
                            hero
                            label="Data moved"
                            value={formatBytes(totals?.bytes ?? 0)}
                            hint={`${formatCount(
                                totals?.transfers ?? 0
                            )} transfers`}
                        />

                        <StatTile
                            label="Success rate"
                            value={formatPercent(totals?.successRate)}
                            hint={`${formatCount(
                                totals?.failed ?? 0
                            )} failed or cancelled`}
                        />

                        <StatTile
                            label="Average speed"
                            value={formatRate(analytics.throughput.avgBps)}
                            hint={`Peak ${formatRate(
                                analytics.throughput.peakBps
                            )}`}
                        />

                        <StatTile
                            label="Average RTT"
                            value={formatMs(analytics.latency.avgRttMs)}
                            hint={
                                analytics.latency.samples > 0
                                    ? `${formatCount(
                                          analytics.latency.samples
                                      )} chunk acks`
                                    : "No samples yet"
                            }
                        />

                        <StatTile
                            label="Average duration"
                            value={formatDuration(
                                analytics.throughput.avgDurationMs
                            )}
                            hint={`${formatCount(
                                analytics.sessions.total
                            )} sessions`}
                        />

                        <StatTile
                            label="Chunk retries"
                            value={formatCount(totals?.totalRetries ?? 0)}
                            hint={`Across ${formatCount(
                                totals?.transfersWithRetries ?? 0
                            )} transfers`}
                        />
                    </div>

                    <div className="viz-grid">
                        <figure className="viz-figure">
                            <figcaption>
                                <strong>Data moved per day</strong>
                                <span>Bytes transferred, all directions</span>
                            </figcaption>

                            <ColumnChart
                                points={bytesByDay}
                                formatValue={formatBytes}
                            />
                        </figure>

                        <figure className="viz-figure">
                            <figcaption>
                                <strong>Average speed per day</strong>
                                <span>Bytes per second</span>
                            </figcaption>

                            <LineChart
                                points={throughputByDay}
                                formatValue={(value) => formatRate(value)}
                            />
                        </figure>

                        <figure className="viz-figure">
                            <figcaption>
                                <strong>Chunk round-trip time</strong>
                                <span>Average ack latency per day</span>
                            </figcaption>

                            <LineChart
                                points={rttByDay}
                                formatValue={formatMs}
                            />
                        </figure>

                        <figure className="viz-figure">
                            <figcaption>
                                <strong>Sent vs received</strong>
                                <span>Share of all bytes moved</span>
                            </figcaption>

                            <SplitBar
                                formatValue={formatBytes}
                                segments={[
                                    {
                                        label: "Sent",
                                        value: totals?.bytesSent ?? 0,
                                        series: 1,
                                    },
                                    {
                                        label: "Received",
                                        value: totals?.bytesReceived ?? 0,
                                        series: 2,
                                    },
                                ]}
                            />
                        </figure>

                        <figure className="viz-figure viz-figure-wide">
                            <figcaption>
                                <strong>By peer device</strong>
                                <span>Bytes exchanged, highest first</span>
                            </figcaption>

                            <RankedBars
                                points={peerPoints}
                                formatValue={formatBytes}
                            />
                        </figure>
                    </div>

                    <div className="viz-footer">
                        <button
                            type="button"
                            className="section-toggle"
                            aria-expanded={showTable}
                            onClick={() => setShowTable((value) => !value)}
                        >
                            <span
                                className={`chevron${
                                    showTable ? "" : " collapsed"
                                }`}
                                aria-hidden="true"
                            >
                                ▾
                            </span>

                            <span>Table view</span>
                        </button>

                        <button
                            type="button"
                            className="disconnect-button"
                            onClick={() => void handleClear()}
                        >
                            Clear history
                        </button>
                    </div>

                    {/*
                     * Every charted value is reachable without hovering —
                     * the charts enhance this table, they don't gate it.
                     */}
                    {showTable && (
                        <table className="viz-table">
                            <thead>
                                <tr>
                                    <th>Day</th>
                                    <th>Transfers</th>
                                    <th>Bytes</th>
                                    <th>Avg speed</th>
                                    <th>Avg RTT</th>
                                </tr>
                            </thead>

                            <tbody>
                                {analytics.byDay.map((bucket) => (
                                    <tr key={bucket.bucketStart}>
                                        <td>{formatDay(bucket.bucketStart)}</td>
                                        <td>{formatCount(bucket.transfers)}</td>
                                        <td>{formatBytes(bucket.bytes)}</td>
                                        <td>
                                            {formatRate(
                                                bucket.avgThroughputBps
                                            )}
                                        </td>
                                        <td>{formatMs(bucket.avgRttMs)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </>
            )}
        </section>
    );
}
