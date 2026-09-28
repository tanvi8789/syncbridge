console.log("[PRELOAD] preload script loaded");

import {
    contextBridge,
    ipcRenderer,
    webUtils,
} from "electron";

contextBridge.exposeInMainWorld(
    "electronAPI",
    {
        selectFile: (): Promise<
            string | null
        > =>
            ipcRenderer.invoke(
                "select-file"
            ),

        showInFolder: (filePath: string): Promise<void> =>
            ipcRenderer.invoke(
                "show-in-folder",
                filePath
            ),

        selectFolder: (): Promise<
            string | null
        > =>
            ipcRenderer.invoke(
                "select-folder"
            ),

        /*
         * Electron removed File.path in v32, so a dropped file's
         * real path has to be resolved here in the preload, where
         * webUtils is available.
         */
        getPathForFile: (file: File): string =>
            webUtils.getPathForFile(file),

        readClipboard: (): Promise<string> =>
            ipcRenderer.invoke("clipboard:read"),

        writeClipboard: (text: string): Promise<boolean> =>
            ipcRenderer.invoke("clipboard:write", text),
    }
);
