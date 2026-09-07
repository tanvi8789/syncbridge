console.log("[PRELOAD] preload script loaded");

import {
    contextBridge,
    ipcRenderer,
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
    }
);