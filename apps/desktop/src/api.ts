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
    endpoint: string
): Promise<T> {
    const response =
        await fetch(
            `${API_BASE_URL}${endpoint}`
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

export async function connectToDevice(
    deviceId: string
): Promise<void> {
    const response =
        await fetch(
            `${API_BASE_URL}/api/connections`,
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/json",
                },
                body: JSON.stringify({
                    deviceId,
                }),
            }
        );

    if (!response.ok) {
        const data =
            await response.json().catch(
                () => null
            );

        throw new Error(
            data?.error ??
                `Connection request failed: ${response.status}`
        );
    }
}