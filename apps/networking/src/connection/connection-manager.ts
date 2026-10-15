import net from "node:net";
import { randomUUID } from "node:crypto";

import { MessageType } from "../message-types";
import type {
    ConnectRequest,
    ConnectAccept,
    ConnectReject,
    ConnectRejectReason,
} from "../connection-messages";
import type {
    ConnectChallenge,
    PairProof,
    PairRetry,
    PairingEventListener,
    PairingMode,
    PairingPrompt,
} from "../pairing/pairing-messages";
import {
    PAIRING_MAX_ATTEMPTS,
    PAIRING_TIMEOUT_MS,
    computeProof,
    derivePairingSecret,
    generateEphemeralKeys,
    generateNonce,
    generatePin,
    isWellFormedPin,
    isWellFormedPublicKey,
    proofsMatch,
    type EphemeralKeys,
    type Transcript,
} from "../pairing/pairing-crypto";
import { TrustStore } from "../pairing/trust-store";

import type { DiscoveredDevice } from "../discovery/device-registry";
import { ConnectionState } from "./connection-state";

import {
    encodeMessage,
    MessageFramer,
} from "./framing";

import { TransferManager } from "../transfer/transfer-manager";
import type {
    ProtocolEventListener,
    ProtocolEventType,
} from "../protocol-event";
import type { TransferEventListener } from "../transfer/transfer-event";

import { SyncEngine } from "../sync/sync-engine";
import type { SyncEventListener } from "../sync/sync-event";
import type { SyncPair } from "../sync/sync-state";

import {
    ClipboardManager,
    type ClipboardEntry,
    type PeerSocket,
} from "../clipboard/clipboard-manager";
import type { ClipboardEventListener } from "../clipboard/clipboard-event";

const PROTOCOL_VERSION = "1.0.0";
const TCP_PORT = 41236;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;

export interface Connection {
    socket: net.Socket;
    state: ConnectionState;
    framer: MessageFramer;
    deviceId?: string;
    deviceName?: string;
    platform?: string;
    sessionId?: string;
    connectedAt?: number;
    rejectReason?: string;
    requestId?: string;
    pairing?: InitiatorPairing;
}

/** Initiator-side state while the peer's challenge is being answered. */
interface InitiatorPairing {
    mode: PairingMode;
    keys: EphemeralKeys;
    nonce: string;
    peerNonce: string;
    peerPublicKey: string;
    /** PIN or stored pairing secret the proof was keyed with. */
    secret?: string;
    attemptsLeft: number;
    error?: string;
    expiresAt: number;
    timer: NodeJS.Timeout;
}

/** Responder-side state between sending a challenge and verifying the proof. */
interface ResponderPairing {
    request: ConnectRequest;
    framer: MessageFramer;
    mode: PairingMode;
    keys: EphemeralKeys;
    nonce: string;
    pin?: string;
    attemptsLeft: number;
    expiresAt: number;
    timer: NodeJS.Timeout;
}

export class ConnectionManager {
    private connections = new Map<
        string,
        Connection
    >();

    private socketToDeviceId = new Map<net.Socket, string>();
    private pendingSockets = new Set<net.Socket>();
    private responderPairings = new Map<net.Socket, ResponderPairing>();
    private nextSequence = 0;

    private transferManager: TransferManager;
    private syncEngine: SyncEngine;
    private clipboardManager: ClipboardManager;

    constructor(
        private readonly deviceId: string,
        private readonly deviceName: string = "SyncBridge Node",
        private readonly tcpPort: number = TCP_PORT,
        private readonly connectionTimeoutMs: number = DEFAULT_CONNECTION_TIMEOUT_MS,
        private readonly onEvent?: ProtocolEventListener,
        onTransferEvent?: TransferEventListener,
        onSyncEvent?: SyncEventListener,
        onClipboardEvent?: ClipboardEventListener,
        private readonly trustStore: TrustStore = new TrustStore(),
        private readonly onPairingEvent?: PairingEventListener
    ) {
        /*
         * SyncEngine needs TransferManager to push files, but
         * TransferManager also needs a way to resolve a sync pair's
         * folder and report write conflicts back to SyncEngine. Since
         * `this.syncEngine` is assigned right after construction and
         * these resolvers are only ever invoked later (once a real
         * transfer arrives), the closures below can safely reference
         * `this.syncEngine` despite it not existing yet at this line.
         */
        const getSessionId = (peerDeviceId: string): string | undefined =>
            this.connections.get(peerDeviceId)?.sessionId;

        this.transferManager = new TransferManager(
            onTransferEvent,
            (syncPairId) => this.syncEngine.getLocalFolder(syncPairId),
            (info) => this.syncEngine.handleConflict(info),
            getSessionId
        );

        this.syncEngine = new SyncEngine(
            deviceId,
            this.transferManager,
            (peerDeviceId) => {
                const connection = this.connections.get(peerDeviceId);

                return connection?.state === ConnectionState.CONNECTED
                    ? connection.socket
                    : undefined;
            },
            onSyncEvent,
            getSessionId
        );

        this.clipboardManager = new ClipboardManager(
            deviceId,
            () => this.getConnectedPeerSockets(),
            onClipboardEvent,
            getSessionId
        );
    }

    /**
     * Every peer currently in the CONNECTED state, for subsystems
     * that broadcast rather than target a single device.
     */
    private getConnectedPeerSockets(): PeerSocket[] {
        const peers: PeerSocket[] = [];

        for (const [peerDeviceId, connection] of this.connections) {
            if (connection.state === ConnectionState.CONNECTED) {
                peers.push({
                    deviceId: peerDeviceId,
                    socket: connection.socket,
                });
            }
        }

        return peers;
    }

