const API_BASE_URL = "http://127.0.0.1:41235";

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
    state: string;
    remoteAddress?: string;
    remotePort?: number;
}

export interface Transfer {
    transferId: string;
    fileName: string;
    fileSize: number;
    totalChunks: number;
    state: string;
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
): Promise<{ success: boolean }> {
    return fetchApi<{ success: boolean }>(
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