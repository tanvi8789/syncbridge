import {
    useCallback,
    useEffect,
    useState,
} from "react";

import {
    connectToDevice,
    disconnectDevice,
    getConnections,
    getDevice,
    getDevices,
    getTransfers,
    startTransfer,
    subscribeToProtocolEvents,
    type ConnectionInfo,
    type DeviceInfo,
    type DiscoveredDevice,
    type Transfer,
    type ProtocolEvent,
} from "./api";

import "./App.css";

function App() {
    const [device, setDevice] =
        useState<DeviceInfo | null>(null);

    const [devices, setDevices] =
        useState<DiscoveredDevice[]>([]);

    const [connections, setConnections] =
        useState<ConnectionInfo[]>([]);

    const [transfers, setTransfers] =
        useState<Transfer[]>([]);

    const [apiOnline, setApiOnline] =
        useState(false);

    const [error, setError] =
        useState<string | null>(null);

    const [connectingDeviceId, setConnectingDeviceId] =
        useState<string | null>(null);

    const [disconnectingDeviceId, setDisconnectingDeviceId] =
        useState<string | null>(null);

    const [sendingDeviceId, setSendingDeviceId] =
        useState<string | null>(null);

    const [protocolEvents, setProtocolEvents] =
        useState<ProtocolEvent[]>([]);

    const loadData = useCallback(
        async () => {
            try {
                const [
                    deviceData,
                    devicesData,
                    connectionsData,
                    transfersData,
                ] = await Promise.all([
                    getDevice(),
                    getDevices(),
                    getConnections(),
                    getTransfers(),
                ]);

                setDevice(deviceData);
                setDevices(devicesData);
                setConnections(connectionsData);
                setTransfers(transfersData);

                setApiOnline(true);
                setError(null);
            } catch (err) {
                setApiOnline(false);

                setError(
                    err instanceof Error
                        ? err.message
                        : "Unable to connect to API"
                );
            }
        },
        []
    );

    useEffect(() => {
        loadData();

        const interval =
            setInterval(
                loadData,
                10_000
            );

        return () =>
            clearInterval(
            interval
            );
    }, [loadData]);

    useEffect(() =>
        subscribeToProtocolEvents(
            (event) => {
                setProtocolEvents((current) =>
                    [event, ...current].slice(0, 12)
                );
                void loadData();
            },
            () => setApiOnline(false)
        ),
    [loadData]);

    const connectedDeviceIds =
        new Set(
            connections
                .filter(
                    (connection) =>
                        connection.state ===
                        "CONNECTED"
                )
                .map(
                    (connection) =>
                        connection.deviceId
                )
        );

    const handleConnect = async (
        deviceId: string
    ) => {
        try {
            setConnectingDeviceId(
                deviceId
            );

            setError(null);

            await connectToDevice(
                deviceId
            );

            await loadData();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Failed to connect to device"
            );
        } finally {
            setConnectingDeviceId(
                null
            );
        }
    };

    const handleDisconnect = async (
        deviceId: string
    ) => {
        try {
            setDisconnectingDeviceId(
                deviceId
            );
            setError(null);
            await disconnectDevice(
                deviceId
            );
            await loadData();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Failed to disconnect device"
            );
        } finally {
            setDisconnectingDeviceId(
                null
            );
        }
    };

    const handleSendFile = async (deviceId: string) => {
        try {
            setSendingDeviceId(deviceId);
            setError(null);

            // Guard against missing preload API
            if (!window.electronAPI?.selectFile) {
                setError('File picker not available – preload script may not be loaded.');
                return;
            }

            const filePath = await window.electronAPI.selectFile();

            if (!filePath) {
                return;
            }

            await startTransfer(
                deviceId,
                filePath
            );

            await loadData();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Failed to start file transfer"
            );
        } finally {
            setSendingDeviceId(null);
        }
    };

    

    return (
        <div className="app">
            <header className="header">
                <div>
                    <h1>SyncBridge</h1>

                    <p>
                        Peer-to-peer file
                        transfer
                    </p>
                </div>

                <div
                    className={`api-status ${
                        apiOnline
                            ? "online"
                            : "offline"
                    }`}
                >
                    <span className="status-dot" />

                    {apiOnline
                        ? "API Online"
                        : "API Offline"}
                </div>
            </header>

            {error && (
                <div className="error-banner">
                    {error}
                </div>
            )}

            <main className="dashboard">
                <section className="card device-card">
                    <div className="card-header">
                        <h2>My Device</h2>

                        <span className="online-badge">
                            ● ONLINE
                        </span>
                    </div>

                    {device ? (
                        <div className="device-details">
                            <div>
                                <span className="label">
                                    Device Name
                                </span>

                                <strong>
                                    {
                                        device.deviceName
                                    }
                                </strong>
                            </div>

                            <div>
                                <span className="label">
                                    Device ID
                                </span>

                                <strong className="mono">
                                    {
                                        device.deviceId
                                    }
                                </strong>
                            </div>

                            <div>
                                <span className="label">
                                    Platform
                                </span>

                                <strong>
                                    {
                                        device.platform
                                    }
                                </strong>
                            </div>
                        </div>
                    ) : (
                        <p className="empty">
                            Loading device
                            information...
                        </p>
                    )}
                </section>

                <section className="card">
                    <div className="card-header">
                        <h2>File Transfer Test</h2>
                    </div>

                    <button
                        className="connect-button"
                        onClick={async () => {
                            try {
                                // Guard against missing preload API
                                if (!window.electronAPI?.selectFile) {
                                    setError('File picker not available – preload may not be loaded.');
                                    return;
                                }
                                const filePath = await window.electronAPI.selectFile();

                                if (filePath) {
                                    setError(`Selected: ${filePath}`);
                                }
                            } catch (err) {
                                setError(err instanceof Error ? err.message : 'Failed to select file');
                            }
                        }}
                    >
                        Select File
                    </button>
                </section>

                <section className="card">
                    <div className="card-header">
                        <h2>
                            Discovered Devices
                        </h2>

                        <span className="count">
                            {devices.length}
                        </span>
                    </div>

                    {devices.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-icon">
                                ◌
                            </div>

                            <strong>
                                No devices
                                discovered
                            </strong>

                            <p>
                                SyncBridge is
                                searching the
                                local network.
                            </p>
                        </div>
                    ) : (
                        <div className="device-list">
                            {devices.map(
                                (peer) => {
                                    const connected =
                                        connectedDeviceIds.has(
                                            peer.deviceId
                                        );

                                    const connecting =
                                        connectingDeviceId ===
                                        peer.deviceId;

                                    const sending =
                                        sendingDeviceId ===
                                        peer.deviceId;

                                    return (
                                        <div
                                            className="device-row"
                                            key={
                                                peer.deviceId
                                            }
                                        >
                                            <div className="device-icon">
                                                {peer.platform ===
                                                "win32"
                                                    ? "⊞"
                                                    : "⌘"}
                                            </div>

                                            <div className="device-info">
                                                <strong>
                                                    {
                                                        peer.deviceName
                                                    }
                                                </strong>

                                                <span>
                                                    {
                                                        peer.ip
                                                    }{" "}
                                                    ·{" "}
                                                    {
                                                        peer.platform
                                                    }
                                                </span>
                                            </div>

                                            <div
                                                className={
                                                    connected
                                                        ? "connection-badge connected"
                                                        : "connection-badge"
                                                }
                                            >
                                                {connected
                                                    ? "CONNECTED"
                                                    : "DISCOVERED"}
                                            </div>

                                            {!connected && (
                                                <button
                                                    className="connect-button"
                                                    onClick={() =>
                                                        handleConnect(
                                                            peer.deviceId
                                                        )
                                                    }
                                                    disabled={
                                                        connecting ||
                                                        connectingDeviceId !==
                                                            null
                                                    }
                                                >
                                                    {connecting
                                                        ? "Connecting..."
                                                        : "Connect"}
                                                </button>
                                            )}

                                            {connected && (
                                                <div style={{ display: "flex", gap: "8px" }}>
                                                    <button
                                                        className="connect-button"
                                                        onClick={() =>
                                                            handleSendFile(
                                                                peer.deviceId
                                                            )
                                                        }
                                                        disabled={
                                                            sending
                                                        }
                                                    >
                                                        {sending
                                                            ? "Sending..."
                                                            : "Send File"}
                                                    </button>
                                                    <button
                                                        className="disconnect-button"
                                                        onClick={() =>
                                                            handleDisconnect(
                                                                peer.deviceId
                                                            )
                                                        }
                                                        disabled={
                                                            disconnectingDeviceId ===
                                                            peer.deviceId
                                                        }
                                                    >
                                                        {disconnectingDeviceId ===
                                                        peer.deviceId
                                                            ? "Disconnecting..."
                                                            : "Disconnect"}
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    );
                                }
                            )}
                        </div>
                    )}
                </section>

                <section className="card">
                    <div className="card-header">
                        <h2>Connections</h2>

                        <span className="count">
                            {
                                connections.length
                            }
                        </span>
                    </div>

                    {connections.length ===
                    0 ? (
                        <div className="empty-state compact">
                            <strong>
                                No active
                                connections
                            </strong>

                            <p>
                                Connected peers
                                will appear
                                here.
                            </p>
                        </div>
                    ) : (
                        <div className="connection-list">
                            {connections.map(
                                (
                                    connection
                                ) => (
                                    <div
                                        className="connection-row"
                                        key={
                                            connection.deviceId
                                        }
                                    >
                                        <span className="status-dot connected-dot" />

                                        <div>
                                            <strong className="mono">
                                                {connection.deviceName
                                                    ? `${connection.deviceName} (${connection.deviceId.slice(0, 8)})`
                                                    : connection.deviceId}
                                            </strong>

                                            <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "2px" }}>
                                                <span>
                                                    {connection.remoteAddress
                                                        ? `${connection.remoteAddress}:${connection.remotePort}`
                                                        : "LAN"}
                                                </span>
                                                {connection.sessionId && (
                                                    <span className="session-badge">
                                                        Session: {connection.sessionId.slice(0, 8)}
                                                    </span>
                                                )}
                                                {connection.connectedAt && (
                                                    <span>
                                                        · {new Date(connection.connectedAt).toLocaleTimeString()}
                                                    </span>
                                                )}
                                            </div>
                                            {connection.rejectReason && (
                                                <div style={{ color: "#a83232", fontSize: "11px", fontWeight: 600, marginTop: "2px" }}>
                                                    Error: {connection.rejectReason}
                                                </div>
                                            )}
                                        </div>

                                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                                            <span className="state">
                                                {connection.state}
                                            </span>
                                            {connection.state === "CONNECTED" && (
                                                <button
                                                    className="disconnect-button"
                                                    onClick={() =>
                                                        handleDisconnect(
                                                            connection.deviceId
                                                        )
                                                    }
                                                    disabled={
                                                        disconnectingDeviceId ===
                                                        connection.deviceId
                                                    }
                                                >
                                                    {disconnectingDeviceId ===
                                                    connection.deviceId
                                                        ? "..."
                                                        : "Disconnect"}
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                )
                            )}
                        </div>
                    )}
                </section>

                <section className="card">
                    <div className="card-header">
                        <h2>Connection Activity</h2>

                        <span className="count">
                            {protocolEvents.length}
                        </span>
                    </div>

                    {protocolEvents.length === 0 ? (
                        <div className="empty-state compact">
                            <strong>No activity yet</strong>

                            <p>
                                Discovery and connection events will appear here live.
                            </p>
                        </div>
                    ) : (
                        <div className="event-list">
                            {protocolEvents.map((event) => (
                                <div className="event-row" key={event.id}>
                                    <time>
                                        {new Date(event.timestamp).toLocaleTimeString()}
                                    </time>
                                    <strong>{event.type}</strong>
                                    <span>
                                        {event.detail || event.deviceId || event.layer}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </section>

                <section className="card">
                    <div className="card-header">
                        <h2>Transfers</h2>

                        <span className="count">
                            {transfers.length}
                        </span>
                    </div>

                    {transfers.length ===
                    0 ? (
                        <div className="empty-state compact">
                            <strong>
                                No active
                                transfers
                            </strong>

                            <p>
                                File transfers
                                will appear
                                here.
                            </p>
                        </div>
                    ) : (
                        <div className="transfer-list">
                            {transfers.map(
                                (transfer) => (
                                    <div
                                        className="transfer-row"
                                        key={
                                            transfer.transferId
                                        }
                                    >
                                        <div className="file-icon">
                                            ▱
                                        </div>

                                        <div className="transfer-info">
                                            <strong>
                                                {
                                                    transfer.fileName
                                                }
                                            </strong>

                                            <span>
                                                {formatBytes(
                                                    transfer.fileSize
                                                )}{" "}
                                                ·{" "}
                                                {
                                                    transfer.totalChunks
                                                }{" "}
                                                chunks
                                            </span>
                                        </div>

                                        <span className="state">
                                            {
                                                transfer.state
                                            }
                                        </span>
                                    </div>
                                )
                            )}
                        </div>
                    )}
                </section>
            </main>
        </div>
    );
}

function formatBytes(
    bytes: number
): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${(
            bytes / 1024
        ).toFixed(1)} KB`;
    }

    if (
        bytes <
        1024 * 1024 * 1024
    ) {
        return `${(
            bytes /
            (1024 * 1024)
        ).toFixed(1)} MB`;
    }

    return `${(
        bytes /
        (1024 * 1024 * 1024)
    ).toFixed(1)} GB`;
}

export default App;