    getTrustedDevices() {
        return this.trustStore.list();
    }

    /** Forget a paired device; it must pair with a PIN again next time. */
    removeTrustedDevice(deviceId: string): boolean {
        return this.trustStore.remove(deviceId);
    }

    /** PINs being shown here and PINs this device is being asked to enter. */
    getPairingPrompts(): PairingPrompt[] {
        const prompts: PairingPrompt[] = [];

        for (const pending of this.responderPairings.values()) {
            if (pending.mode === "pin") {
                prompts.push({
                    kind: "display",
                    deviceId: pending.request.deviceId,
                    deviceName: pending.request.deviceName,
                    pin: pending.pin,
                    attemptsLeft: pending.attemptsLeft,
                    expiresAt: pending.expiresAt,
                });
            }
        }

        for (const [deviceId, connection] of this.connections) {
            if (
                connection.state === ConnectionState.AWAITING_PIN &&
                connection.pairing
            ) {
                prompts.push({
                    kind: "entry",
                    deviceId,
                    deviceName: connection.deviceName,
                    attemptsLeft: connection.pairing.attemptsLeft,
                    error: connection.pairing.error,
                    expiresAt: connection.pairing.expiresAt,
                });
            }
        }

        return prompts;
    }

    /** Answer a pairing challenge with the PIN shown on the other device. */
    submitPairingPin(deviceId: string, pin: string): void {
        const connection = this.connections.get(deviceId);

        if (
            !connection ||
            connection.state !== ConnectionState.AWAITING_PIN ||
            !connection.pairing
        ) {
            throw new Error("No pairing is waiting for a PIN from this device");
        }

        if (!isWellFormedPin(pin)) {
            throw new Error("The PIN is 6 digits");
        }

        connection.state = ConnectionState.CONNECTING;
        connection.pairing.error = undefined;
        this.sendPairProof(connection, pin);
    }

    cancelPairing(deviceId: string): boolean {
        const connection = this.connections.get(deviceId);

        if (connection?.pairing) {
            this.failInitiatorPairing(connection, "Pairing cancelled");
            return true;
        }

        for (const [socket, pending] of this.responderPairings) {
            if (pending.request.deviceId === deviceId) {
                this.failResponderPairing(socket, "Pairing cancelled");
                return true;
            }
        }

        return false;
    }

    publishClipboard(content: string): number {
        return this.clipboardManager.publish(content);
    }

    getClipboard(): ClipboardEntry | undefined {
        return this.clipboardManager.getLatest();
    }

    getClipboardHistory(): ClipboardEntry[] {
        return this.clipboardManager.getHistory();
    }

    isClipboardEnabled(): boolean {
        return this.clipboardManager.isEnabled();
    }

    setClipboardEnabled(enabled: boolean): void {
        this.clipboardManager.setEnabled(enabled);
    }

    acknowledgeClipboardWrite(contentHash: string): void {
        this.clipboardManager.acknowledgeLocalWrite(contentHash);
    }

    pauseTransfer(transferId: string): void {
        this.transferManager.pauseTransfer(transferId);
    }

    resumeTransfer(transferId: string): void {
        this.transferManager.resumeTransfer(transferId);
    }

    cancelTransfer(transferId: string): void {
        this.transferManager.cancelTransfer(transferId);
    }

    createSyncPair(
        peerDeviceId: string,
        localFolder: string,
        name: string
    ): SyncPair {
        return this.syncEngine.createPair(
            peerDeviceId,
            localFolder,
            name
        );
    }

    removeSyncPair(pairId: string): void {
        this.syncEngine.removePair(pairId);
    }

    syncNow(pairId: string): void {
        this.syncEngine.syncNow(pairId);
    }

    getSyncPairs(): SyncPair[] {
        return this.syncEngine.getPairs();
    }

