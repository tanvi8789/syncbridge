const API_BASE_URL = "http://127.0.0.1:41235";

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
}

export interface TransferEvent {
    transferId: string;
    type:
        | "CHUNK_SENT"
        | "CHUNK_ACKED"
        | "CHUNK_RETRY"
        | "TRANSFER_PAUSED"
        | "TRANSFER_RESUMED"
        | "TRANSFER_PROGRESS";
    chunkIndex?: number;
    chunksAcked: number;
    totalChunks: number;
    bytesTransferred: number;
    fileSize: number;
    timestamp: number;
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
    const events = new EventSource(
        `${API_BASE_URL}/api/events`
    );

    events.addEventListener(
        "transfer-event",
        (message) => {
            try {
                onEvent(
                    JSON.parse(
                        (message as MessageEvent<string>).data
                    ) as TransferEvent
                );
            } catch {
                // Ignore a malformed event and keep the stream connected.
            }
        }
    );

    events.onerror = () => onError?.();

    return () => events.close();
}

export function subscribeToProtocolEvents(
    onEvent: (event: ProtocolEvent) => void,
    onError?: () => void
): () => void {
    const events = new EventSource(
        `${API_BASE_URL}/api/events`
    );

    events.addEventListener(
        "protocol-event",
        (message) => {
            try {
                onEvent(
                    JSON.parse(
                        (message as MessageEvent<string>).data
                    ) as ProtocolEvent
                );
            } catch {
                // Ignore a malformed event and keep the stream connected.
            }
        }
    );

    events.onerror = () => onError?.();

    return () => events.close();
}
