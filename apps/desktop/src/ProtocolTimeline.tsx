import { useEffect, useRef, useState } from "react";

import {
    getSessionExport,
    getSessionTimeline,
    type ProtocolEvent,
    type SyncEvent,
    type TimelineEntry,
    type TimelineStage,
    type TransferEvent,
} from "./api";

import {
    STAGE_EXPLANATIONS,
    explainTimelineEntry,
} from "./explain";

import {
    downloadText,
    toJson,
    toMarkdown,
    toMermaid,
} from "./session-export";

const STEP_INTERVAL_MS = 900;

const BASE_STAGES: Array<{ key: TimelineStage; label: string }> = [
    { key: "discovery", label: "Discovery" },
    { key: "connection", label: "Connection" },
    { key: "authentication", label: "Authentication" },
    { key: "metadata", label: "Metadata" },
    { key: "chunk-transfer", label: "Chunk transfer" },
    { key: "verification", label: "Verification" },
    { key: "completion", label: "Completion" },
];

const SYNC_STAGE = { key: "sync" as const, label: "Sync" };

type ExportFormat = "json" | "markdown" | "mermaid";

interface Props {
    sessionId: string;
    peerLabel: string;
    explainMode: boolean;
    onClose: () => void;
}

export function SessionReplay({
    sessionId,
    peerLabel,
    explainMode,
    onClose,
}: Props) {
    const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [stepIndex, setStepIndex] = useState(0);
    const [playing, setPlaying] = useState(false);

    const [exporting, setExporting] = useState<ExportFormat | null>(null);
    const [exportError, setExportError] = useState<string | null>(null);

    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const handleExport = async (format: ExportFormat) => {
        setExporting(format);
        setExportError(null);

        try {
            const data = await getSessionExport(sessionId);

            const stem = `syncbridge-session-${sessionId.slice(0, 8)}`;

            if (format === "json") {
                downloadText(
                    `${stem}.json`,
                    toJson(data),
                    "application/json"
                );
            } else if (format === "markdown") {
                downloadText(
                    `${stem}.md`,
                    toMarkdown(data, peerLabel),
                    "text/markdown"
                );
            } else {
                downloadText(
                    `${stem}.mmd`,
                    toMermaid(data, peerLabel),
                    "text/plain"
                );
            }
        } catch (err) {
            setExportError(
                err instanceof Error ? err.message : "Export failed"
            );
        } finally {
            setExporting(null);
        }
    };

    useEffect(() => {
        let cancelled = false;

        getSessionTimeline(sessionId)
            .then((entries) => {
                if (!cancelled) {
                    setTimeline(entries);
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setLoadError(
                        err instanceof Error ? err.message : "Failed to load session timeline"
                    );
                }
            });

        return () => {
            cancelled = true;
        };
    }, [sessionId]);

    useEffect(() => {
        if (!playing || !timeline) {
            return;
        }

        timerRef.current = setInterval(() => {
            setStepIndex((current) => {
                if (current >= timeline.length - 1) {
                    setPlaying(false);
                    return current;
                }

                return current + 1;
            });
        }, STEP_INTERVAL_MS);

        return () => {
            if (timerRef.current) {
                clearInterval(timerRef.current);
            }
        };
    }, [playing, timeline]);

    const hasSync = timeline?.some((entry) => entry.stage === "sync") ?? false;
    const stages = hasSync ? [...BASE_STAGES, SYNC_STAGE] : BASE_STAGES;

    const current = timeline?.[stepIndex];
    const reachedStages = new Set(
        (timeline ?? []).slice(0, stepIndex + 1).map((entry) => entry.stage)
    );

    return (
        <div className="visualizer-overlay" onClick={onClose}>
            <div
                className="visualizer-panel timeline-panel"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="visualizer-header">
                    <div>
                        <strong>Session with {peerLabel}</strong>
                        <span className="visualizer-subtitle">{sessionId}</span>
                    </div>

                    <div className="visualizer-header-actions">
                        <button
                            className="connect-button"
                            disabled={exporting !== null || !timeline?.length}
                            onClick={() => handleExport("json")}
                            title="Full machine-readable export of this session"
                        >
                            {exporting === "json" ? "…" : "JSON"}
                        </button>

                        <button
                            className="connect-button"
                            disabled={exporting !== null || !timeline?.length}
                            onClick={() => handleExport("markdown")}
                            title="Readable write-up with event counts and timeline"
                        >
                            {exporting === "markdown" ? "…" : "Markdown"}
                        </button>

                        <button
                            className="connect-button"
                            disabled={exporting !== null || !timeline?.length}
                            onClick={() => handleExport("mermaid")}
                            title="Mermaid sequence diagram of the messages exchanged"
                        >
                            {exporting === "mermaid" ? "…" : "Diagram"}
                        </button>

                        <button className="visualizer-close" onClick={onClose}>
                            ✕
                        </button>
                    </div>
                </div>

                {loadError && <div className="error-banner visualizer-error">{loadError}</div>}
                {exportError && (
                    <div className="error-banner visualizer-error">{exportError}</div>
                )}

                {!timeline && !loadError && (
                    <div className="empty-state compact">
                        <strong>Loading timeline…</strong>
                    </div>
                )}

                {timeline && timeline.length === 0 && (
                    <div className="empty-state compact">
                        <strong>No recorded events</strong>
                        <p>This session has no captured timeline data.</p>
                    </div>
                )}

                {timeline && timeline.length > 0 && (
                    <>
                        <div className="visualizer-steps">
                            {stages.map((stage) => {
                                const isActive = current?.stage === stage.key;
                                const isDone = !isActive && reachedStages.has(stage.key);
                                const isEmpty = stage.key === "authentication";

                                return (
                                    <div
                                        key={stage.key}
                                        className={`visualizer-step ${
                                            isEmpty ? "visualizer-step-empty" : isDone ? "done" : isActive ? "active" : ""
                                        }`}
                                        title={STAGE_EXPLANATIONS[stage.key]}
                                    >
                                        <span className="visualizer-step-dot" />
                                        <span className="visualizer-step-label">{stage.label}</span>
                                    </div>
                                );
                            })}
                        </div>

                        <p className="visualizer-narration">
                            {current ? describeEntry(current) : ""}
                        </p>

                        {explainMode && current && (
                            <div className="explain-panel">
                                <div className="explain-stage">
                                    <span className="explain-badge">
                                        {current.stage}
                                    </span>
                                    <p>{STAGE_EXPLANATIONS[current.stage]}</p>
                                </div>

                                {explainTimelineEntry(current) && (
                                    <div className="explain-event">
                                        <span className="explain-badge subtle">
                                            {
                                                (current.event as { type?: string })
                                                    .type
                                            }
                                        </span>
                                        <p>{explainTimelineEntry(current)}</p>
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="timeline-scrubber">
                            <button
                                className="connect-button"
                                onClick={() => setPlaying((value) => !value)}
                            >
                                {playing ? "Pause" : "Play"}
                            </button>

                            <input
                                type="range"
                                min={0}
                                max={timeline.length - 1}
                                value={stepIndex}
                                onChange={(event) => {
                                    setPlaying(false);
                                    setStepIndex(Number(event.target.value));
                                }}
                            />

                            <span className="label">
                                {stepIndex + 1} / {timeline.length}
                            </span>
                        </div>

                        <div className="timeline-log">
                            {timeline.map((entry, index) => (
                                <div
                                    key={`${entry.timestamp}-${index}`}
                                    className={`timeline-log-entry ${
                                        index === stepIndex ? "current" : ""
                                    }`}
                                    onClick={() => {
                                        setPlaying(false);
                                        setStepIndex(index);
                                    }}
                                >
                                    <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                                    <span className="timeline-log-stage">{entry.stage}</span>
                                    <span>{describeEntry(entry)}</span>
                                </div>
                            ))}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

function describeEntry(entry: TimelineEntry): string {
    switch (entry.source) {
        case "protocol":
            return describeProtocolEvent(entry.event as ProtocolEvent);
        case "transfer":
            return describeTransferEvent(entry.event as TransferEvent);
        case "sync":
            return describeSyncEvent(entry.event as SyncEvent);
        default:
            return "";
    }
}

function describeProtocolEvent(event: ProtocolEvent): string {
    switch (event.type) {
        case "DEVICE_DISCOVERED":
            return `Discovered peer device ${event.deviceId ?? ""}`;
        case "DISCOVER_SENT":
            return "Broadcast a discovery request";
        case "DISCOVER_RECEIVED":
            return "Received a discovery broadcast";
        case "DISCOVER_RESPONSE_SENT":
            return "Replied to a discovery broadcast";
        case "CONNECT_ATTEMPT":
            return `Attempting to connect to ${event.detail ?? event.deviceId ?? "peer"}`;
        case "CONNECT_REQUEST_SENT":
            return "Sent connection request";
        case "CONNECT_REQUEST_RECEIVED":
            return "Received connection request";
        case "CONNECT_ACCEPTED":
            return "Connection accepted — session established";
        case "CONNECT_REJECTED":
            return `Connection rejected${event.detail ? `: ${event.detail}` : ""}`;
        case "CONNECTION_CLOSED":
            return "Connection closed";
        case "MALFORMED_MESSAGE":
            return `Malformed message${event.detail ? `: ${event.detail}` : ""}`;
        default:
            return event.type;
    }
}

function describeTransferEvent(event: TransferEvent): string {
    switch (event.type) {
        case "TRANSFER_REQUESTED":
            return "File transfer requested (metadata exchange)";
        case "CHUNK_SENT":
            return `Sending chunk ${(event.chunkIndex ?? 0) + 1} of ${event.totalChunks}`;
        case "CHUNK_ACKED":
            return `Chunk ${(event.chunkIndex ?? 0) + 1} confirmed`;
        case "CHUNK_RETRY":
            return `Chunk ${(event.chunkIndex ?? 0) + 1} retried`;
        case "TRANSFER_PAUSED":
            return "Transfer paused";
        case "TRANSFER_RESUMED":
            return "Transfer resumed";
        case "TRANSFER_PROGRESS":
            return `Progress: ${event.chunksAcked}/${event.totalChunks} chunks`;
        case "TRANSFER_VERIFIED":
            return "Checksum verified";
        case "TRANSFER_COMPLETED":
            return "Transfer completed";
        default:
            return event.type;
    }
}

function describeSyncEvent(event: SyncEvent): string {
    switch (event.type) {
        case "PAIR_CREATED":
            return "Sync pair created";
        case "PAIR_REMOVED":
            return "Sync pair removed";
        case "SCAN_COMPLETE":
            return "Folder scan complete";
        case "FILE_QUEUED":
            return `Queued ${event.relativePath ?? "file"} for sync`;
        case "FILE_DELETED":
            return `Deleted ${event.relativePath ?? "file"}`;
        case "CONFLICT":
            return `Conflict detected on ${event.relativePath ?? "file"}`;
        default:
            return event.type;
    }
}