    async connectToDevice(
        device: DiscoveredDevice
    ): Promise<void> {
        if (device.deviceId === this.deviceId) {
            throw new Error("Cannot connect to own device");
        }

        const existing = this.connections.get(device.deviceId);
        if (
            existing &&
            (existing.state === ConnectionState.CONNECTED ||
                existing.state === ConnectionState.CONNECTING ||
                existing.state === ConnectionState.AWAITING_PIN)
        ) {
            console.log(
                `[CONNECTION] Already connected or connecting to ${device.deviceName}`
            );
            return;
        }

        console.log(
            `[CONNECTION] Connecting to ${device.deviceName} at ${device.ip}:${this.tcpPort}`
        );
        const sessionId = randomUUID();
        this.emit("CONNECT_ATTEMPT", device.deviceId, sessionId, device.deviceName);

        const socket = new net.Socket();
        const framer = this.createFramer(device.deviceId);

        const connection: Connection = {
            socket,
            state: ConnectionState.CONNECTING,
            framer,
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            platform: device.platform,
            sessionId,
        };

        this.connections.set(device.deviceId, connection);
        this.socketToDeviceId.set(socket, device.deviceId);

        let timeoutTimer: NodeJS.Timeout | null = null;

        const cleanupListeners = () => {
            if (timeoutTimer) {
                clearTimeout(timeoutTimer);
                timeoutTimer = null;
            }
        };

        socket.on("error", (error) => {
            console.error(
                `[CONNECTION] Error connecting to ${device.deviceName}:`,
                error
            );
            cleanupListeners();
            if (connection.state === ConnectionState.CONNECTING) {
                connection.state = ConnectionState.FAILED;
                connection.rejectReason = error.message;
            }
            this.handleSocketTermination(device.deviceId, socket);
        });

        socket.on("close", () => {
            console.log(
                `[CONNECTION] Connection closed: ${device.deviceName}`
            );
            cleanupListeners();
            this.handleSocketTermination(device.deviceId, socket);
        });

        socket.on("data", (data) => {
            const buffer = Buffer.isBuffer(data)
                ? data
                : Buffer.from(data);

            const messages =
                framer.addData(buffer);

            for (const message of messages) {
                this.handleMessage(
                    socket,
                    device.deviceId,
                    message
                );
            }
        });

        await new Promise<void>(
            (resolve, reject) => {
                timeoutTimer = setTimeout(() => {
                    cleanupListeners();
                    console.error(
                        `[CONNECTION] Connection to ${device.deviceName} timed out after ${this.connectionTimeoutMs}ms`
                    );
                    connection.state = ConnectionState.FAILED;
                    connection.rejectReason = "CONNECTION_TIMEOUT";
                    socket.destroy(new Error("Connection timed out"));
                    reject(new Error("Connection timed out"));
                }, this.connectionTimeoutMs);

                socket.connect(
                    this.tcpPort,
                    device.ip,
                    () => {
                        cleanupListeners();
                        console.log(
                            `[CONNECTION] TCP connection established with ${device.deviceName}`
                        );

                        connection.requestId =
                            this.sendConnectRequest(
                                socket,
                                sessionId
                            );

                        resolve();
                    }
                );

                socket.once(
                    "error",
                    (err) => {
                        cleanupListeners();
                        reject(err);
                    }
                );
            }
        );
    }

    async sendFile(
        peerDeviceId: string,
        filePath: string
    ): Promise<void> {
        const connection =
            this.connections.get(peerDeviceId);

        if (!connection) {
            console.error(
                `[CONNECTION] No connection found for ${peerDeviceId}`
            );
            return;
        }

        if (
            connection.state !==
            ConnectionState.CONNECTED
        ) {
            console.error(
                `[CONNECTION] Peer ${peerDeviceId} is not connected`
            );
            return;
        }

        const fs = await import("node:fs/promises");
        const path = await import("node:path");

        const stats =
            await fs.stat(filePath);

        if (!stats.isFile()) {
            console.error(
                `[CONNECTION] Not a file: ${filePath}`
            );
            return;
        }

        const fileName =
            path.basename(filePath);

        const transferId =
            this.transferManager.requestTransfer(
                connection.socket,
                this.deviceId,
                filePath,
                peerDeviceId
            );

        console.log(
            `[CONNECTION] File transfer requested: ${transferId}`
        );
    }

    getConnections() {
        return Array.from(
            this.connections.entries()
        ).map(
            ([deviceId, connection]) => ({
                deviceId,
                deviceName: connection.deviceName,
                state: connection.state,
                sessionId: connection.sessionId,
                remoteAddress:
                    connection.socket.remoteAddress,
                remotePort:
                    connection.socket.remotePort,
                connectedAt: connection.connectedAt,
                rejectReason: connection.rejectReason,
            })
        );
    }

    getTransfers() {
        return this.transferManager.getTransfers();
    }

    handleIncomingConnection(
        socket: net.Socket
    ): void {
        console.log(
            `[CONNECTION] Handling incoming TCP connection from ${socket.remoteAddress}:${socket.remotePort}`
        );

        this.pendingSockets.add(socket);
        const framer = this.createFramer();

        const onPendingClose = () => {
            this.pendingSockets.delete(socket);
            this.discardResponderPairing(socket, "Connection closed");
            const deviceId = this.socketToDeviceId.get(socket);
            if (deviceId) {
                this.handleSocketTermination(deviceId, socket);
            }
        };

        socket.on("close", onPendingClose);
        socket.on("error", (error) => {
            console.error(
                `[CONNECTION] Socket error from ${socket.remoteAddress}:`,
                error
            );
            onPendingClose();
        });

        socket.on("data", (data) => {
            const buffer = Buffer.isBuffer(data)
                ? data
                : Buffer.from(data);

            const messages =
                framer.addData(buffer);

            for (const message of messages) {
                const mappedDeviceId = this.socketToDeviceId.get(socket);
                if (mappedDeviceId) {
                    this.handleMessage(socket, mappedDeviceId, message);
                } else {
                    this.handlePendingMessage(socket, framer, message);
                }
            }
        });
    }

    private handlePendingMessage(
        socket: net.Socket,
        framer: MessageFramer,
        message: object
    ): void {
        if ("type" in message && message.type === MessageType.PAIR_PROOF) {
            this.handlePairProof(socket, message as PairProof);
            return;
        }

        if (!("type" in message) || message.type !== MessageType.CONNECT_REQUEST) {
            console.warn(
                "[CONNECTION] Rejecting message before handshake on incoming socket"
            );
            return;
        }

        if (this.responderPairings.has(socket)) {
            // Already challenged; a second request must not reset the PIN.
            return;
        }

        const request = message as ConnectRequest;
        this.handleConnectRequest(socket, framer, request);
    }

    private sendConnectRequest(
        socket: net.Socket,
        sessionId: string
    ): string {
        const requestId = randomUUID();

        const request: ConnectRequest = {
            type:
                MessageType.CONNECT_REQUEST,

            version: PROTOCOL_VERSION,

            requestId,

            messageId: randomUUID(),

            sequence: this.nextSequence++,

            deviceId: this.deviceId,

            sessionId,

            deviceName: this.deviceName,

            platform: process.platform,

            timestamp: Date.now(),
        };

        this.sendMessage(
            socket,
            request
        );

        console.log(
            "[CONNECTION] CONNECT_REQUEST sent"
        );
        this.emit("CONNECT_REQUEST_SENT", undefined, sessionId);

        return requestId;
    }

