const API_BASE_URL = "http://127.0.0.1:41235";

/* ---------------------------------------------------------------
   Shared event stream
   ---------------------------------------------------------------
   The API multiplexes every event type over a single
   /api/events endpoint, tagged by event name, so the client opens
   exactly one EventSource and fans out from it.

   This matters more than it looks: an EventSource is a long-lived
   HTTP/1.1 connection that is never released, and browsers cap
   concurrent connections per origin at six. One stream per event
   type burned four of those permanently, which left too few
   sockets for the app's own parallel fetches and made whichever
   request lost the race hang forever.
   --------------------------------------------------------------- */

type StreamListener = (data: unknown) => void;

let sharedStream: EventSource | null = null;

const streamListeners = new Map<string, Set<StreamListener>>();
const streamErrorListeners = new Set<() => void>();

/** Event names already wired to the current stream. */
const attachedNames = new Set<string>();

function openSharedStream(): EventSource {
    if (sharedStream) {
        return sharedStream;
    }

    const source = new EventSource(`${API_BASE_URL}/api/events`);

    /*
     * Re-attach the names already subscribed. attachedNames is
     * cleared with the stream, so reopening after the last
     * unsubscribe starts from a clean slate.
     */
    for (const name of streamListeners.keys()) {
        attachStreamEvent(source, name);
    }

    source.onerror = () => {
        for (const listener of streamErrorListeners) {
            listener();
        }
    };

    sharedStream = source;

    return source;
}

function attachStreamEvent(source: EventSource, name: string): void {
    /*
     * Attaching the same name twice would deliver every event
     * twice — which, for a list keyed by event id, renders the
     * same key in React more than once.
     */
    if (attachedNames.has(name)) {
        return;
    }

    attachedNames.add(name);

    source.addEventListener(name, (message) => {
        let parsed: unknown;

        try {
            parsed = JSON.parse((message as MessageEvent<string>).data);
        } catch {
            // Ignore a malformed event and keep the stream connected.
            return;
        }

        for (const listener of streamListeners.get(name) ?? []) {
            listener(parsed);
        }
    });
}

function subscribeToStream<T>(
    eventName: string,
    onEvent: (event: T) => void,
    onError?: () => void
): () => void {
    const listener: StreamListener = (data) => onEvent(data as T);

    let listeners = streamListeners.get(eventName);

    if (!listeners) {
        listeners = new Set();
        streamListeners.set(eventName, listeners);
    }

    listeners.add(listener);

    if (onError) {
        streamErrorListeners.add(onError);
    }

    attachStreamEvent(openSharedStream(), eventName);

    return () => {
        listeners.delete(listener);

        if (onError) {
            streamErrorListeners.delete(onError);
        }

        /*
         * The last subscriber closes the stream, so a fully
         * unmounted UI doesn't hold a connection open.
         */
        const stillInUse = Array.from(streamListeners.values()).some(
            (set) => set.size > 0
        );

        if (!stillInUse && sharedStream) {
            sharedStream.close();
            sharedStream = null;
            streamListeners.clear();
            attachedNames.clear();
        }
    };
}

export interface ProtocolEvent {
    id: string;
    timestamp: number;
    type: string;
    layer: "discovery" | "connection" | "framing";
    deviceId?: string;
    sessionId?: string;
    detail?: string;
}

export interface DeviceInfo {
    deviceId: string;
    deviceName: string;
    platform: string;
}

export interface DiscoveredDevice {
    deviceId: string;
    deviceName: string;
    ip: string;
    platform: string;
    lastSeen?: number;
}

export interface ConnectionInfo {
    deviceId: string;
    deviceName?: string;
    state: string;
    sessionId?: string;
    remoteAddress?: string;
    remotePort?: number;
    connectedAt?: number;
    rejectReason?: string;
}

export interface Transfer {
    transferId: string;
    direction: "sent" | "received";
    peerDeviceId: string;
    fileName: string;
    fileSize: number;
    totalChunks: number;
    state: string;
    savedPath?: string;
    chunksAcked: number;
    bytesTransferred: number;
    retryCount: number;
    paused: boolean;
    startedAt?: number;
    lastProgressAt?: number;

    syncPairId?: string;
    relativePath?: string;
    sessionId?: string;
}

export interface SyncPair {
    pairId: string;
    name: string;
    peerDeviceId: string;
    localFolder: string;
    status: "PENDING" | "ACTIVE" | "REJECTED" | "REMOVED";
    createdAt: number;
    lastSyncAt?: number;
    sessionId?: string;
}

