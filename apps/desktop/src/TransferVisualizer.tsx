import {
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";

import {
    cancelTransfer,
    pauseTransfer,
    resumeTransfer,
    subscribeToTransferEvents,
    type Transfer,
    type TransferEvent,
} from "./api";

/*
 * Per-chunk state, kept in a plain typed array (not React state) so
 * thousands of chunk-level events per second don't trigger React
 * re-renders. A requestAnimationFrame loop redraws the canvas from
 * this array at a capped rate instead.
 */
const CHUNK_PENDING = 0;
const CHUNK_SENT = 1;
const CHUNK_ACKED = 2;
const CHUNK_RETRIED = 3;

const CHUNK_COLORS: Record<number, string> = {
    [CHUNK_PENDING]: "#e3e5e8",
    [CHUNK_SENT]: "#3b5998",
    [CHUNK_ACKED]: "#247a45",
    [CHUNK_RETRIED]: "#a83232",
};

const LEGEND_ITEMS: Array<{ state: number; label: string }> = [
    { state: CHUNK_PENDING, label: "Waiting" },
    { state: CHUNK_SENT, label: "Sent" },
    { state: CHUNK_ACKED, label: "Confirmed" },
    { state: CHUNK_RETRIED, label: "Retried" },
];

/*
 * Pipeline steps a transfer visibly moves through. "Verifying" has no
 * matching server-side state — it's a UI-only beat shown once every
 * chunk is acked but the transfer hasn't flipped to COMPLETED yet, so
 * beginners see the checksum step rather than a stall.
 */
const STEPS: Array<{ key: string; label: string }> = [
    { key: "REQUESTED", label: "Requested" },
    { key: "ACCEPTED", label: "Accepted" },
    { key: "TRANSFERRING", label: "Transferring" },
    { key: "VERIFYING", label: "Verifying" },
    { key: "COMPLETED", label: "Complete" },
];

function getStepIndex(state: string, progressRatio: number): number {
    if (state === "REQUESTED") return 0;
    if (state === "ACCEPTED") return 1;
    if (state === "TRANSFERRING" || state === "PAUSED") {
        return progressRatio >= 1 ? 3 : 2;
    }
    if (state === "COMPLETED") return 4;
    return -1;
}

function describeEvent(
    event: TransferEvent,
    totalChunks: number
): string | null {
    switch (event.type) {
        case "CHUNK_SENT":
            return typeof event.chunkIndex === "number"
                ? `Sending chunk ${event.chunkIndex + 1} of ${totalChunks.toLocaleString()}…`
                : null;
        case "CHUNK_ACKED":
            return typeof event.chunkIndex === "number"
                ? `Chunk ${event.chunkIndex + 1} confirmed by peer`
                : `Transferring… ${event.chunksAcked.toLocaleString()}/${totalChunks.toLocaleString()} chunks confirmed`;
        case "CHUNK_RETRY":
            return typeof event.chunkIndex === "number"
                ? `Chunk ${event.chunkIndex + 1} timed out — retrying`
                : null;
        case "TRANSFER_PAUSED":
            return "Transfer paused";
        case "TRANSFER_RESUMED":
            return "Transfer resumed";
        case "TRANSFER_PROGRESS":
            return `Transferring… ${event.chunksAcked.toLocaleString()}/${totalChunks.toLocaleString()} chunks confirmed`;
        default:
            return null;
    }
}

function initialNarration(transfer: Transfer): string {
    if (transfer.state === "COMPLETED") return "Transfer complete";
    if (transfer.state === "CANCELLED") return "Transfer cancelled";
    if (transfer.state === "REJECTED") return "Transfer rejected";
    if (transfer.state === "REQUESTED") return "Waiting for peer to accept…";
    if (transfer.state === "PAUSED") return "Transfer paused";
    return "Starting transfer…";
}

interface Props {
    transfer: Transfer;
    onClose: () => void;
}

interface LiveState {
    state: string;
    paused: boolean;
    chunksAcked: number;
    bytesTransferred: number;
    retryCount: number;
}

interface Sample {
    timestamp: number;
    bytesTransferred: number;
}

export function TransferVisualizer({ transfer, onClose }: Props) {
    const [live, setLive] = useState<LiveState>({
        state: transfer.state,
        paused: transfer.paused,
        chunksAcked: transfer.chunksAcked,
        bytesTransferred: transfer.bytesTransferred,
        retryCount: transfer.retryCount,
    });

    const [speedBps, setSpeedBps] = useState(0);
    const [actionError, setActionError] = useState<string | null>(null);
    const [actionPending, setActionPending] = useState(false);
    const [narration, setNarration] = useState(() => initialNarration(transfer));

    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    const totalChunks =
        transfer.totalChunks || 1;

    const chunkStateRef = useRef<Uint8Array>(
        new Uint8Array(totalChunks)
    );

    const dirtyRef = useRef(true);
    const samplesRef = useRef<Sample[]>([]);
    const narrationRef = useRef(narration);
    const narrationDirtyRef = useRef(false);

    const canControl =
        transfer.direction === "sent";

    /*
     * Subscribe to the live chunk/progress event stream and apply
     * events for this transfer only, directly into refs. State
     * updates for the stats bar are pushed from the rAF loop below,
     * throttled, so this can fire at any rate without hurting React.
     */
    useEffect(() => {
        const unsubscribe = subscribeToTransferEvents((event: TransferEvent) => {
            if (event.transferId !== transfer.transferId) {
                return;
            }

            if (
                typeof event.chunkIndex === "number" &&
                event.chunkIndex >= 0 &&
                event.chunkIndex < chunkStateRef.current.length
            ) {
                const current =
                    chunkStateRef.current[event.chunkIndex];

                if (event.type === "CHUNK_SENT" && current === CHUNK_PENDING) {
                    chunkStateRef.current[event.chunkIndex] = CHUNK_SENT;
                } else if (event.type === "CHUNK_ACKED") {
                    chunkStateRef.current[event.chunkIndex] = CHUNK_ACKED;
                } else if (event.type === "CHUNK_RETRY") {
                    chunkStateRef.current[event.chunkIndex] = CHUNK_RETRIED;
                }

                dirtyRef.current = true;
            }

            const description = describeEvent(event, totalChunks);
            if (description) {
                narrationRef.current = description;
                narrationDirtyRef.current = true;
            }

            if (
                event.type === "TRANSFER_PROGRESS" ||
                event.type === "CHUNK_ACKED"
            ) {
                samplesRef.current.push({
                    timestamp: event.timestamp,
                    bytesTransferred: event.bytesTransferred,
                });

                // Keep only the last ~3 seconds of samples for the
                // rolling speed calculation.
                const cutoff = event.timestamp - 3000;
                samplesRef.current = samplesRef.current.filter(
                    (sample) => sample.timestamp >= cutoff
                );

                setLive((current) => ({
                    ...current,
                    chunksAcked: event.chunksAcked,
                    bytesTransferred: event.bytesTransferred,
                }));
            }

            if (event.type === "CHUNK_RETRY") {
                setLive((current) => ({
                    ...current,
                    retryCount: current.retryCount + 1,
                }));
            }

            if (event.type === "TRANSFER_PAUSED") {
                setLive((current) => ({ ...current, paused: true, state: "PAUSED" }));
            }

            if (event.type === "TRANSFER_RESUMED") {
                setLive((current) => ({ ...current, paused: false, state: "TRANSFERRING" }));
            }
        });

        return unsubscribe;
    }, [transfer.transferId]);

    /*
     * Redraw the chunk grid at a capped rate and recompute the
     * rolling transfer speed, independent of React's render cycle.
     */
    useEffect(() => {
        let frame: number;

        const tick = () => {
            if (dirtyRef.current) {
                drawGrid(canvasRef.current, chunkStateRef.current, totalChunks);
                dirtyRef.current = false;
            }

            if (narrationDirtyRef.current) {
                setNarration(narrationRef.current);
                narrationDirtyRef.current = false;
            }

            const samples = samplesRef.current;
            if (samples.length >= 2) {
                const first = samples[0];
                const last = samples[samples.length - 1];
                const elapsedSeconds = (last.timestamp - first.timestamp) / 1000;
                const bytesDelta = last.bytesTransferred - first.bytesTransferred;

                setSpeedBps(
                    elapsedSeconds > 0 ? bytesDelta / elapsedSeconds : 0
                );
            }

            frame = requestAnimationFrame(tick);
        };

        frame = requestAnimationFrame(tick);

        return () => cancelAnimationFrame(frame);
    }, [totalChunks]);

    const eta = useMemo(() => {
        if (speedBps <= 0) {
            return null;
        }

        const remaining = transfer.fileSize - live.bytesTransferred;

        if (remaining <= 0) {
            return 0;
        }

        return remaining / speedBps;
    }, [speedBps, live.bytesTransferred, transfer.fileSize]);

    const progressRatio =
        totalChunks > 0
            ? Math.min(live.chunksAcked / totalChunks, 1)
            : 0;

    const isActive =
        live.state === "TRANSFERRING" && !live.paused;

    const stepIndex = getStepIndex(live.state, progressRatio);
    const isTerminalError =
        live.state === "CANCELLED" || live.state === "REJECTED";

    const handlePauseResume = async () => {
        setActionError(null);
        setActionPending(true);

        try {
            if (live.paused) {
                await resumeTransfer(transfer.transferId);
            } else {
                await pauseTransfer(transfer.transferId);
            }
        } catch (error) {
            setActionError(
                error instanceof Error ? error.message : "Action failed"
            );
        } finally {
            setActionPending(false);
        }
    };

    const handleCancel = async () => {
        setActionError(null);
        setActionPending(true);

        try {
            await cancelTransfer(transfer.transferId);
        } catch (error) {
            setActionError(
                error instanceof Error ? error.message : "Cancel failed"
            );
        } finally {
            setActionPending(false);
        }
    };

    return (
        <div className="visualizer-overlay" onClick={onClose}>
            <div
                className="visualizer-panel"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="visualizer-header">
                    <div>
                        <strong>{transfer.fileName}</strong>
                        <span className="visualizer-subtitle">
                            {transfer.direction === "received" ? "Receiving from" : "Sending to"}{" "}
                            peer {transfer.peerDeviceId.slice(0, 8)}
                        </span>
                    </div>

                    <button className="visualizer-close" onClick={onClose}>
                        ✕
                    </button>
                </div>

                {isTerminalError ? (
                    <div className="visualizer-step-error">
                        {live.state === "CANCELLED" ? "Transfer cancelled" : "Transfer rejected"}
                    </div>
                ) : (
                    <div className="visualizer-steps">
                        {STEPS.map((step, index) => (
                            <div
                                key={step.key}
                                className={`visualizer-step ${
                                    index < stepIndex ? "done" : index === stepIndex ? "active" : ""
                                }`}
                            >
                                <span className="visualizer-step-dot" />
                                <span className="visualizer-step-label">{step.label}</span>
                            </div>
                        ))}
                    </div>
                )}

                <div className="connection-diagram">
                    <div className="connection-node">
                        {transfer.direction === "sent" ? "You" : "Peer"}
                    </div>

                    <div className="connection-link">
                        <div
                            className={`connection-pulse ${isActive ? "active" : ""}`}
                        />
                        <span className="connection-speed">
                            {isActive ? `${formatBytes(speedBps)}/s` : live.state}
                        </span>
                    </div>

                    <div className="connection-node">
                        {transfer.direction === "sent" ? "Peer" : "You"}
                    </div>
                </div>

                <p className="visualizer-narration">{narration}</p>

                <div className="chunk-grid-wrapper">
                    <canvas ref={canvasRef} className="chunk-grid-canvas" />
                </div>

                <div className="visualizer-legend">
                    {LEGEND_ITEMS.map((item) => (
                        <span className="legend-item" key={item.state}>
                            <span
                                className="legend-swatch"
                                style={{ background: CHUNK_COLORS[item.state] }}
                            />
                            {item.label}
                        </span>
                    ))}
                </div>

                <div className="visualizer-stats">
                    <div>
                        <span className="label">Chunks</span>
                        <strong>
                            {live.chunksAcked.toLocaleString()} / {totalChunks.toLocaleString()}
                        </strong>
                    </div>

                    <div>
                        <span className="label">Bytes</span>
                        <strong>
                            {formatBytes(live.bytesTransferred)} / {formatBytes(transfer.fileSize)}
                        </strong>
                    </div>

                    <div>
                        <span className="label">Speed</span>
                        <strong>{isActive ? `${formatBytes(speedBps)}/s` : "—"}</strong>
                    </div>

                    <div>
                        <span className="label">ETA</span>
                        <strong>{eta !== null ? formatDuration(eta) : "—"}</strong>
                    </div>

                    <div>
                        <span className="label">Retries</span>
                        <strong>{live.retryCount}</strong>
                    </div>

                    <div>
                        <span className="label">State</span>
                        <strong>{live.state}</strong>
                    </div>
                </div>

                {actionError && (
                    <div className="error-banner visualizer-error">
                        {actionError}
                    </div>
                )}

                {canControl && (
                    <div className="visualizer-controls">
                        {(live.state === "TRANSFERRING" || live.state === "PAUSED") && (
                            <button
                                className="connect-button"
                                disabled={actionPending}
                                onClick={handlePauseResume}
                            >
                                {live.paused ? "Resume" : "Pause"}
                            </button>
                        )}

                        {(live.state === "TRANSFERRING" || live.state === "PAUSED") && (
                            <button
                                className="disconnect-button"
                                disabled={actionPending}
                                onClick={handleCancel}
                            >
                                Cancel
                            </button>
                        )}
                    </div>
                )}

                {progressRatio === 1 && (
                    <div className="visualizer-progress-caption">
                        Transfer complete
                        {transfer.savedPath && ` · saved to ${transfer.savedPath}`}
                    </div>
                )}
            </div>
        </div>
    );
}

function drawGrid(
    canvas: HTMLCanvasElement | null,
    chunkState: Uint8Array,
    totalChunks: number
): void {
    if (!canvas) {
        return;
    }

    const container = canvas.parentElement;
    const width = container?.clientWidth ?? 400;

    const columns = Math.max(
        1,
        Math.ceil(Math.sqrt(totalChunks * 2))
    );

    const cellSize = Math.max(
        2,
        Math.min(14, Math.floor(width / columns))
    );

    const rows = Math.ceil(totalChunks / columns);
    const height = rows * cellSize;

    if (canvas.width !== columns * cellSize || canvas.height !== height) {
        canvas.width = columns * cellSize;
        canvas.height = height;
    }

    const ctx = canvas.getContext("2d");

    if (!ctx) {
        return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let index = 0; index < totalChunks; index++) {
        const column = index % columns;
        const row = Math.floor(index / columns);

        ctx.fillStyle = CHUNK_COLORS[chunkState[index]] ?? CHUNK_COLORS[CHUNK_PENDING];

        ctx.fillRect(
            column * cellSize + 1,
            row * cellSize + 1,
            cellSize - 1,
            cellSize - 1
        );
    }
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return "0 B";
    }

    if (bytes < 1024) {
        return `${bytes.toFixed(0)} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDuration(seconds: number): string {
    if (seconds < 1) {
        return "<1s";
    }

    if (seconds < 60) {
        return `${Math.ceil(seconds)}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.ceil(seconds % 60);

    return `${minutes}m ${remainingSeconds}s`;
}