    private handleMessage(
        socket: net.Socket,
        peerDeviceId: string,
        message: object
    ): void {
        if (!("type" in message)) {
            console.error(
                "[CONNECTION] Invalid message received"
            );

            return;
        }

        const messageType =
            message.type;

        if (
            typeof messageType !==
            "string"
        ) {
            console.error(
                "[CONNECTION] Invalid message type"
            );

            return;
        }

        console.log(
            `[CONNECTION] Received message: ${messageType}`
        );

        /*
         * Nothing but the handshake is processed until the peer has
         * authenticated: an unpaired device can't reach the transfer,
         * sync or clipboard handlers.
         */
        const isHandshakeMessage =
            messageType.startsWith("CONNECT_") ||
            messageType.startsWith("PAIR_");

        if (
            !isHandshakeMessage &&
            this.connections.get(peerDeviceId)?.state !==
                ConnectionState.CONNECTED
        ) {
            console.warn(
                `[CONNECTION] Dropping ${messageType} from unauthenticated peer ${peerDeviceId}`
            );

            return;
        }

        /*
         * Route file-transfer messages
         * to TransferManager.
         */
        if (
            messageType.startsWith(
                "FILE_"
            )
        ) {
            this.transferManager.handleMessage(
                socket,
                message,
                peerDeviceId
            );

            return;
        }

        /*
         * Route clipboard messages to ClipboardManager.
         */
        if (
            messageType.startsWith(
                "CLIPBOARD_"
            )
        ) {
            this.clipboardManager.handleMessage(
                socket,
                message,
                peerDeviceId
            );

            return;
        }

        /*
         * Route sync messages to SyncEngine.
         */
        if (
            messageType.startsWith(
                "SYNC_"
            )
        ) {
            this.syncEngine.handleMessage(
                socket,
                message,
                peerDeviceId
            );

            return;
        }

        /*
         * Handle connection protocol
         * messages.
         */
        switch (messageType) {
            case MessageType.CONNECT_REQUEST:
                this.handleConnectRequest(
                    socket,
                    new MessageFramer(),
                    message as ConnectRequest
                );

                break;

            case MessageType.CONNECT_CHALLENGE:
                this.handleConnectChallenge(
                    peerDeviceId,
                    message as ConnectChallenge
                );

                break;

            case MessageType.PAIR_RETRY:
                this.handlePairRetry(
                    peerDeviceId,
                    message as PairRetry
                );

                break;

            case MessageType.CONNECT_ACCEPT:
                this.handleConnectAccept(
                    peerDeviceId,
                    message as ConnectAccept
                );

                break;

            case MessageType.CONNECT_REJECT:
                this.handleConnectReject(
                    peerDeviceId,
                    message as ConnectReject
                );

                break;

            default:
                console.log(
                    `[CONNECTION] Unknown message type: ${messageType}`
                );
        }
    }

    private handleConnectRequest(
        socket: net.Socket,
        framer: MessageFramer,
        request: ConnectRequest
    ): void {
        if (!this.isValidConnectRequest(request)) {
            console.warn("[CONNECTION] Rejecting malformed CONNECT_REQUEST");
            this.emit("MALFORMED_MESSAGE", undefined, undefined, "Invalid CONNECT_REQUEST");
            socket.destroy();
            this.pendingSockets.delete(socket);
            return;
        }

        console.log(
            `[CONNECTION] CONNECT_REQUEST received from ${request.deviceId} (version: ${request.version})`
        );
        this.emit("CONNECT_REQUEST_RECEIVED", request.deviceId, request.sessionId);

        // 1. Check self connection
        if (request.deviceId === this.deviceId) {
            console.warn("[CONNECTION] Rejecting self-connection");
            this.sendConnectReject(socket, request.requestId, request.deviceId, "SELF_CONNECTION");
            socket.destroy();
            this.pendingSockets.delete(socket);
            return;
        }

        // 2. Check protocol version compatibility (major version check)
        const peerMajor = request.version ? request.version.split(".")[0] : "";
        const localMajor = PROTOCOL_VERSION.split(".")[0];
        if (peerMajor !== localMajor) {
            console.warn(
                `[CONNECTION] Rejecting incompatible protocol version: ${request.version} (expected: ${PROTOCOL_VERSION})`
            );
            this.sendConnectReject(socket, request.requestId, request.deviceId, "VERSION_MISMATCH");
            socket.destroy();
            this.pendingSockets.delete(socket);
            return;
        }

        // 3. Check duplicate active connection
        const existing = this.connections.get(request.deviceId);
        if (existing && existing.state === ConnectionState.CONNECTED) {
            console.warn(
                `[CONNECTION] Rejecting duplicate connection from ${request.deviceId}`
            );
            this.sendConnectReject(socket, request.requestId, request.deviceId, "DUPLICATE_CONNECTION");
            socket.destroy();
            this.pendingSockets.delete(socket);
            return;
        }

        // 4. Authenticate the peer before accepting it.
        this.beginPairing(socket, framer, request);
    }

