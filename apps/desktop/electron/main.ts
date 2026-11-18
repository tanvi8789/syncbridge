import {
    app,
    BrowserWindow,
    clipboard,
    dialog,
    ipcMain,
    nativeTheme,
    net,
    protocol,
    shell,
} from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startApi, type ApiHandle } from "api";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

/*
 * The packaged app runs the networking engine and its local API inside
 * this process. In development they run separately (`npm run dev`) so
 * they restart on change, unless SYNCBRIDGE_EMBED=1 asks for the
 * packaged behaviour.
 */
const embedEngine = !isDev || process.env.SYNCBRIDGE_EMBED === "1";

/*
 * The packaged UI is served from this custom scheme instead of
 * file://, so it has a real origin the API can allow (a file page
 * sends "Origin: null", which would have to be trusted for everyone).
 */
const APP_SCHEME = "app";
const APP_HOST = "syncbridge";

protocol.registerSchemesAsPrivileged([
    {
        scheme: APP_SCHEME,
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
        },
    },
]);

const API_BASE_URL = "http://127.0.0.1:41235";

/*
 * How often the main process samples the OS clipboard. Electron
 * exposes no change event, so polling is the only option; 1s is
 * responsive enough to feel instant while costing nothing.
 */
const CLIPBOARD_POLL_MS = 1000;

let mainWindow: BrowserWindow | null = null;
let clipboardTimer: NodeJS.Timeout | null = null;
let engine: ApiHandle | null = null;

/*
 * The last text this process has seen — whether the user copied it
 * or we wrote it after a peer shared it. Tracking it here stops an
 * incoming clipboard from being immediately re-published as though
 * it were a local copy. The engine de-duplicates by content hash as
 * well, so a missed guard here is caught there.
 */
let lastClipboardText = "";

function createWindow(): void {
    console.log(
        "[ELECTRON] Preload path:",
        path.join(__dirname, "..", "electron-build", "preload.cjs")
    );

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        // Matches the page background so there is no white flash in dark mode.
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#0e1115" : "#f4f5f7",
        title: "SyncBridge",
        webPreferences: {
            preload: path.join(__dirname, "..", "electron-build", "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    mainWindow.webContents.on(
        "preload-error",
        (_event, preloadPath, error) => {
            console.error(
                "[ELECTRON] Preload error:",
                preloadPath,
                error
            );
        }
    );

    if (isDev) {
        mainWindow.loadURL("http://localhost:5173");
    } else {
        mainWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/`);
    }

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

ipcMain.handle("select-file", async () => {
    const result = (await dialog.showOpenDialog({
        properties: ["openFile"],
    })) as unknown as { canceled: boolean; filePaths: string[] };

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }
    return result.filePaths[0];
});

ipcMain.handle("show-in-folder", (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
});

ipcMain.handle("clipboard:read", () => clipboard.readText());

ipcMain.handle("clipboard:write", (_event, text: string) => {
    if (typeof text !== "string" || text.length === 0) {
        return false;
    }

    clipboard.writeText(text);

    // Keep the watcher from treating our own write as a local copy.
    lastClipboardText = text;

    return true;
});

/**
 * Watch the OS clipboard and hand anything new to the local API,
 * which decides whether to broadcast it to connected peers.
 *
 * This lives in the main process rather than the renderer so it
 * keeps working while the window is unfocused or hidden — the
 * renderer's navigator.clipboard would require focus and a
 * permission prompt.
 */
function startClipboardWatcher(): void {
    lastClipboardText = clipboard.readText();

    clipboardTimer = setInterval(async () => {
        let text: string;

        try {
            text = clipboard.readText();
        } catch {
            return;
        }

        if (text === lastClipboardText || text.length === 0) {
            return;
        }

        lastClipboardText = text;

        try {
            await fetch(`${API_BASE_URL}/api/clipboard`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: text }),
            });
        } catch {
            // The API may not be up yet, or may have restarted.
            // The next local copy will retry on its own.
        }
    }, CLIPBOARD_POLL_MS);
}

ipcMain.handle("select-folder", async () => {
    const result = (await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
    })) as unknown as { canceled: boolean; filePaths: string[] };

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }
    return result.filePaths[0];
});

/** Serve the built UI (dist/) under app://syncbridge/. */
function registerAppProtocol(): void {
    const distDirectory = path.resolve(__dirname, "..", "dist");

    protocol.handle(APP_SCHEME, (request) => {
        const url = new URL(request.url);

        if (url.host !== APP_HOST) {
            return new Response("Not found", { status: 404 });
        }

        const requested = decodeURIComponent(url.pathname);
        const filePath = path.resolve(
            distDirectory,
            "." + (requested === "/" ? "/index.html" : requested)
        );

        // Never serve anything outside the built UI.
        if (!filePath.startsWith(distDirectory + path.sep)) {
            return new Response("Forbidden", { status: 403 });
        }

        return net.fetch(pathToFileURL(filePath).toString());
    });
}

/*
 * The engine binds fixed ports, so only one copy can run per machine.
 * A second launch just brings the first window forward.
 */
const isFirstInstance = app.requestSingleInstanceLock();

if (!isFirstInstance) {
    app.quit();
} else {
    app.on("second-instance", () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }

            mainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        if (embedEngine) {
            try {
                engine = await startApi();
            } catch (error) {
                dialog.showErrorBox(
                    "SyncBridge could not start",
                    `The networking engine failed to start. Another program may be using ports 41234 to 41236.\n\n${
                        error instanceof Error ? error.message : String(error)
                    }`
                );

                app.quit();

                return;
            }
        }

        if (!isDev) {
            registerAppProtocol();
        }

        createWindow();
        startClipboardWatcher();

        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    });
}

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("before-quit", (event) => {
    if (clipboardTimer) {
        clearInterval(clipboardTimer);
        clipboardTimer = null;
    }

    /*
     * Stop the engine cleanly (it flushes history) before the process
     * exits. Quitting again after cancelling this event is unreliable
     * on macOS, so once the engine is down the process exits directly.
     */
    if (engine) {
        const running = engine;

        engine = null;
        event.preventDefault();

        void running.stop().finally(() => app.exit(0));
    }
});