export interface SyncEvent {
    pairId: string;
    type:
        | "PAIR_CREATED"
        | "PAIR_REMOVED"
        | "SCAN_COMPLETE"
        | "FILE_QUEUED"
        | "FILE_DELETED"
        | "CONFLICT";
    relativePath?: string;
    timestamp: number;
    sessionId?: string;
}

export interface TransferEvent {
    transferId: string;
    type:
        | "CHUNK_SENT"
        | "CHUNK_ACKED"
        | "CHUNK_RETRY"
        | "TRANSFER_PAUSED"
        | "TRANSFER_RESUMED"
        | "TRANSFER_PROGRESS"
        | "TRANSFER_REQUESTED"
        | "TRANSFER_VERIFIED"
        | "TRANSFER_COMPLETED";
    chunkIndex?: number;
    chunksAcked: number;
    totalChunks: number;
    bytesTransferred: number;
    fileSize: number;
    timestamp: number;
    sessionId?: string;
}

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

async function fetchApi<T>(
    endpoint: string,
    options?: RequestInit
): Promise<T> {
    const response = await fetch(
        `${API_BASE_URL}${endpoint}`,
        options
    );

    if (!response.ok) {
        throw new Error(
            `API request failed: ${response.status}`
        );
    }

    return response.json() as Promise<T>;
}

export function getDevice(): Promise<DeviceInfo> {
    return fetchApi<DeviceInfo>(
        "/api/device"
    );
}

export function getDevices(): Promise<
    DiscoveredDevice[]
> {
    return fetchApi<DiscoveredDevice[]>(
        "/api/devices"
    );
}

export function getConnections(): Promise<
    ConnectionInfo[]
> {
    return fetchApi<ConnectionInfo[]>(
        "/api/connections"
    );
}

export function getTransfers(): Promise<
    Transfer[]
> {
    return fetchApi<Transfer[]>(
        "/api/transfers"
    );
}

export interface TransferRequest {
    deviceId: string;
    filePath: string;
}

export interface TransferResponse {
    transferId: string;
}

export function requestTransfer(
    request: TransferRequest
): Promise<TransferResponse> {
    return fetchApi<TransferResponse>(
        "/api/transfers",
        {
            method: "POST",
            headers: {
                "Content-Type":
                    "application/json",
            },
            body: JSON.stringify(request),
        }
    );
}

export function connectToDevice(
    deviceId: string
): Promise<{ status: string; deviceId: string }> {
    return fetchApi<{ status: string; deviceId: string }>(
        "/api/connections",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                deviceId,
            }),
        }
    );
}

export function disconnectDevice(
    deviceId: string
): Promise<{ status: string; deviceId: string }> {
    return fetchApi<{ status: string; deviceId: string }>(
        "/api/connections",
        {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                deviceId,
            }),
        }
    );
}

export function startTransfer(
    deviceId: string,
    filePath: string
): Promise<TransferResponse> {
    return fetchApi<TransferResponse>(
        "/api/transfers",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                deviceId,
                filePath,
            }),
        }
    );
}

export function pauseTransfer(
    transferId: string
): Promise<{ status: string; transferId: string }> {
    return fetchApi(
        `/api/transfers/${transferId}/pause`,
        { method: "POST" }
    );
}

export function resumeTransfer(
    transferId: string
): Promise<{ status: string; transferId: string }> {
    return fetchApi(
        `/api/transfers/${transferId}/resume`,
        { method: "POST" }
    );
}

export function cancelTransfer(
    transferId: string
): Promise<{ status: string; transferId: string }> {
    return fetchApi(
        `/api/transfers/${transferId}/cancel`,
        { method: "POST" }
    );
}

export function subscribeToTransferEvents(
    onEvent: (event: TransferEvent) => void,
    onError?: () => void
): () => void {
    return subscribeToStream<TransferEvent>("transfer-event", onEvent, onError);
}

export function getSyncPairs(): Promise<SyncPair[]> {
    return fetchApi<SyncPair[]>(
        "/api/sync-pairs"
    );
}

export function createSyncPair(
    peerDeviceId: string,
    localFolder: string,
    name: string
): Promise<SyncPair> {
    return fetchApi<SyncPair>(
        "/api/sync-pairs",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                peerDeviceId,
                localFolder,
                name,
            }),
        }
    );
}