    private acceptConnection(
        socket: net.Socket,
        framer: MessageFramer,
        request: ConnectRequest,
        proof: string
    ): void {
        // Echo the initiator's sessionId.
        const sessionId = request.sessionId;
        const response: ConnectAccept = {
            type: MessageType.CONNECT_ACCEPT,
            version: PROTOCOL_VERSION,
            requestId: request.requestId,
            messageId: randomUUID(),
            sequence: this.nextSequence++,
            deviceId: this.deviceId,
            sessionId,
            deviceName: this.deviceName,
            platform: process.platform,
            proof,
            timestamp: Date.now(),
        };

        this.sendMessage(socket, response);
        console.log(
            `[CONNECTION] CONNECT_ACCEPT sent to ${request.deviceId}, sessionId: ${sessionId}`
        );

        this.pendingSockets.delete(socket);
        this.socketToDeviceId.set(socket, request.deviceId);

        const connection: Connection = {
            socket,
            state: ConnectionState.CONNECTED,
            framer,
            sessionId,
            deviceId: request.deviceId,
            deviceName: request.deviceName,
            platform: request.platform,
            connectedAt: Date.now(),
        };

        this.connections.set(request.deviceId, connection);
        console.log(`[CONNECTION] Peer ${request.deviceId} is now CONNECTED`);
        this.emit("CONNECT_ACCEPTED", request.deviceId, sessionId);
    }

    private handleConnectAccept(
        peerDeviceId: string,
        response: ConnectAccept
    ): void {
        console.log(
            `[CONNECTION] CONNECT_ACCEPT received from ${response.deviceId}, sessionId: ${response.sessionId}`
        );

        const connection =
            this.connections.get(
                peerDeviceId
            );

        if (!connection) {
            console.error(
                `[CONNECTION] No connection found for ${peerDeviceId}`
            );

            return;
        }

        if (!this.isValidConnectAccept(response)) {
            connection.state = ConnectionState.FAILED;
            connection.rejectReason = "INVALID_CONNECT_ACCEPT";
            this.emit("MALFORMED_MESSAGE", peerDeviceId, connection.sessionId, "Invalid CONNECT_ACCEPT");
            connection.socket.destroy();
            return;
        }

        const pairing = connection.pairing;

        if (!pairing || !pairing.secret) {
            this.failInitiatorPairing(
                connection,
                "Peer accepted without authenticating"
            );
            return;
        }

        const transcript = this.initiatorTranscript(connection, pairing);

        if (
            !proofsMatch(
                computeProof(pairing.secret, "responder", transcript),
                response.proof
            )
        ) {
            this.failInitiatorPairing(
                connection,
                "Peer could not prove it knows the PIN"
            );
            return;
        }

        if (pairing.mode === "pin") {
            this.trustStore.add(
                peerDeviceId,
                response.deviceName ?? connection.deviceName ?? peerDeviceId,
                derivePairingSecret(
                    pairing.keys.privateKey,
                    pairing.peerPublicKey,
                    transcript
                )
            );
        } else {
            this.trustStore.touch(peerDeviceId);
        }

        clearTimeout(pairing.timer);
        connection.pairing = undefined;

        this.emit(
            "PAIRING_VERIFIED",
            peerDeviceId,
            connection.sessionId,
            pairing.mode === "pin" ? "PIN confirmed" : "Trusted device recognised"
        );
        this.onPairingEvent?.({
            type: "PAIRED",
            deviceId: peerDeviceId,
            deviceName: connection.deviceName,
            timestamp: Date.now(),
        });

        connection.state =
            ConnectionState.CONNECTED;
        connection.sessionId = response.sessionId;
        connection.connectedAt = Date.now();
        connection.deviceName = response.deviceName ?? connection.deviceName;
        connection.platform = response.platform ?? connection.platform;
        connection.rejectReason = undefined;

        console.log(
            `[CONNECTION] Peer ${peerDeviceId} is CONNECTED (session: ${connection.sessionId})`
        );
        this.emit("CONNECT_ACCEPTED", peerDeviceId, connection.sessionId);
    }

    private handleConnectReject(
        peerDeviceId: string,
        response: ConnectReject
    ): void {
        console.log(
            `[CONNECTION] CONNECT_REJECT received from ${response.deviceId}`
        );

        console.log(
            `[CONNECTION] Reason: ${response.reason}`
        );

        const connection =
            this.connections.get(
                peerDeviceId
            );

        const sessionId = connection?.sessionId;

        if (connection?.pairing) {
            clearTimeout(connection.pairing.timer);
            connection.pairing = undefined;

            this.emit(
                "PAIRING_FAILED",
                peerDeviceId,
                sessionId,
                response.reason
            );
            this.onPairingEvent?.({
                type: "PAIRING_FAILED",
                deviceId: peerDeviceId,
                deviceName: connection.deviceName,
                error:
                    response.reason === "PAIRING_FAILED"
                        ? "Too many wrong PIN attempts"
                        : response.reason,
                timestamp: Date.now(),
            });
        }

        if (connection) {
            connection.state =
                ConnectionState.REJECTED;
            connection.rejectReason = response.reason;
            connection.socket.destroy();
        }

        this.handleSocketTermination(peerDeviceId);
        this.emit("CONNECT_REJECTED", peerDeviceId, sessionId, response.reason);
    }

    private sendConnectReject(
        socket: net.Socket,
        requestId: string,
        targetDeviceId: string,
        reason: ConnectRejectReason
    ): void {
        const reject: ConnectReject = {
            type: MessageType.CONNECT_REJECT,
            version: PROTOCOL_VERSION,
            requestId,
            messageId: randomUUID(),
            sequence: this.nextSequence++,
            deviceId: this.deviceId,
            reason,
            timestamp: Date.now(),
        };

        this.sendMessage(socket, reject);
    }

