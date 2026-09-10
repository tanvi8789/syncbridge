import { app, BrowserWindow, dialog, ipcMain } from "electron";

import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename =
    fileURLToPath(import.meta.url);

const __dirname =
    path.dirname(__filename);

const isDev =
    !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
    console.log(
        "[ELECTRON] Preload path:",
        path.join(__dirname, "..", "electron-build", "preload.cjs")
    );

    mainWindow =
        new BrowserWindow({
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
        mainWindow.loadURL(
            "http://localhost:5173"
        );
    } else {
        mainWindow.loadFile(
            path.join(
                __dirname,
                "../dist/index.html"
            )
        );
    }

    mainWindow.on(
        "closed",
        () => {
            mainWindow = null;
        }
    );
}

ipcMain.handle(
    "select-file",
    async () => {
        const result =
            (await dialog.showOpenDialog({
                properties: [
                    "openFile",
                ],
            })) as unknown as {
                canceled: boolean;
                filePaths: string[];
            };

        if (
            result.canceled ||
            result.filePaths.length === 0
        ) {
            return null;
        }

        return result.filePaths[0];
    }
);

app.whenReady().then(() => {
    mainWindow =
        null;
    
    createWindow();

    

    app.on(
        "activate",
        () => {
            if (
                BrowserWindow
                    .getAllWindows()
                    .length === 0
            ) {
                createWindow();
            }
        }
    );
});

app.on(
    "window-all-closed",
    () => {
        if (
            process.platform !==
            "darwin"
        ) {
            app.quit();
        }
    }
);