export function removeSyncPair(
    pairId: string
): Promise<{ status: string; pairId: string }> {
    return fetchApi(
        `/api/sync-pairs/${pairId}`,
        { method: "DELETE" }
    );
}

export function syncNow(
    pairId: string
): Promise<{ status: string; pairId: string }> {
    return fetchApi(
        `/api/sync-pairs/${pairId}/sync-now`,
        { method: "POST" }
    );
}

export function subscribeToSyncEvents(
    onEvent: (event: SyncEvent) => void,
    onError?: () => void
): () => void {
    return subscribeToStream<SyncEvent>("sync-event", onEvent, onError);
}

export function subscribeToProtocolEvents(
    onEvent: (event: ProtocolEvent) => void,
    onError?: () => void
): () => void {
    return subscribeToStream<ProtocolEvent>("protocol-event", onEvent, onError);
}

export function getSessions(): Promise<SessionSummary[]> {
    return fetchApi<SessionSummary[]>(
        "/api/sessions"
    );
}

export function getSessionTimeline(
    sessionId: string
): Promise<TimelineEntry[]> {
    return fetchApi<TimelineEntry[]>(
        `/api/sessions/${sessionId}/timeline`
    );
}

// -------------------------
// Shared clipboard
// -------------------------

export type ClipboardEventType =
    | "CLIPBOARD_SENT"
    | "CLIPBOARD_RECEIVED"
    | "CLIPBOARD_BLOCKED";

export interface ClipboardEvent {
    id: string;
    type: ClipboardEventType;
    deviceId?: string;
    preview: string;
    length: number;
    timestamp: number;
    sessionId?: string;
    detail?: string;
}

export interface ClipboardEntry {
    clipboardId: string;
    origin: string;
    direction: "sent" | "received";
    content: string;
    contentHash: string;
    length: number;
    timestamp: number;
}

export interface ClipboardState {
    enabled: boolean;
    latest: ClipboardEntry | null;
    history: ClipboardEntry[];
}

export function getClipboard(): Promise<ClipboardState> {
    return fetchApi<ClipboardState>("/api/clipboard");
}

export function shareClipboard(
    content: string
): Promise<{
    shared: boolean;
    peers: number;
    latest: ClipboardEntry | null;
}> {
    return fetchApi("/api/clipboard", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ content }),
    });
}

export function setClipboardEnabled(
    enabled: boolean
): Promise<{ enabled: boolean }> {
    return fetchApi("/api/clipboard/enabled", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled }),
    });
}

export function subscribeToClipboardEvents(
    onEvent: (event: ClipboardEvent) => void,
    onError?: () => void
): () => void {
    return subscribeToStream<ClipboardEvent>("clipboard-event", onEvent, onError);
}

// -------------------------
// Session export
// -------------------------

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
    device: DeviceInfo;
    stats: SessionExportStats;
    timeline: TimelineEntry[];
}

export function getSessionExport(
    sessionId: string
): Promise<SessionExport> {
    return fetchApi<SessionExport>(
        `/api/sessions/${sessionId}/export`
    );
}

/* ---------------------------------------------------------------
   Saved transfer history and analytics
   --------------------------------------------------------------- */

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
    throughputBps?: number;

    rttAvgMs?: number;
    rttMinMs?: number;
    rttMaxMs?: number;
    rttSamples?: number;
}

export interface HistoryPage {
    transfers: HistoryTransfer[];
    total: number;
    limit: number;
    offset: number;
}

export interface HistoryQuery {
    limit?: number;
    offset?: number;
    since?: number;
    peerDeviceId?: string;
    direction?: "sent" | "received";
    search?: string;
}

export interface AnalyticsPeer {
    peerDeviceId: string;
    peerDeviceName?: string;
    transfers: number;
    bytes: number;
    avgThroughputBps?: number;
}

export interface AnalyticsBucket {
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

export function getHistory(
    query: HistoryQuery = {}
): Promise<HistoryPage> {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== "") {
            params.set(key, String(value));
        }
    }

    const suffix = params.toString();

    return fetchApi<HistoryPage>(
        `/api/history/transfers${suffix ? `?${suffix}` : ""}`
    );
}

export function getAnalytics(since?: number): Promise<Analytics> {
    return fetchApi<Analytics>(
        `/api/analytics${since !== undefined ? `?since=${since}` : ""}`
    );
}

export function clearHistory(): Promise<{ status: string }> {
    return fetchApi("/api/history", { method: "DELETE" });
}