    private handleSocketTermination(deviceId: string, socket?: net.Socket): void {
        const connection = this.connections.get(deviceId);
        if (connection && (!socket || connection.socket === socket)) {
            if (connection.pairing) {
                clearTimeout(connection.pairing.timer);
                this.onPairingEvent?.({
                    type: "PAIRING_FAILED",
                    deviceId,
                    deviceName: connection.deviceName,
                    error: connection.rejectReason ?? "Connection closed",
                    timestamp: Date.now(),
                });
            }
            this.connections.delete(deviceId);
            this.socketToDeviceId.delete(connection.socket);
            this.emit("CONNECTION_CLOSED", deviceId, connection.sessionId);
        }
        if (socket) {
            this.pendingSockets.delete(socket);
            this.socketToDeviceId.delete(socket);
        }
    }

    disconnectDevice(deviceId: string): boolean {
        const connection = this.connections.get(deviceId);
        if (!connection) {
            return false;
        }

        console.log(`[CONNECTION] Disconnecting session with ${deviceId}`);
        connection.state = ConnectionState.CLOSING;
        if (connection.pairing) {
            clearTimeout(connection.pairing.timer);
        }
        connection.socket.destroy();
        this.connections.delete(deviceId);
        this.socketToDeviceId.delete(connection.socket);
        this.emit("CONNECTION_CLOSED", deviceId, connection.sessionId);
        return true;
    }

    private sendMessage(
        socket: net.Socket,
        message: object
    ): void {
        const payload =
            encodeMessage(message);

        socket.write(payload);
    }

    getConnectedDevices(): string[] {
        const connectedDevices: string[] = [];

        for (const [deviceId, connection] of this.connections) {
            if (
                connection.state ===
                ConnectionState.CONNECTED
            ) {
                connectedDevices.push(deviceId);
            }
        }

        return connectedDevices;
    }

    async sendFileToFirstConnectedPeer(
        filePath: string
    ): Promise<void> {
        const connectedDevices =
            this.getConnectedDevices();

        if (connectedDevices.length === 0) {
            console.error(
                "[CONNECTION] No connected peers available"
            );

            return;
        }

        const peerDeviceId =
            connectedDevices[0];

        await this.sendFile(
            peerDeviceId,
            filePath
        );
    }

    unlockTransfer(transferId: string, pin: string) {
        return this.transferManager.unlockTransfer(transferId, pin);
    }

    requestTransfer(
        deviceId: string,
        filePath: string,
        sensitive?: { pin: string }
    ) {
        const connection =
            this.connections.get(deviceId);

        if (!connection) {
            throw new Error(
                `No connection found for device ${deviceId}`
            );
        }

        if (
            connection.state !== "CONNECTED"
        ) {
            throw new Error(
                `Device ${deviceId} is not connected`
            );
        }

        return this.transferManager.requestTransfer(
            connection.socket,
            this.deviceId,
            filePath,
            deviceId,
            undefined,
            sensitive
        );
    }

    private createFramer(deviceId?: string): MessageFramer {
        return new MessageFramer((detail) =>
            this.emit("MALFORMED_MESSAGE", deviceId, undefined, detail)
        );
    }

    private isValidConnectRequest(message: ConnectRequest): boolean {
        return (
            typeof message.version === "string" &&
            typeof message.requestId === "string" &&
            typeof message.messageId === "string" &&
            typeof message.sequence === "number" &&
            Number.isInteger(message.sequence) &&
            message.sequence >= 0 &&
            typeof message.deviceId === "string" &&
            message.deviceId.length > 0 &&
            typeof message.sessionId === "string" &&
            message.sessionId.length > 0 &&
            typeof message.timestamp === "number"
        );
    }

    private isValidConnectAccept(message: ConnectAccept): boolean {
        return (
            message.version === PROTOCOL_VERSION &&
            typeof message.requestId === "string" &&
            typeof message.messageId === "string" &&
            typeof message.sequence === "number" &&
            Number.isInteger(message.sequence) &&
            message.sequence >= 0 &&
            typeof message.deviceId === "string" &&
            message.deviceId.length > 0 &&
            typeof message.sessionId === "string" &&
            message.sessionId.length > 0 &&
            typeof message.timestamp === "number"
        );
    }

    // ---------------------------------------------------------------
    // Pairing — responder side
    // ---------------------------------------------------------------

    private beginPairing(
        socket: net.Socket,
        framer: MessageFramer,
        request: ConnectRequest
    ): void {
        const mode: PairingMode = this.trustStore.isTrusted(request.deviceId)
            ? "trusted"
            : "pin";

        const keys = generateEphemeralKeys();
        const nonce = generateNonce();
        const pin = mode === "pin" ? generatePin() : undefined;
        const expiresAt = Date.now() + PAIRING_TIMEOUT_MS;

        const timer = setTimeout(
            () => this.failResponderPairing(socket, "Pairing timed out"),
            PAIRING_TIMEOUT_MS
        );

        this.responderPairings.set(socket, {
            request,
            framer,
            mode,
            keys,
            nonce,
            pin,
            attemptsLeft: PAIRING_MAX_ATTEMPTS,
            expiresAt,
            timer,
        });

        const challenge: ConnectChallenge = {
            type: MessageType.CONNECT_CHALLENGE,
            version: PROTOCOL_VERSION,
            requestId: request.requestId,
            messageId: randomUUID(),
            sequence: this.nextSequence++,
            deviceId: this.deviceId,
            sessionId: request.sessionId,
            deviceName: this.deviceName,
            mode,
            nonce,
            publicKey: keys.publicKey,
            timestamp: Date.now(),
        };

        this.sendMessage(socket, challenge);
        this.emit(
            "PAIRING_CHALLENGE_SENT",
            request.deviceId,
            request.sessionId,
            mode === "pin" ? "New device — PIN required" : "Trusted device"
        );

        if (pin) {
            this.onPairingEvent?.({
                type: "PIN_DISPLAY",
                deviceId: request.deviceId,
                deviceName: request.deviceName,
                pin,
                attemptsLeft: PAIRING_MAX_ATTEMPTS,
                expiresAt,
                timestamp: Date.now(),
            });
        }
    }

