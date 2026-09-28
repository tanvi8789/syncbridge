import {
    useCallback,
    useEffect,
    useState,
} from "react";

import {
    connectToDevice,
    createSyncPair,
    disconnectDevice,
    getConnections,
    getDevice,
    getDevices,
    getSessions,
    getSyncPairs,
    getTransfers,
    removeSyncPair,
    startTransfer,
    subscribeToProtocolEvents,
    syncNow,
    type ConnectionInfo,
    type DeviceInfo,
    type DiscoveredDevice,
    type SessionSummary,
    type SyncPair,
    type Transfer,
    type ProtocolEvent,
} from "./api";

import { TransferVisualizer } from "./TransferVisualizer";
import { SessionReplay } from "./ProtocolTimeline";

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

    const [selectedTransferId, setSelectedTransferId] =
        useState<string | null>(null);

    const [syncPairs, setSyncPairs] =
        useState<SyncPair[]>([]);

    const [syncFolder, setSyncFolder] =
        useState<string | null>(null);

    const [syncName, setSyncName] =
        useState("");

    const [syncPeerId, setSyncPeerId] =
        useState("");

    const [creatingSyncPair, setCreatingSyncPair] =
        useState(false);

    const [syncingPairId, setSyncingPairId] =
        useState<string | null>(null);

    const [removingPairId, setRemovingPairId] =
        useState<string | null>(null);

    const [sessions, setSessions] =
        useState<SessionSummary[]>([]);

    const [openSessionId, setOpenSessionId] =
        useState<string | null>(null);

    const loadData = useCallback(
        async () => {
            try {
                const [
                    deviceData,
                    devicesData,
                    connectionsData,
                    transfersData,
                    syncPairsData,
                    sessionsData,
                ] = await Promise.all([
                    getDevice(),
                    getDevices(),
                    getConnections(),
                    getTransfers(),
                    getSyncPairs(),
                    getSessions(),
                ]);

                setDevice(deviceData);
                setDevices(devicesData);
                setConnections(connectionsData);
                setTransfers(transfersData);
                setSyncPairs(syncPairsData);
                setSessions(sessionsData);

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

    const handlePickSyncFolder = async () => {
        try {
            if (!window.electronAPI?.selectFolder) {
                setError(
                    "Folder picker not available – preload script may not be loaded."
                );
                return;
            }

            const folder = await window.electronAPI.selectFolder();

            if (folder) {
                setSyncFolder(folder);
            }
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Failed to select folder"
            );
        }
    };

    const handleCreateSyncPair = async () => {
        if (!syncFolder || !syncPeerId || !syncName.trim()) {
            setError(
                "Choose a folder, a peer, and a name to create a sync pair."
            );
            return;
        }

        try {
            setCreatingSyncPair(true);
            setError(null);

            await createSyncPair(
                syncPeerId,
                syncFolder,
                syncName.trim()
            );

            setSyncFolder(null);
            setSyncName("");
            setSyncPeerId("");

            await loadData();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Failed to create sync pair"
            );
        } finally {
            setCreatingSyncPair(false);
        }
    };

    const handleSyncNow = async (pairId: string) => {
        try {
            setSyncingPairId(pairId);
            setError(null);

            await syncNow(pairId);

            await loadData();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Failed to sync"
            );
        } finally {
            setSyncingPairId(null);
        }
    };

    const handleRemoveSyncPair = async (pairId: string) => {
        try {
            setRemovingPairId(pairId);
            setError(null);

            await removeSyncPair(pairId);

            await loadData();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Failed to remove sync pair"
            );
        } finally {
            setRemovingPairId(null);
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
                        <h2>Folder Sync</h2>

                        <span className="count">
                            {syncPairs.length}
                        </span>
                    </div>

                    {syncPairs.length === 0 ? (
                        <div className="empty-state compact">
                            <strong>No synced folders</strong>

                            <p>
                                Pair a local folder with a connected device to keep them in sync.
                            </p>
                        </div>
                    ) : (
                        <div className="sync-pair-list">
                            {syncPairs.map((pair) => (
                                <div className="sync-pair-row" key={pair.pairId}>
                                    <div className="sync-pair-info">
                                        <strong>{pair.name}</strong>

                                        <span className="mono" style={{ fontSize: "11px" }}>
                                            {pair.localFolder}
                                        </span>

                                        <span>
                                            Peer {pair.peerDeviceId.slice(0, 8)}
                                            {pair.lastSyncAt &&
                                                ` · Last synced ${new Date(pair.lastSyncAt).toLocaleTimeString()}`}
                                        </span>
                                    </div>

                                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                        <span className="state">{pair.status}</span>

                                        <button
                                            className="connect-button"
                                            disabled={syncingPairId === pair.pairId}
                                            onClick={() => handleSyncNow(pair.pairId)}
                                        >
                                            {syncingPairId === pair.pairId ? "Syncing..." : "Sync Now"}
                                        </button>

                                        <button
                                            className="disconnect-button"
                                            disabled={removingPairId === pair.pairId}
                                            onClick={() => handleRemoveSyncPair(pair.pairId)}
                                        >
                                            {removingPairId === pair.pairId ? "..." : "Unpair"}
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="sync-pair-form">
                        <button className="connect-button" onClick={handlePickSyncFolder}>
                            {syncFolder ? "Change Folder" : "Choose Folder"}
                        </button>

                        {syncFolder && (
                            <span className="mono" style={{ fontSize: "11px" }}>
                                {syncFolder}
                            </span>
                        )}

                        <input
                            className="sync-name-input"
                            type="text"
                            placeholder="Pair name (e.g. Documents)"
                            value={syncName}
                            onChange={(event) => setSyncName(event.target.value)}
                        />

                        <select
                            className="sync-peer-select"
                            value={syncPeerId}
                            onChange={(event) => setSyncPeerId(event.target.value)}
                        >
                            <option value="">Select a connected device</option>

                            {connections
                                .filter((connection) => connection.state === "CONNECTED")
                                .map((connection) => (
                                    <option key={connection.deviceId} value={connection.deviceId}>
                                        {connection.deviceName || connection.deviceId}
                                    </option>
                                ))}
                        </select>

                        <button
                            className="connect-button"
                            disabled={creatingSyncPair}
                            onClick={handleCreateSyncPair}
                        >
                            {creatingSyncPair ? "Creating..." : "Create Sync Pair"}
                        </button>
                    </div>
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
                        <h2>Protocol Timeline</h2>

                        <span className="count">
                            {sessions.length}
                        </span>
                    </div>

                    {sessions.length === 0 ? (
                        <div className="empty-state compact">
                            <strong>No sessions yet</strong>

                            <p>
                                Connect to a device to start recording a replayable session.
                            </p>
                        </div>
                    ) : (
                        <div className="session-list">
                            {sessions.map((session) => {
                                const peerLabel =
                                    connections.find((c) => c.deviceId === session.peerDeviceId)
                                        ?.deviceName ??
                                    devices.find((d) => d.deviceId === session.peerDeviceId)
                                        ?.deviceName ??
                                    session.peerDeviceId.slice(0, 8);

                                return (
                                    <div
                                        className="session-row"
                                        key={session.sessionId}
                                        onClick={() => setOpenSessionId(session.sessionId)}
                                    >
                                        <div className="sync-pair-info">
                                            <strong>{peerLabel}</strong>
                                            <span>
                                                {new Date(session.startedAt).toLocaleString()}
                                                {session.endedAt
                                                    ? ` – ${new Date(session.endedAt).toLocaleTimeString()}`
                                                    : " – ongoing"}
                                            </span>
                                        </div>

                                        <span
                                            className={`session-status-badge session-status-${session.status}`}
                                        >
                                            {session.status}
                                        </span>
                                    </div>
                                );
                            })}
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
                                        className="transfer-row transfer-row-clickable"
                                        key={
                                            transfer.transferId
                                        }
                                        onClick={() =>
                                            setSelectedTransferId(
                                                transfer.transferId
                                            )
                                        }
                                    >
                                        <div className="file-icon">
                                            {transfer.direction === "received" ? "↓" : "↑"}
                                        </div>

                                        <div className="transfer-info">
                                            <strong>
                                                {
                                                    transfer.fileName
                                                }

                                                {transfer.syncPairId && (
                                                    <span className="session-badge" style={{ marginLeft: "8px" }}>
                                                        Synced:{" "}
                                                        {syncPairs.find(
                                                            (pair) => pair.pairId === transfer.syncPairId
                                                        )?.name ?? "unknown pair"}
                                                    </span>
                                                )}
                                            </strong>

                                            <span>
                                                {transfer.direction === "received" ? "Received" : "Sent"}
                                                {" · "}
                                                {formatBytes(
                                                    transfer.fileSize
                                                )}{" "}
                                                ·{" "}
                                                {
                                                    transfer.totalChunks
                                                }{" "}
                                                chunks
                                            </span>

                                            {transfer.savedPath && (
                                                <span className="mono" style={{ fontSize: "11px" }}>
                                                    {transfer.savedPath}
                                                </span>
                                            )}
                                        </div>

                                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                            <span className="state">
                                                {
                                                    transfer.state
                                                }
                                            </span>

                                            {transfer.direction === "received" &&
                                                transfer.state === "COMPLETED" &&
                                                transfer.savedPath &&
                                                window.electronAPI?.showInFolder && (
                                                    <button
                                                        className="connect-button"
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            window.electronAPI.showInFolder(
                                                                transfer.savedPath!
                                                            );
                                                        }}
                                                    >
                                                        Show in Folder
                                                    </button>
                                                )}
                                        </div>
                                    </div>
                                )
                            )}
                        </div>
                    )}
                </section>
            </main>

            {selectedTransferId && (() => {
                const selectedTransfer = transfers.find(
                    (transfer) => transfer.transferId === selectedTransferId
                );

                if (!selectedTransfer) {
                    return null;
                }

                return (
                    <TransferVisualizer
                        transfer={selectedTransfer}
                        onClose={() => setSelectedTransferId(null)}
                    />
                );
            })()}

            {openSessionId && (() => {
                const session = sessions.find(
                    (candidate) => candidate.sessionId === openSessionId
                );

                if (!session) {
                    return null;
                }

                const peerLabel =
                    connections.find((c) => c.deviceId === session.peerDeviceId)
                        ?.deviceName ??
                    devices.find((d) => d.deviceId === session.peerDeviceId)
                        ?.deviceName ??
                    session.peerDeviceId.slice(0, 8);

                return (
                    <SessionReplay
                        sessionId={openSessionId}
                        peerLabel={peerLabel}
                        onClose={() => setOpenSessionId(null)}
                    />
                );
            })()}
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
