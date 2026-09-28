import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

const API_BASE_URL = "http://127.0.0.1:41235";

/*
 * How often the main process samples the OS clipboard. Electron
 * exposes no change event, so polling is the only option; 1s is
 * responsive enough to feel instant while costing nothing.
 */
const CLIPBOARD_POLL_MS = 1000;

let mainWindow: BrowserWindow | null = null;
let clipboardTimer: NodeJS.Timeout | null = null;

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
        mainWindow.loadFile(
            path.join(__dirname, "../dist/index.html")
        );
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

app.whenReady().then(() => {
    createWindow();
    startClipboardWatcher();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("before-quit", () => {
    if (clipboardTimer) {
        clearInterval(clipboardTimer);
        clipboardTimer = null;
    }
});