    private handlePairProof(socket: net.Socket, message: PairProof): void {
        const pending = this.responderPairings.get(socket);

        if (!pending) {
            return;
        }

        const { request } = pending;

        const wellFormed =
            message.deviceId === request.deviceId &&
            typeof message.nonce === "string" &&
            message.nonce.length > 0 &&
            message.nonce.length <= 64 &&
            typeof message.proof === "string" &&
            isWellFormedPublicKey(message.publicKey);

        const secret =
            pending.mode === "pin"
                ? pending.pin
                : this.trustStore.getSecret(request.deviceId);

        if (!wellFormed || !secret) {
            this.failResponderPairing(
                socket,
                "Malformed pairing proof",
                "AUTH_FAILED"
            );
            return;
        }

        const transcript: Transcript = {
            initiatorId: request.deviceId,
            responderId: this.deviceId,
            initiatorNonce: message.nonce,
            responderNonce: pending.nonce,
            initiatorKey: message.publicKey,
            responderKey: pending.keys.publicKey,
        };

        if (
            !proofsMatch(
                computeProof(secret, "initiator", transcript),
                message.proof
            )
        ) {
            pending.attemptsLeft--;

            if (pending.mode === "pin" && pending.attemptsLeft > 0) {
                const retry: PairRetry = {
                    type: MessageType.PAIR_RETRY,
                    version: PROTOCOL_VERSION,
                    requestId: request.requestId,
                    messageId: randomUUID(),
                    sequence: this.nextSequence++,
                    deviceId: this.deviceId,
                    attemptsLeft: pending.attemptsLeft,
                    timestamp: Date.now(),
                };

                this.sendMessage(socket, retry);
                this.onPairingEvent?.({
                    type: "PIN_DISPLAY",
                    deviceId: request.deviceId,
                    deviceName: request.deviceName,
                    pin: pending.pin,
                    attemptsLeft: pending.attemptsLeft,
                    error: "The other device entered the wrong PIN",
                    expiresAt: pending.expiresAt,
                    timestamp: Date.now(),
                });
                return;
            }

            this.failResponderPairing(
                socket,
                pending.mode === "pin"
                    ? "Too many wrong PIN attempts"
                    : "Peer failed to prove it is the paired device",
                pending.mode === "pin" ? "PAIRING_FAILED" : "AUTH_FAILED"
            );
            return;
        }

        clearTimeout(pending.timer);
        this.responderPairings.delete(socket);

        if (pending.mode === "pin") {
            this.trustStore.add(
                request.deviceId,
                request.deviceName ?? request.deviceId,
                derivePairingSecret(
                    pending.keys.privateKey,
                    message.publicKey,
                    transcript
                )
            );
        } else {
            this.trustStore.touch(request.deviceId);
        }

        this.emit(
            "PAIRING_VERIFIED",
            request.deviceId,
            request.sessionId,
            pending.mode === "pin" ? "PIN confirmed" : "Trusted device recognised"
        );
        this.onPairingEvent?.({
            type: "PAIRED",
            deviceId: request.deviceId,
            deviceName: request.deviceName,
            timestamp: Date.now(),
        });

        this.acceptConnection(
            socket,
            pending.framer,
            request,
            computeProof(secret, "responder", transcript)
        );
    }

    private failResponderPairing(
        socket: net.Socket,
        reason: string,
        rejectReason: ConnectRejectReason = "PAIRING_FAILED"
    ): void {
        const pending = this.responderPairings.get(socket);

        if (!pending) {
            return;
        }

        this.discardResponderPairing(socket, reason);
        this.sendConnectReject(
            socket,
            pending.request.requestId,
            pending.request.deviceId,
            rejectReason
        );
        this.pendingSockets.delete(socket);
        socket.end();
    }

    /** Drop pairing state and tell the UI; does not touch the socket. */
    private discardResponderPairing(
        socket: net.Socket,
        reason: string
    ): void {
        const pending = this.responderPairings.get(socket);

        if (!pending) {
            return;
        }

        clearTimeout(pending.timer);
        this.responderPairings.delete(socket);

        this.emit(
            "PAIRING_FAILED",
            pending.request.deviceId,
            pending.request.sessionId,
            reason
        );
        this.onPairingEvent?.({
            type: "PAIRING_FAILED",
            deviceId: pending.request.deviceId,
            deviceName: pending.request.deviceName,
            error: reason,
            timestamp: Date.now(),
        });
    }

    // ---------------------------------------------------------------
    // Pairing — initiator side
    // ---------------------------------------------------------------

