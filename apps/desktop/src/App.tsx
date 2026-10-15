import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type DragEvent as ReactDragEvent,
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
    getClipboard,
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    getPairing,
    cancelPairing,
    removeTrustedDevice,
    submitPairingPin,
    unlockTransfer,
    subscribeToPairingEvents,
    setClipboardEnabled,
    shareClipboard,
    subscribeToClipboardEvents,
    subscribeToProtocolEvents,
    subscribeToSyncEvents,
    subscribeToTransferEvents,
    syncNow,
    type ClipboardEvent as SyncClipboardEvent,
    type ClipboardState,
    type ConnectionInfo,
    type PairingPrompt,
    type SensitiveOptions,
    type TrustedDevice,
    type DeviceInfo,
    type DiscoveredDevice,
    type SessionSummary,
    type SyncEvent,
    type SyncPair,
    type Transfer,
    type TransferEvent,
    type ProtocolEvent,
} from "./api";

import {
    buildSyncActivity,
    SYNC_STATUS_LABEL,
} from "./sync-activity";

import { NetworkMap, type MapPeer, type PeerStatus } from "./NetworkMap";
import { ToastStack, type Toast, type ToastKind } from "./Toasts";
import { TransferCard } from "./TransferCard";
import { isLiveTransfer } from "./transfer-status";
import { formatBytes } from "./format";
import { PairingDialog } from "./PairingDialog";
import { SendOptionsDialog, UnlockDialog } from "./PinDialog";
import { TrustedDevices } from "./TrustedDevices";
import { AnalyticsDashboard } from "./AnalyticsDashboard";
import { TransferHistory } from "./TransferHistory";
import { TransferVisualizer } from "./TransferVisualizer";
import { SessionReplay } from "./ProtocolTimeline";


const MAX_SYNC_EVENTS = 200;
const VIEW_KEY = "syncbridge.view";
const THEME_KEY = "syncbridge.theme";

type ViewId =
    | "devices"
    | "transfers"
    | "sync"
    | "clipboard"
    | "protocol"
    | "analytics";

type ThemePref = "system" | "light" | "dark";

const NAV: Array<{ id: ViewId; label: string; title: string; subtitle: string }> = [
    {
        id: "devices",
        label: "Devices",
        title: "Devices",
        subtitle: "Machines on your network that are running SyncBridge.",
    },
    {
        id: "transfers",
        label: "Transfers",
        title: "Transfers",
        subtitle: "Send files, follow their progress and unlock sensitive ones.",
    },
    {
        id: "sync",
        label: "Folder sync",
        title: "Folder sync",
        subtitle: "Keep a folder identical on two devices.",
    },
    {
        id: "clipboard",
        label: "Clipboard",
        title: "Clipboard",
        subtitle: "Share copied text between connected devices.",
    },
    {
        id: "protocol",
        label: "Protocol",
        title: "Protocol",
        subtitle: "Every message exchanged with a peer, recorded and replayable.",
    },
    {
        id: "analytics",
        label: "Analytics",
        title: "Analytics",
        subtitle: "Throughput, latency and retries across saved transfers.",
    },
];

