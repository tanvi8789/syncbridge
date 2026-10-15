import { useState } from "react";

export const MIN_SENSITIVE_PIN_LENGTH = 6;

interface SendOptionsDialogProps {
    fileCount: number;
    deviceLabel: string;
    busy: boolean;
    onConfirm: (options: { sensitive: true; pin: string } | undefined) => void;
    onCancel: () => void;
}

/** Asked before sending: is this file sensitive? If so, set its PIN. */
export function SendOptionsDialog({
    fileCount,
    deviceLabel,
    busy,
    onConfirm,
    onCancel,
}: SendOptionsDialogProps) {
    const [sensitive, setSensitive] = useState(false);
    const [pin, setPin] = useState("");
    const [reveal, setReveal] = useState(false);

    const pinValid = pin.length >= MIN_SENSITIVE_PIN_LENGTH;

    return (
        <div className="visualizer-overlay" onClick={onCancel}>
            <div
                className="visualizer-panel pairing-dialog"
                role="dialog"
                aria-modal="true"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="visualizer-header">
                    <div>
                        <strong>
                            Send {fileCount} file{fileCount === 1 ? "" : "s"} to{" "}
                            {deviceLabel}
                        </strong>
                        <span className="visualizer-subtitle">
                            Mark files as sensitive to lock them with a PIN.
                        </span>
                    </div>

                    <button
                        className="visualizer-close"
                        aria-label="Cancel"
                        onClick={onCancel}
                    >
                        ✕
                    </button>
                </div>

                <label className="sensitive-toggle">
                    <input
                        type="checkbox"
                        checked={sensitive}
                        onChange={(event) => setSensitive(event.target.checked)}
                    />
                    <span>
                        <strong>This file is sensitive</strong>
                        <small>
                            It is encrypted before sending, and the receiver can
                            only open it by entering the same PIN.
                        </small>
                    </span>
                </label>

                {sensitive && (
                    <div className="pairing-form">
                        <input
                            className="pairing-input pin-text"
                            type={reveal ? "text" : "password"}
                            autoFocus
                            autoComplete="off"
                            placeholder={`PIN (min ${MIN_SENSITIVE_PIN_LENGTH} characters)`}
                            value={pin}
                            onChange={(event) => setPin(event.target.value)}
                            aria-label="PIN for this file"
                        />
                        <button
                            type="button"
                            className="connect-button"
                            onClick={() => setReveal((value) => !value)}
                        >
                            {reveal ? "Hide" : "Show"}
                        </button>
                    </div>
                )}

                {sensitive && (
                    <p className="pairing-hint">
                        Tell the receiver this PIN yourself (in person or by
                        message). It is never sent by SyncBridge. A longer
                        passphrase is safer than a short number.
                    </p>
                )}

                <div className="pairing-actions">
                    <button className="disconnect-button" onClick={onCancel}>
                        Cancel
                    </button>
                    <button
                        className="connect-button"
                        disabled={busy || (sensitive && !pinValid)}
                        onClick={() =>
                            onConfirm(sensitive ? { sensitive: true, pin } : undefined)
                        }
                    >
                        {busy ? "Sending…" : sensitive ? "Encrypt & send" : "Send"}
                    </button>
                </div>
            </div>
        </div>
    );
}

interface UnlockDialogProps {
    onUnlock: (pin: string) => Promise<void>;
    onCancel: () => void;
}

/** Receiver side: enter the sender's PIN to decrypt a locked file. */
export function UnlockDialog({ onUnlock, onCancel }: UnlockDialogProps) {
    const [pin, setPin] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
        try {
            setBusy(true);
            setError(null);
            await onUnlock(pin);
        } catch (err) {
            setBusy(false);
            setError(err instanceof Error ? err.message : "Could not unlock the file");
        }
    };

    return (
        <div className="visualizer-overlay" onClick={onCancel}>
            <div
                className="visualizer-panel pairing-dialog"
                role="dialog"
                aria-modal="true"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="visualizer-header">
                    <div>
                        <strong>Unlock sensitive file</strong>
                        <span className="visualizer-subtitle">
                            Enter the PIN the sender gave you.
                        </span>
                    </div>

                    <button
                        className="visualizer-close"
                        aria-label="Cancel"
                        onClick={onCancel}
                    >
                        ✕
                    </button>
                </div>

                <form
                    className="pairing-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    <input
                        className="pairing-input pin-text"
                        type="password"
                        autoFocus
                        autoComplete="off"
                        placeholder="PIN"
                        value={pin}
                        onChange={(event) => setPin(event.target.value)}
                        aria-label="File PIN"
                    />
                    <button
                        type="submit"
                        className="connect-button"
                        disabled={busy || pin.length === 0}
                    >
                        {busy ? "Unlocking…" : "Unlock"}
                    </button>
                </form>

                {error && <div className="pairing-error">{error}</div>}
            </div>
        </div>
    );
}
