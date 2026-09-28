export type ClipboardEventType =
    | "CLIPBOARD_SENT"
    | "CLIPBOARD_RECEIVED"
    | "CLIPBOARD_BLOCKED";

export interface ClipboardEvent {
    id: string;
    type: ClipboardEventType;

    /** The peer this clipboard came from, or was sent to. */
    deviceId?: string;

    /** A short, display-safe excerpt — never the whole payload. */
    preview: string;
    length: number;

    timestamp: number;

    /** Threads this event back to the connection session it happened over. */
    sessionId?: string;

    /** Set on CLIPBOARD_BLOCKED to say why the update was dropped. */
    detail?: string;
}

export type ClipboardEventListener = (event: ClipboardEvent) => void;
