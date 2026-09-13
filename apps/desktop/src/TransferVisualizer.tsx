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

    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    const totalChunks =
        transfer.totalChunks || 1;

    const chunkStateRef = useRef<Uint8Array>(
        new Uint8Array(totalChunks)
    );

    const dirtyRef = useRef(true);
    const samplesRef = useRef<Sample[]>([]);

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

                <div className="chunk-grid-wrapper">
                    <canvas ref={canvasRef} className="chunk-grid-canvas" />
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
