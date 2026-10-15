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
        <div className="modal-overlay" onClick={onCancel}>
            <div
                className="modal modal-narrow"
                role="dialog"
                aria-modal="true"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="modal-header">
                    <div>
                        <strong>
                            Send {fileCount} file{fileCount === 1 ? "" : "s"} to{" "}
                            {deviceLabel}
                        </strong>
                        <span className="modal-subtitle">
                            Sensitive files are locked with a PIN you choose.
                        </span>
                    </div>

                    <button className="btn btn-ghost btn-sm" onClick={onCancel}>
                        Cancel
                    </button>
                </div>

                <label className={`choice${sensitive ? " on" : ""}`}>
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
                    <div className="reveal">
                        <div className="field-row">
                            <input
                                className="input"
                                type={reveal ? "text" : "password"}
                                autoFocus
                                autoComplete="off"
                                placeholder={`PIN, at least ${MIN_SENSITIVE_PIN_LENGTH} characters`}
                                value={pin}
                                onChange={(event) => setPin(event.target.value)}
                                aria-label="PIN for this file"
                            />
                            <button
                                type="button"
                                className="btn"
                                onClick={() => setReveal((value) => !value)}
                            >
                                {reveal ? "Hide" : "Show"}
                            </button>
                        </div>

                        <p className="modal-note">
                            Tell the receiver this PIN yourself, in person or by
                            message. SyncBridge never sends it. A longer
                            passphrase is safer than a short number.
                        </p>
                    </div>
                )}

                <div className="modal-actions">
                    <button
                        className="btn btn-primary"
                        disabled={busy || (sensitive && !pinValid)}
                        onClick={() =>
                            onConfirm(sensitive ? { sensitive: true, pin } : undefined)
                        }
                    >
                        {busy ? "Sending" : sensitive ? "Encrypt and send" : "Send"}
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
        <div className="modal-overlay" onClick={onCancel}>
            <div
                className="modal modal-narrow"
                role="dialog"
                aria-modal="true"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="modal-header">
                    <div>
                        <strong>Unlock sensitive file</strong>
                        <span className="modal-subtitle">
                            Enter the PIN the sender gave you.
                        </span>
                    </div>

                    <button className="btn btn-ghost btn-sm" onClick={onCancel}>
                        Cancel
                    </button>
                </div>

                <form
                    className="field-row"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    <input
                        className="input"
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
                        className="btn btn-primary"
                        disabled={busy || pin.length === 0}
                    >
                        {busy ? "Unlocking" : "Unlock"}
                    </button>
                </form>

                {error && <div className="inline-error">{error}</div>}
            </div>
        </div>
    );
}