    private handleConnectChallenge(
        peerDeviceId: string,
        challenge: ConnectChallenge
    ): void {
        const connection = this.connections.get(peerDeviceId);

        if (
            !connection ||
            connection.state !== ConnectionState.CONNECTING ||
            connection.pairing
        ) {
            return;
        }

        if (
            challenge.requestId !== connection.requestId ||
            challenge.deviceId !== peerDeviceId ||
            (challenge.mode !== "pin" && challenge.mode !== "trusted") ||
            typeof challenge.nonce !== "string" ||
            challenge.nonce.length === 0 ||
            challenge.nonce.length > 64 ||
            !isWellFormedPublicKey(challenge.publicKey)
        ) {
            this.emit(
                "MALFORMED_MESSAGE",
                peerDeviceId,
                connection.sessionId,
                "Invalid CONNECT_CHALLENGE"
            );
            connection.state = ConnectionState.FAILED;
            connection.rejectReason = "INVALID_CONNECT_CHALLENGE";
            connection.socket.destroy();
            return;
        }

        const expiresAt = Date.now() + PAIRING_TIMEOUT_MS;

        connection.pairing = {
            mode: challenge.mode,
            keys: generateEphemeralKeys(),
            nonce: generateNonce(),
            peerNonce: challenge.nonce,
            peerPublicKey: challenge.publicKey,
            attemptsLeft: PAIRING_MAX_ATTEMPTS,
            expiresAt,
            timer: setTimeout(
                () =>
                    this.failInitiatorPairing(
                        connection,
                        "Pairing timed out"
                    ),
                PAIRING_TIMEOUT_MS
            ),
        };

        this.emit(
            "PAIRING_CHALLENGE_RECEIVED",
            peerDeviceId,
            connection.sessionId,
            challenge.mode === "pin" ? "PIN required" : "Trusted device"
        );

        if (challenge.mode === "trusted") {
            const secret = this.trustStore.getSecret(peerDeviceId);

            if (!secret) {
                this.failInitiatorPairing(
                    connection,
                    "That device remembers this one as paired, but this device has no pairing record. Remove it from the other device's trusted list and pair again."
                );
                return;
            }

            this.sendPairProof(connection, secret);
            return;
        }

        connection.state = ConnectionState.AWAITING_PIN;
        this.onPairingEvent?.({
            type: "PIN_ENTRY",
            deviceId: peerDeviceId,
            deviceName: connection.deviceName,
            attemptsLeft: PAIRING_MAX_ATTEMPTS,
            expiresAt,
            timestamp: Date.now(),
        });
    }

    private handlePairRetry(peerDeviceId: string, retry: PairRetry): void {
        const connection = this.connections.get(peerDeviceId);

        if (
            !connection?.pairing ||
            connection.pairing.mode !== "pin" ||
            typeof retry.attemptsLeft !== "number"
        ) {
            return;
        }

        connection.state = ConnectionState.AWAITING_PIN;
        connection.pairing.secret = undefined;
        connection.pairing.attemptsLeft = retry.attemptsLeft;
        connection.pairing.error = "Incorrect PIN";

        this.onPairingEvent?.({
            type: "PIN_ENTRY",
            deviceId: peerDeviceId,
            deviceName: connection.deviceName,
            attemptsLeft: retry.attemptsLeft,
            error: "Incorrect PIN",
            expiresAt: connection.pairing.expiresAt,
            timestamp: Date.now(),
        });
    }

    private initiatorTranscript(
        connection: Connection,
        pairing: InitiatorPairing
    ): Transcript {
        return {
            initiatorId: this.deviceId,
            responderId: connection.deviceId ?? "",
            initiatorNonce: pairing.nonce,
            responderNonce: pairing.peerNonce,
            initiatorKey: pairing.keys.publicKey,
            responderKey: pairing.peerPublicKey,
        };
    }

    private sendPairProof(connection: Connection, secret: string): void {
        const pairing = connection.pairing;

        if (!pairing || !connection.requestId || !connection.sessionId) {
            return;
        }

        pairing.secret = secret;

        const proof: PairProof = {
            type: MessageType.PAIR_PROOF,
            version: PROTOCOL_VERSION,
            requestId: connection.requestId,
            messageId: randomUUID(),
            sequence: this.nextSequence++,
            deviceId: this.deviceId,
            sessionId: connection.sessionId,
            nonce: pairing.nonce,
            publicKey: pairing.keys.publicKey,
            proof: computeProof(
                secret,
                "initiator",
                this.initiatorTranscript(connection, pairing)
            ),
            timestamp: Date.now(),
        };

        this.sendMessage(connection.socket, proof);
        this.emit("PAIRING_PROOF_SENT", connection.deviceId, connection.sessionId);
    }

    private failInitiatorPairing(
        connection: Connection,
        reason: string
    ): void {
        if (connection.pairing) {
            clearTimeout(connection.pairing.timer);
            connection.pairing = undefined;
        }

        connection.state = ConnectionState.FAILED;
        connection.rejectReason = reason;

        this.emit(
            "PAIRING_FAILED",
            connection.deviceId,
            connection.sessionId,
            reason
        );
        this.onPairingEvent?.({
            type: "PAIRING_FAILED",
            deviceId: connection.deviceId ?? "",
            deviceName: connection.deviceName,
            error: reason,
            timestamp: Date.now(),
        });

        connection.socket.destroy();
    }

    private emit(
        type: ProtocolEventType,
        deviceId?: string,
        sessionId?: string,
        detail?: string
    ): void {
        this.onEvent?.({
            id: randomUUID(),
            timestamp: Date.now(),
            type,
            layer:
                type === "MALFORMED_MESSAGE"
                    ? "framing"
                    : type.startsWith("PAIRING_")
                      ? "authentication"
                      : "connection",
            deviceId,
            sessionId,
            detail,
        });
    }
}