const THEME_OPTIONS: Array<{ id: ThemePref; label: string }> = [
    { id: "system", label: "System" },
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
];
const COLLAPSED_SECTIONS_KEY = "syncbridge.collapsedSections";

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

    const [pairingPrompts, setPairingPrompts] =
        useState<PairingPrompt[]>([]);

    const [trustedDevices, setTrustedDevices] =
        useState<TrustedDevice[]>([]);

    // Files waiting on the "is this sensitive?" question before sending.
    const [pendingSend, setPendingSend] =
        useState<{ deviceId: string; paths: string[] } | null>(null);

    const [unlockTransferId, setUnlockTransferId] =
        useState<string | null>(null);

    const [toasts, setToasts] =
        useState<Toast[]>([]);

    const toastId = useRef(0);

    const dismissToast = useCallback((id: number) => {
        setToasts((current) =>
            current.filter((toast) => toast.id !== id)
        );
    }, []);

    const notify = useCallback(
        (kind: ToastKind, message: string) => {
            const id = ++toastId.current;

            setToasts((current) =>
                current.some((toast) => toast.message === message)
                    ? current
                    : [...current.slice(-3), { id, kind, message }]
            );

            setTimeout(
                () => dismissToast(id),
                kind === "error" ? 7000 : 4000
            );
        },
        [dismissToast]
    );

    // Errors and notices from every handler surface as toasts.
    const setError = useCallback(
        (message: string | null) => {
            if (message) {
                notify("error", message);
            }
        },
        [notify]
    );

    const setClipboardNotice = useCallback(
        (message: string | null) => {
            if (message) {
                notify("info", message);
            }
        },
        [notify]
    );

    const [view, setView] =
        useState<ViewId>(() => {
            try {
                const saved = localStorage.getItem(VIEW_KEY);

                return NAV.some((item) => item.id === saved)
                    ? (saved as ViewId)
                    : "devices";
            } catch {
                return "devices";
            }
        });

    const [themePref, setThemePref] =
        useState<ThemePref>(() => {
            try {
                const saved = localStorage.getItem(THEME_KEY);

                return saved === "light" || saved === "dark"
                    ? saved
                    : "system";
            } catch {
                return "system";
            }
        });

    const [selectedPeerId, setSelectedPeerId] =
        useState<string | null>(null);

    const [zoneActive, setZoneActive] =
        useState(false);

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

    const [explainMode, setExplainMode] =
        useState<boolean>(() => {
            try {
                return localStorage.getItem("syncbridge.explainMode") === "1";
            } catch {
                return false;
            }
        });

    const [clipboard, setClipboard] =
        useState<ClipboardState | null>(null);

    const [clipboardBusy, setClipboardBusy] =
        useState(false);

    const [dragActive, setDragActive] =
        useState(false);

    const [pendingDropPaths, setPendingDropPaths] =
        useState<string[] | null>(null);

    const [syncEvents, setSyncEvents] =
        useState<SyncEvent[]>([]);

    /*
     * Bumped when a transfer reaches a terminal state. History and
     * analytics are read from a database rather than the live event
     * stream, so they need an explicit nudge to refetch.
     */
    const [historyVersion, setHistoryVersion] =
        useState(0);

    const [collapsedSections, setCollapsedSections] =
        useState<Record<string, boolean>>(() => {
            try {
                return JSON.parse(
                    localStorage.getItem(COLLAPSED_SECTIONS_KEY) ?? "{}"
                ) as Record<string, boolean>;
            } catch {
                return {};
            }
        });

    const toggleSection = useCallback((key: string) => {
        setCollapsedSections((current) => {
            const next = { ...current, [key]: !current[key] };

            try {
                localStorage.setItem(
                    COLLAPSED_SECTIONS_KEY,
                    JSON.stringify(next)
                );
            } catch {
                // Blocked storage — the section just won't
                // remember its state between launches.
            }

            return next;
        });
    }, []);

    const syncActivityByPair = useMemo(
        () => buildSyncActivity(syncEvents, transfers),
        [syncEvents, transfers]
    );

    /*
     * dragenter/dragleave fire for every child element the cursor
     * crosses, so a plain boolean flickers. Counting enters and
     * leaves keeps the overlay stable until the cursor really
     * leaves the window.
     */
    const dragDepth = useRef(0);

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
                    clipboardData,
                    pairingData,
                ] = await Promise.all([
                    getDevice(),
                    getDevices(),
                    getConnections(),
                    getTransfers(),
                    getSyncPairs(),
                    getSessions(),
                    getClipboard(),
                    getPairing(),
                ]);

                setDevice(deviceData);
                setDevices(devicesData);
                setConnections(connectionsData);
                setTransfers(transfersData);
                setSyncPairs(syncPairsData);
                setSessions(sessionsData);
                setClipboard(clipboardData);
                setPairingPrompts(pairingData.prompts);
                setTrustedDevices(pairingData.trusted);

                setApiOnline(true);
                setError(null);
            } catch {
                // The sidebar shows the engine as offline; a toast
                // every poll interval would only be noise.
                setApiOnline(false);
            }
        },
        [setError]
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

    useEffect(
        () =>
            subscribeToPairingEvents((event) => {
                if (event.type === "PAIRING_FAILED" && event.error) {
                    setError(`Pairing failed: ${event.error}`);
                }

                if (event.type === "PAIRED") {
                    notify(
                        "success",
                        `Paired with ${event.deviceName ?? "the device"}`
                    );
                }

                void loadData();
            }),
        [loadData, notify, setError]
    );

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

    /*
     * Folder sync is otherwise invisible: the pair row only ever
     * showed a status, so a sync looked like it went straight from
     * idle to done. These events are what name the individual files.
     */
    useEffect(
        () =>
            subscribeToSyncEvents((event: SyncEvent) => {
                if (event.relativePath) {
                    setSyncEvents((current) =>
                        [event, ...current].slice(0, MAX_SYNC_EVENTS)
                    );
                }

                /*
                 * A queued file means a transfer is about to appear,
                 * and a delete means one may have gone away, so pull
                 * the authoritative list. SCAN_COMPLETE fires every
                 * 5 s per pair and carries no file, so it's ignored.
                 */
                if (event.type !== "SCAN_COMPLETE") {
                    void getTransfers().then(setTransfers).catch(() => {});
                }
            }),
        []
    );

    /*
     * Progress is applied in place rather than refetching: these
     * arrive every 250 ms per active transfer, and a round trip per
     * event would swamp the API during a multi-file sync.
     */
    useEffect(
        () =>
            subscribeToTransferEvents((event: TransferEvent) => {
                if (
                    event.type === "TRANSFER_REQUESTED" ||
                    event.type === "TRANSFER_VERIFIED" ||
                    event.type === "TRANSFER_COMPLETED"
                ) {
                    void getTransfers().then(setTransfers).catch(() => {});

                    if (event.type === "TRANSFER_COMPLETED") {
                        /*
                         * The engine persists on a 1 s debounce, so
                         * give it a moment before asking for the
                         * row that was just written.
                         */
                        setTimeout(
                            () => setHistoryVersion((value) => value + 1),
                            1200
                        );
                    }

                    return;
                }

                setTransfers((current) =>
                    current.map((transfer) =>
                        transfer.transferId === event.transferId
                            ? {
                                  ...transfer,
                                  chunksAcked: event.chunksAcked,
                                  bytesTransferred: event.bytesTransferred,
                                  lastProgressAt: event.timestamp,
                              }
                            : transfer
                    )
                );
            }),
        []
    );

    useEffect(() => {
        try {
            localStorage.setItem(VIEW_KEY, view);
        } catch {
            // Blocked storage: the last view just isn't remembered.
        }
    }, [view]);

    useEffect(() => {
        const root = document.documentElement;

        if (themePref === "system") {
            root.removeAttribute("data-theme");
        } else {
            root.setAttribute("data-theme", themePref);
        }

        try {
            localStorage.setItem(THEME_KEY, themePref);
        } catch {
            // Blocked storage: the theme just isn't remembered.
        }
    }, [themePref]);

    useEffect(() => {
        try {
            localStorage.setItem(
                "syncbridge.explainMode",
                explainMode ? "1" : "0"
            );
        } catch {
            // Private mode or blocked storage — the toggle just
            // won't be remembered between launches.
        }
    }, [explainMode]);

    /*
     * An incoming clipboard is written to this machine's OS
     * clipboard as soon as it arrives, which is the whole point of
     * the feature. The main process records what it wrote so its
     * own watcher doesn't bounce it straight back.
     */
    useEffect(
        () =>
            subscribeToClipboardEvents(
                (event: SyncClipboardEvent) => {
                    if (event.type === "CLIPBOARD_RECEIVED") {
                        void (async () => {
                            const state = await getClipboard();
                            setClipboard(state);

                            const latest = state.latest;

                            if (
                                latest?.direction === "received" &&
                                window.electronAPI?.writeClipboard
                            ) {
                                await window.electronAPI.writeClipboard(
                                    latest.content
                                );
                            }

                            setClipboardNotice(
                                `Clipboard received from ${event.deviceId?.slice(0, 8) ?? "peer"}`
                            );
                        })();

                        return;
                    }

                    if (event.type === "CLIPBOARD_SENT") {
                        void getClipboard().then(setClipboard);
                        setClipboardNotice("Clipboard shared with peers");
                        return;
                    }

                    if (event.type === "CLIPBOARD_BLOCKED") {
                        setClipboardNotice(
                            event.detail ?? "Clipboard update blocked"
                        );
                    }
                }
            ),
        [setClipboardNotice]
    );

    const handleToggleClipboard = async () => {
        if (!clipboard) {
            return;
        }

        try {
            setClipboardBusy(true);
            setError(null);

            const next = !clipboard.enabled;

            await setClipboardEnabled(next);
            setClipboard(await getClipboard());
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Failed to change clipboard sharing"
            );
        } finally {
            setClipboardBusy(false);
        }
    };

    const handleShareClipboardNow = async () => {
        try {
            setClipboardBusy(true);
            setError(null);

            if (!window.electronAPI?.readClipboard) {
                setError(
                    "Clipboard access is not available. The preload script may not be loaded."
                );
                return;
            }

            const text = await window.electronAPI.readClipboard();

            if (!text) {
                setClipboardNotice("Clipboard is empty");
                return;
            }

            const result = await shareClipboard(text);

            setClipboardNotice(
                result.shared
                    ? `Shared with ${result.peers} peer(s)`
                    : "Nothing new to share. Peers already have this."
            );

            setClipboard(await getClipboard());
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Failed to share clipboard"
            );
        } finally {
            setClipboardBusy(false);
        }
    };

    const handleCopyEntry = async (content: string) => {
        if (!window.electronAPI?.writeClipboard) {
            return;
        }

        await window.electronAPI.writeClipboard(content);
        setClipboardNotice("Copied to this device's clipboard");
    };

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
                setError('File picker not available. The preload script may not be loaded.');
                return;
            }

            const filePath = await window.electronAPI.selectFile();

            if (!filePath) {
                return;
            }

            // Ask whether the file is sensitive before anything is sent.
            setPendingSend({ deviceId, paths: [filePath] });
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

    /**
     * Send one or more already-resolved absolute paths to a peer.
     * Shared by the drag-and-drop flow and the device chooser.
     */
    const sendPathsToDevice = async (
        deviceId: string,
        paths: string[],
        options?: SensitiveOptions
    ) => {
        try {
            setSendingDeviceId(deviceId);
            setError(null);

            for (const filePath of paths) {
                await startTransfer(deviceId, filePath, options);
            }

            await loadData();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Failed to start file transfer"
            );
        } finally {
            setSendingDeviceId(null);
            setPendingDropPaths(null);
            setPendingSend(null);
        }
    };

    const runTransferAction = async (
        action: (transferId: string) => Promise<unknown>,
        transferId: string
    ) => {
        try {
            await action(transferId);
            await loadData();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Transfer action failed"
            );
        }
    };

    /** "Send file" from the Transfers header: pick a file, then a device. */
    const handleSendFromHeader = async () => {
        const targets = Array.from(connectedDeviceIds);

        if (targets.length === 0) {
            setError("Connect to a device first.");
            return;
        }

        if (!window.electronAPI?.selectFile) {
            setError("File picker not available. The preload script may not be loaded.");
            return;
        }

        const filePath = await window.electronAPI.selectFile();

        if (!filePath) {
            return;
        }

        if (targets.length === 1) {
            setPendingSend({ deviceId: targets[0], paths: [filePath] });
        } else {
            setPendingDropPaths([filePath]);
        }
    };

    const handleSubmitPin = async (deviceId: string, pin: string) => {
        await submitPairingPin(deviceId, pin);
        await loadData();
    };

    const handleCancelPairing = async (deviceId: string) => {
        try {
            await cancelPairing(deviceId);
        } finally {
            await loadData();
        }
    };

    const handleForgetDevice = async (deviceId: string) => {
        try {
            await removeTrustedDevice(deviceId);
            await loadData();
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Failed to forget device"
            );
        }
    };

    const handleUnlock = async (pin: string) => {
        if (!unlockTransferId) {
            return;
        }

        await unlockTransfer(unlockTransferId, pin);
        setUnlockTransferId(null);
        notify("success", "File unlocked and saved");
        await loadData();
    };

    const deviceLabel = (deviceId: string) =>
        connections.find((connection) => connection.deviceId === deviceId)
            ?.deviceName ??
        devices.find((candidate) => candidate.deviceId === deviceId)
            ?.deviceName ??
        deviceId.slice(0, 8);

    const handleDragEnter = (
        event: ReactDragEvent<HTMLDivElement>
    ) => {
        if (!event.dataTransfer.types.includes("Files")) {
            return;
        }

        event.preventDefault();
        dragDepth.current += 1;
        setDragActive(true);
    };

    const handleDragOver = (
        event: ReactDragEvent<HTMLDivElement>
    ) => {
        if (!event.dataTransfer.types.includes("Files")) {
            return;
        }

        // Without this the browser navigates to the dropped file.
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
    };

    const handleDragLeave = (
        event: ReactDragEvent<HTMLDivElement>
    ) => {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);

        if (dragDepth.current === 0) {
            setDragActive(false);
        }
    };

    const endDrag = () => {
        dragDepth.current = 0;
        setDragActive(false);
    };

    /** Resolve dropped files to real paths; reports why if it can't. */
    const resolveDroppedPaths = (
        event: ReactDragEvent<HTMLElement>
    ): string[] | null => {
        const files = Array.from(event.dataTransfer.files);

        if (files.length === 0) {
            return null;
        }

        if (!window.electronAPI?.getPathForFile) {
            setError(
                "Drag and drop needs the desktop app. Open SyncBridge in Electron."
            );
            return null;
        }

        /*
         * Electron removed File.path in v32, so the real filesystem
         * path has to come from webUtils by way of the preload.
         */
        const paths = files
            .map((file) => {
                try {
                    return window.electronAPI.getPathForFile(file);
                } catch {
                    return "";
                }
            })
            .filter((filePath) => filePath.length > 0);

        if (paths.length === 0) {
            setError(
                "Could not resolve the dropped item. Folders are not supported yet, so drop files instead."
            );
            return null;
        }

        return paths;
    };

    /** Dropped straight onto one device's drop zone. */
    const handleZoneDrop = (
        event: ReactDragEvent<HTMLElement>,
        deviceId: string
    ) => {
        event.preventDefault();
        event.stopPropagation();
        endDrag();
        setZoneActive(false);

        const paths = resolveDroppedPaths(event);

        if (paths) {
            setPendingSend({ deviceId, paths });
        }
    };

    const handleDrop = (
        event: ReactDragEvent<HTMLDivElement>
    ) => {
        event.preventDefault();
        endDrag();

        const paths = resolveDroppedPaths(event);

        if (!paths) {
            return;
        }

        const targets = Array.from(connectedDeviceIds);

        if (targets.length === 0) {
            setError(
                "Connect to a device before dropping files onto the window."
            );
            return;
        }

        if (targets.length === 1) {
            setPendingSend({ deviceId: targets[0], paths });
            return;
        }

        // More than one peer is connected, so let the user pick.
        setPendingDropPaths(paths);
    };

    const handlePickSyncFolder = async () => {
        try {
            if (!window.electronAPI?.selectFolder) {
                setError(
                    "Folder picker not available. The preload script may not be loaded."
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

    const activeView = NAV.find((item) => item.id === view) ?? NAV[0];

    const peerStatus = (deviceId: string): PeerStatus => {
        if (connectedDeviceIds.has(deviceId)) {
            return "connected";
        }

        const pairing =
            pairingPrompts.some((prompt) => prompt.deviceId === deviceId) ||
            connections.some(
                (connection) =>
                    connection.deviceId === deviceId &&
                    (connection.state === "AWAITING_PIN" ||
                        connection.state === "CONNECTING")
            );

        return pairing ? "pairing" : "discovered";
    };

    const mapPeers: MapPeer[] = devices.map((peer) => ({
        deviceId: peer.deviceId,
        name: peer.deviceName,
        status: peerStatus(peer.deviceId),
    }));

    const activePeer =
        devices.find((peer) => peer.deviceId === selectedPeerId) ??
        devices[0] ??
        null;

    const activePeerStatus = activePeer
        ? peerStatus(activePeer.deviceId)
        : null;

    const activePeerTrusted = activePeer
        ? trustedDevices.some((entry) => entry.deviceId === activePeer.deviceId)
        : false;

    const activePeerConnection = activePeer
        ? connections.find((connection) => connection.deviceId === activePeer.deviceId)
        : undefined;

    const liveTransfers = transfers.filter(isLiveTransfer);
    const finishedTransfers = transfers.filter((transfer) => !isLiveTransfer(transfer));

    const navCount = (id: ViewId): string | undefined => {
        switch (id) {
            case "devices":
                return connectedDeviceIds.size > 0
                    ? `${connectedDeviceIds.size} online`
                    : undefined;
            case "transfers":
                return liveTransfers.length > 0
                    ? String(liveTransfers.length)
                    : undefined;
            case "sync":
                return syncPairs.length > 0 ? String(syncPairs.length) : undefined;
            default:
                return undefined;
        }
    };

    const renderTransferCard = (transfer: Transfer) => (
        <TransferCard
            key={transfer.transferId}
            transfer={transfer}
            peerName={deviceLabel(transfer.peerDeviceId)}
            syncPairName={
                transfer.syncPairId
                    ? (syncPairs.find((pair) => pair.pairId === transfer.syncPairId)
                          ?.name ?? "unknown pair")
                    : undefined
            }
            onOpen={() => setSelectedTransferId(transfer.transferId)}
            onPause={() => void runTransferAction(pauseTransfer, transfer.transferId)}
            onResume={() => void runTransferAction(resumeTransfer, transfer.transferId)}
            onCancel={() => void runTransferAction(cancelTransfer, transfer.transferId)}
            onUnlock={() => setUnlockTransferId(transfer.transferId)}
            onShowInFolder={window.electronAPI?.showInFolder}
        />
    );

    const renderDevices = () => (
        <>
            <div className="devices-layout">
                <section className="panel map-panel">
                    <div className="panel-header">
                        <h2>Nearby</h2>
                        <span className="muted">
                            {devices.length === 0
                                ? "Searching"
                                : `${devices.length} found`}
                        </span>
                    </div>

                    <NetworkMap
                        selfName={device?.deviceName ?? "This device"}
                        peers={mapPeers}
                        selectedId={activePeer?.deviceId ?? null}
                        onSelect={setSelectedPeerId}
                    />

                    <p className="map-hint">
                        {devices.length === 0
                            ? "Looking for other devices. Both machines need to be running SyncBridge on the same network."
                            : "Select a device to connect or send files."}
                    </p>
                </section>

                <aside className="panel inspector">
                    {activePeer && activePeerStatus ? (
                        <>
                            <div className="inspector-head">
                                <div>
                                    <h2>{activePeer.deviceName}</h2>
                                    <span className="muted">
                                        {activePeer.ip} / {activePeer.platform}
                                    </span>
                                </div>

                                <span className={`state-pill peer-${activePeerStatus}`}>
                                    {activePeerStatus === "connected"
                                        ? "Connected"
                                        : activePeerStatus === "pairing"
                                          ? "Pairing"
                                          : "Available"}
                                </span>
                            </div>

                            <dl className="facts">
                                <div>
                                    <dt>Trust</dt>
                                    <dd>
                                        {activePeerTrusted
                                            ? "Paired. No PIN needed."
                                            : "Not paired. A PIN is needed."}
                                    </dd>
                                </div>
                                <div>
                                    <dt>Device ID</dt>
                                    <dd className="mono">
                                        {activePeer.deviceId.slice(0, 8)}
                                    </dd>
                                </div>
                                {activePeerConnection?.sessionId && (
                                    <div>
                                        <dt>Session</dt>
                                        <dd className="mono">
                                            {activePeerConnection.sessionId.slice(0, 8)}
                                        </dd>
                                    </div>
                                )}
                                {activePeerConnection?.connectedAt && (
                                    <div>
                                        <dt>Connected since</dt>
                                        <dd>
                                            {new Date(
                                                activePeerConnection.connectedAt
                                            ).toLocaleTimeString()}
                                        </dd>
                                    </div>
                                )}
                            </dl>

                            {activePeerStatus === "connected" ? (
                                <>
                                    <div
                                        className={`dropzone${zoneActive ? " active" : ""}`}
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => void handleSendFile(activePeer.deviceId)}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter" || event.key === " ") {
                                                event.preventDefault();
                                                void handleSendFile(activePeer.deviceId);
                                            }
                                        }}
                                        onDragEnter={(event) => {
                                            if (event.dataTransfer.types.includes("Files")) {
                                                setZoneActive(true);
                                            }
                                        }}
                                        onDragOver={(event) => {
                                            if (event.dataTransfer.types.includes("Files")) {
                                                event.preventDefault();
                                                event.dataTransfer.dropEffect = "copy";
                                            }
                                        }}
                                        onDragLeave={() => setZoneActive(false)}
                                        onDrop={(event) =>
                                            handleZoneDrop(event, activePeer.deviceId)
                                        }
                                    >
                                        <strong>
                                            Drop files to send to {activePeer.deviceName}
                                        </strong>
                                        <span>or click to choose a file</span>
                                    </div>

                                    <div className="inspector-actions">
                                        <button
                                            className="btn btn-danger"
                                            onClick={() => void handleDisconnect(activePeer.deviceId)}
                                            disabled={disconnectingDeviceId === activePeer.deviceId}
                                        >
                                            {disconnectingDeviceId === activePeer.deviceId
                                                ? "Disconnecting"
                                                : "Disconnect"}
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <div className="inspector-actions">
                                    <button
                                        className="btn btn-primary"
                                        onClick={() => void handleConnect(activePeer.deviceId)}
                                        disabled={
                                            connectingDeviceId !== null ||
                                            activePeerStatus === "pairing"
                                        }
                                    >
                                        {connectingDeviceId === activePeer.deviceId ||
                                        activePeerStatus === "pairing"
                                            ? "Connecting"
                                            : activePeerTrusted
                                              ? "Connect"
                                              : "Pair and connect"}
                                    </button>
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="empty-state">
                            <strong>No device selected</strong>
                            <p>Devices that appear on your network will be listed here.</p>
                        </div>
                    )}
                </aside>
            </div>

            <div className="grid-2">
                <section className="panel">
                    <div className="panel-header">
                        <h2>This device</h2>
                    </div>

                    {device ? (
                        <dl className="facts">
                            <div>
                                <dt>Name</dt>
                                <dd>{device.deviceName}</dd>
                            </div>
                            <div>
                                <dt>Platform</dt>
                                <dd>{device.platform}</dd>
                            </div>
                            <div>
                                <dt>Device ID</dt>
                                <dd className="mono wrap">{device.deviceId}</dd>
                            </div>
                        </dl>
                    ) : (
                        <div className="skeleton-stack" aria-busy="true">
                            <div className="skeleton" />
                            <div className="skeleton" />
                            <div className="skeleton short" />
                        </div>
                    )}
                </section>

                <section className="panel">
                    <div className="panel-header">
                        <h2>Paired devices</h2>
                        <span className="muted">{trustedDevices.length}</span>
                    </div>

                    <TrustedDevices
                        devices={trustedDevices}
                        onForget={handleForgetDevice}
                    />
                </section>
            </div>
        </>
    );

    const renderTransfers = () => (
        <>
            <section className="panel">
                <div className="panel-header">
                    <h2>In progress</h2>
                    <span className="muted">{liveTransfers.length}</span>
                </div>

                {liveTransfers.length === 0 ? (
                    <div className="empty-state compact">
                        <strong>Nothing is transferring</strong>
                        <p>
                            Drop a file on a connected device in the Devices view,
                            or choose Send file above.
                        </p>
                    </div>
                ) : (
                    <div className="transfer-list">
                        {liveTransfers.map(renderTransferCard)}
                    </div>
                )}
            </section>

            {finishedTransfers.length > 0 && (
                <section className="panel">
                    <div className="panel-header">
                        <h2>This session</h2>
                        <span className="muted">{finishedTransfers.length}</span>
                    </div>

                    <div className="transfer-list">
                        {finishedTransfers.map(renderTransferCard)}
                    </div>
                </section>
            )}

            <TransferHistory explainMode={explainMode} refreshKey={historyVersion} />
        </>
    );

    const renderSync = () => (
        <>
            <section className="panel">
                <div className="panel-header">
                    <h2>Synced folders</h2>
                    <span className="muted">{syncPairs.length}</span>
                </div>

                {syncPairs.length === 0 ? (
                    <div className="empty-state compact">
                        <strong>No synced folders yet</strong>
                        <p>
                            Choose a local folder and a connected device below. Changes
                            on either side are copied to the other.
                        </p>
                    </div>
                ) : (
                    <div className="sync-pair-list">
                        {syncPairs.map((pair) => {
                            const files = syncActivityByPair.get(pair.pairId) ?? [];

                            const activeCount = files.filter(
                                (file) =>
                                    file.status === "transferring" ||
                                    file.status === "queued"
                            ).length;

                            const filesKey = `sync:${pair.pairId}`;
                            const filesCollapsed = collapsedSections[filesKey] === true;

                            return (
                                <div className="sync-pair-card" key={pair.pairId}>
                                    <div className="sync-pair-row">
                                        <div className="sync-pair-info">
                                            <strong>{pair.name}</strong>
                                            <span className="mono small">{pair.localFolder}</span>
                                            <span className="muted">
                                                With {deviceLabel(pair.peerDeviceId)}
                                                {pair.lastSyncAt &&
                                                    ` · last synced ${new Date(pair.lastSyncAt).toLocaleTimeString()}`}
                                            </span>
                                        </div>

                                        <div className="row-actions">
                                            <span className="state-pill">{pair.status}</span>

                                            <button
                                                className="btn btn-sm"
                                                disabled={syncingPairId === pair.pairId}
                                                onClick={() => void handleSyncNow(pair.pairId)}
                                            >
                                                {syncingPairId === pair.pairId ? "Syncing" : "Sync now"}
                                            </button>

                                            <button
                                                className="btn btn-sm btn-danger"
                                                disabled={removingPairId === pair.pairId}
                                                onClick={() => void handleRemoveSyncPair(pair.pairId)}
                                            >
                                                {removingPairId === pair.pairId ? "Removing" : "Unpair"}
                                            </button>
                                        </div>
                                    </div>

                                    <div className="sync-files">
                                        <button
                                            type="button"
                                            className="btn btn-ghost btn-sm"
                                            aria-expanded={!filesCollapsed}
                                            onClick={() => toggleSection(filesKey)}
                                        >
                                            {filesCollapsed ? "Show" : "Hide"}{" "}
                                            {files.length === 0
                                                ? "activity"
                                                : `${files.length} file${files.length === 1 ? "" : "s"}`}
                                            {activeCount > 0 && ` (${activeCount} in progress)`}
                                        </button>

                                        {!filesCollapsed && files.length === 0 && (
                                            <p className="sync-files-empty">
                                                Files appear here as they are scanned, sent and
                                                received. The folder is rescanned every 5 seconds.
                                            </p>
                                        )}

                                        {!filesCollapsed && files.length > 0 && (
                                            <ul className="sync-file-list">
                                                {files.map((file) => {
                                                    const percent =
                                                        file.fileSize &&
                                                        file.fileSize > 0 &&
                                                        file.bytesTransferred !== undefined
                                                            ? Math.min(
                                                                  100,
                                                                  Math.round(
                                                                      (file.bytesTransferred /
                                                                          file.fileSize) *
                                                                          100
                                                                  )
                                                              )
                                                            : undefined;

                                                    return (
                                                        <li className="sync-file-row" key={file.relativePath}>
                                                            <span className="direction-label">
                                                                {file.direction === "received"
                                                                    ? "In"
                                                                    : file.direction === "sent"
                                                                      ? "Out"
                                                                      : "Scan"}
                                                            </span>

                                                            <div className="sync-file-main">
                                                                <span
                                                                    className="sync-file-path mono"
                                                                    title={file.relativePath}
                                                                >
                                                                    {file.relativePath}
                                                                </span>

                                                                <span className="sync-file-meta">
                                                                    {file.fileSize !== undefined &&
                                                                        formatBytes(file.fileSize)}
                                                                    {file.status === "transferring" &&
                                                                        percent !== undefined &&
                                                                        ` · ${percent}% · ${file.chunksAcked ?? 0}/${file.totalChunks ?? 0} chunks`}
                                                                    {file.timestamp > 0 &&
                                                                        ` · ${new Date(file.timestamp).toLocaleTimeString()}`}
                                                                </span>

                                                                {file.status === "transferring" &&
                                                                    percent !== undefined && (
                                                                        <div className="progress thin">
                                                                            <div
                                                                                className="progress-fill active"
                                                                                style={{ width: `${percent}%` }}
                                                                            />
                                                                        </div>
                                                                    )}
                                                            </div>

                                                            <span
                                                                className={`sync-file-status status-${file.status}`}
                                                            >
                                                                {SYNC_STATUS_LABEL[file.status]}
                                                            </span>
                                                        </li>
                                                    );
                                                })}
                                            </ul>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>

            <section className="panel">
                <div className="panel-header">
                    <h2>New sync pair</h2>
                </div>

                <div className="sync-form">
                    <label className="field">
                        <span>Folder</span>
                        <div className="field-row">
                            <button className="btn" onClick={() => void handlePickSyncFolder()}>
                                {syncFolder ? "Change" : "Choose folder"}
                            </button>
                            <span className="mono small truncate">
                                {syncFolder ?? "No folder chosen"}
                            </span>
                        </div>
                    </label>

                    <label className="field">
                        <span>Name</span>
                        <input
                            className="input"
                            type="text"
                            placeholder="Documents"
                            value={syncName}
                            onChange={(event) => setSyncName(event.target.value)}
                        />
                    </label>

                    <label className="field">
                        <span>Device</span>
                        <select
                            className="input"
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
                    </label>

                    <div className="form-actions">
                        <button
                            className="btn btn-primary"
                            disabled={creatingSyncPair}
                            onClick={() => void handleCreateSyncPair()}
                        >
                            {creatingSyncPair ? "Creating" : "Create sync pair"}
                        </button>
                    </div>
                </div>
            </section>
        </>
    );

    const renderClipboard = () => (
        <section className="panel">
            <div className="panel-header">
                <h2>Shared clipboard</h2>

                <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(clipboard?.enabled)}
                    aria-label="Clipboard sharing"
                    className={`switch${clipboard?.enabled ? " on" : ""}`}
                    disabled={!clipboard || clipboardBusy}
                    onClick={() => void handleToggleClipboard()}
                >
                    <span className="switch-knob" />
                </button>
            </div>

            <p className="panel-lede">
                Text you copy is shared with every connected device, and anything
                they copy lands on your clipboard.
            </p>

            <div className="form-actions start">
                <button
                    className="btn btn-primary"
                    disabled={clipboardBusy || !clipboard?.enabled}
                    onClick={() => void handleShareClipboardNow()}
                >
                    Share clipboard now
                </button>
            </div>

            {!clipboard || clipboard.history.length === 0 ? (
                <div className="empty-state compact">
                    <strong>Nothing shared yet</strong>
                    <p>Copy some text on either device and it will show up here.</p>
                </div>
            ) : (
                <div className="clipboard-list">
                    {clipboard.history.slice(0, 8).map((entry) => (
                        <div className="list-row" key={entry.clipboardId}>
                            <span className="direction-label">
                                {entry.direction === "received" ? "In" : "Out"}
                            </span>

                            <div className="list-row-main">
                                <span className="clipboard-preview">
                                    {entry.content.length > 140
                                        ? `${entry.content.slice(0, 140)}...`
                                        : entry.content}
                                </span>

                                <span className="muted small">
                                    {entry.direction === "received"
                                        ? `From ${deviceLabel(entry.origin)}`
                                        : "Shared by you"}
                                    {" · "}
                                    {formatBytes(entry.length)}
                                    {" · "}
                                    {new Date(entry.timestamp).toLocaleTimeString()}
                                </span>
                            </div>

                            <button
                                className="btn btn-sm"
                                onClick={() => void handleCopyEntry(entry.content)}
                            >
                                Copy
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );

    const renderProtocol = () => (
        <>
            <section className="panel">
                <div className="panel-header">
                    <h2>Recorded sessions</h2>
                    <span className="muted">{sessions.length}</span>
                </div>

                {sessions.length === 0 ? (
                    <div className="empty-state compact">
                        <strong>No sessions yet</strong>
                        <p>
                            Connect to a device and every message of the session is
                            recorded here for replay.
                        </p>
                    </div>
                ) : (
                    <div className="session-list">
                        {sessions.map((session) => (
                            <button
                                type="button"
                                className="list-row clickable"
                                key={session.sessionId}
                                onClick={() => setOpenSessionId(session.sessionId)}
                            >
                                <div className="list-row-main">
                                    <strong>{deviceLabel(session.peerDeviceId)}</strong>
                                    <span className="muted small">
                                        {new Date(session.startedAt).toLocaleString()}
                                        {session.endedAt
                                            ? ` to ${new Date(session.endedAt).toLocaleTimeString()}`
                                            : ", ongoing"}
                                    </span>
                                </div>

                                <span
                                    className={`state-pill session-${session.status}`}
                                >
                                    {session.status}
                                </span>
                            </button>
                        ))}
                    </div>
                )}
            </section>

            <section className="panel">
                <div className="panel-header">
                    <h2>Live activity</h2>
                    <span className="muted">Latest {protocolEvents.length}</span>
                </div>

                {protocolEvents.length === 0 ? (
                    <div className="empty-state compact">
                        <strong>No activity yet</strong>
                        <p>Discovery and connection events appear here as they happen.</p>
                    </div>
                ) : (
                    <div className="event-list">
                        {protocolEvents.map((event) => (
                            <div className="event-row" key={event.id}>
                                <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
                                <strong>{event.type}</strong>
                                <span>{event.detail || event.deviceId || event.layer}</span>
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </>
    );

    return (
        <div
            className={`shell${dragActive ? " drag-active" : ""}`}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            <aside className="sidebar">
                <div className="brand">
                    <strong>SyncBridge</strong>
                    <span title={device?.deviceName}>
                        {device?.deviceName ?? "Starting"}
                    </span>
                </div>

                <nav className="nav" aria-label="Sections">
                    {NAV.map((item) => {
                        const count = navCount(item.id);

                        return (
                            <button
                                key={item.id}
                                type="button"
                                className={`nav-item${view === item.id ? " active" : ""}`}
                                aria-current={view === item.id ? "page" : undefined}
                                onClick={() => setView(item.id)}
                            >
                                <span>{item.label}</span>
                                {count && <span className="nav-count">{count}</span>}
                            </button>
                        );
                    })}
                </nav>

                <div className="sidebar-foot">
                    <div className={`engine-status ${apiOnline ? "online" : "offline"}`}>
                        <span className="dot" />
                        {apiOnline ? "Engine running" : "Engine offline"}
                    </div>

                    <div className="foot-row">
                        <span>Explain mode</span>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={explainMode}
                            aria-label="Explain mode"
                            className={`switch${explainMode ? " on" : ""}`}
                            onClick={() => setExplainMode((value) => !value)}
                        >
                            <span className="switch-knob" />
                        </button>
                    </div>

                    <div className="segmented" role="group" aria-label="Theme">
                        {THEME_OPTIONS.map((option) => (
                            <button
                                key={option.id}
                                type="button"
                                className={themePref === option.id ? "on" : ""}
                                aria-pressed={themePref === option.id}
                                onClick={() => setThemePref(option.id)}
                            >
                                {option.label}
                            </button>
                        ))}
                    </div>
                </div>
            </aside>

            <div className="content">
                <header className="page-header">
                    <div>
                        <h1>{activeView.title}</h1>
                        <p>{activeView.subtitle}</p>
                    </div>

                    {view === "transfers" && (
                        <button
                            className="btn btn-primary"
                            onClick={() => void handleSendFromHeader()}
                        >
                            Send file
                        </button>
                    )}
                </header>

                <main className="page" key={view}>
                    {view === "devices" && renderDevices()}
                    {view === "transfers" && renderTransfers()}
                    {view === "sync" && renderSync()}
                    {view === "clipboard" && renderClipboard()}
                    {view === "protocol" && renderProtocol()}
                    {view === "analytics" && (
                        <AnalyticsDashboard
                            explainMode={explainMode}
                            refreshKey={historyVersion}
                        />
                    )}
                </main>
            </div>

            {dragActive && (
                <div className="drop-banner" aria-hidden="true">
                    <strong>Drop to send</strong>
                    <span>
                        {connectedDeviceIds.size === 0
                            ? "Connect to a device first"
                            : connectedDeviceIds.size === 1
                              ? "Goes to your connected device"
                              : "You will choose which device"}
                    </span>
                </div>
            )}

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
                        explainMode={explainMode}
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

                return (
                    <SessionReplay
                        sessionId={openSessionId}
                        peerLabel={deviceLabel(session.peerDeviceId)}
                        explainMode={explainMode}
                        onClose={() => setOpenSessionId(null)}
                    />
                );
            })()}

            {pairingPrompts[0] && (
                <PairingDialog
                    // A wrong guess changes attemptsLeft, which remounts the dialog with an empty field.
                    key={`${pairingPrompts[0].kind}-${pairingPrompts[0].deviceId}-${pairingPrompts[0].attemptsLeft}`}
                    prompt={pairingPrompts[0]}
                    onSubmit={handleSubmitPin}
                    onCancel={handleCancelPairing}
                />
            )}

            {pendingSend && (
                <SendOptionsDialog
                    fileCount={pendingSend.paths.length}
                    deviceLabel={deviceLabel(pendingSend.deviceId)}
                    busy={sendingDeviceId !== null}
                    onCancel={() => setPendingSend(null)}
                    onConfirm={(options) =>
                        void sendPathsToDevice(
                            pendingSend.deviceId,
                            pendingSend.paths,
                            options
                        )
                    }
                />
            )}

            {unlockTransferId && (
                <UnlockDialog
                    onUnlock={handleUnlock}
                    onCancel={() => setUnlockTransferId(null)}
                />
            )}

            {pendingDropPaths && (
                <div
                    className="modal-overlay"
                    onClick={() => setPendingDropPaths(null)}
                >
                    <div
                        className="modal modal-narrow"
                        role="dialog"
                        aria-modal="true"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className="modal-header">
                            <div>
                                <strong>
                                    Send {pendingDropPaths.length} file
                                    {pendingDropPaths.length === 1 ? "" : "s"}
                                </strong>
                                <span className="modal-subtitle">
                                    Choose a connected device
                                </span>
                            </div>

                            <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => setPendingDropPaths(null)}
                            >
                                Cancel
                            </button>
                        </div>

                        <div className="chooser">
                            {Array.from(connectedDeviceIds).map((deviceId) => (
                                <button
                                    type="button"
                                    className="list-row clickable"
                                    key={deviceId}
                                    onClick={() => {
                                        setPendingSend({
                                            deviceId,
                                            paths: pendingDropPaths,
                                        });
                                        setPendingDropPaths(null);
                                    }}
                                >
                                    <div className="list-row-main">
                                        <strong>{deviceLabel(deviceId)}</strong>
                                        <span className="mono small">
                                            {deviceId.slice(0, 8)}
                                        </span>
                                    </div>
                                    <span className="muted">Select</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            <ToastStack toasts={toasts} onDismiss={dismissToast} />
        </div>
    );
}

export default App;
