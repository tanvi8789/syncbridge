export enum ClipboardMessageType {
    CLIPBOARD_UPDATE = "CLIPBOARD_UPDATE",
}

/**
 * A clipboard change pushed to every connected peer.
 *
 * `contentHash` is what both sides de-duplicate on: a device that
 * has just written an incoming clipboard to its own OS clipboard
 * will see its local watcher fire, and must not echo the same
 * content back around the mesh.
 */
export interface ClipboardUpdate {
    type: ClipboardMessageType.CLIPBOARD_UPDATE;
    version: string;

    clipboardId: string;
    senderDeviceId: string;

    /** Only text is carried today; images/files are future work. */
    format: "text";

    content: string;
    contentHash: string;

    timestamp: number;
}
