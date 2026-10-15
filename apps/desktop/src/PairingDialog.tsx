import { useEffect, useState } from "react";

import type { PairingPrompt } from "./api";

interface PairingDialogProps {
    prompt: PairingPrompt;
    onSubmit: (deviceId: string, pin: string) => Promise<void>;
    onCancel: (deviceId: string) => void;
}

/**
 * One side of pairing. The device being connected *to* shows a
 * 6-digit PIN; the device connecting *from* is asked to type it.
 * The PIN is never sent over the network — each side proves it
 * knows it (see docs/protocol/messages.md).
 */
export function PairingDialog({ prompt, onSubmit, onCancel }: PairingDialogProps) {
    const [pin, setPin] = useState("");
    const [busy, setBusy] = useState(false);
    const [localError, setLocalError] = useState<string | null>(null);
    const [secondsLeft, setSecondsLeft] = useState(() =>
        Math.max(0, Math.round((prompt.expiresAt - Date.now()) / 1000))
    );

    const peer = prompt.deviceName ?? prompt.deviceId.slice(0, 8);

    useEffect(() => {
        const timer = setInterval(
            () =>
                setSecondsLeft(
                    Math.max(0, Math.round((prompt.expiresAt - Date.now()) / 1000))
                ),
            1000
        );

        return () => clearInterval(timer);
    }, [prompt.expiresAt]);

    const submit = async () => {
        try {
            setBusy(true);
            setLocalError(null);
            await onSubmit(prompt.deviceId, pin);
        } catch (err) {
            setBusy(false);
            setLocalError(
                err instanceof Error ? err.message : "Could not send the PIN"
            );
        }
    };

    const error = localError ?? prompt.error;

    return (
        <div className="visualizer-overlay">
            <div className="visualizer-panel pairing-dialog" role="dialog" aria-modal="true">
                <div className="visualizer-header">
                    <div>
                        <strong>
                            {prompt.kind === "display"
                                ? `Pair with ${peer}`
                                : `Enter the PIN shown on ${peer}`}
                        </strong>
                        <span className="visualizer-subtitle">
                            {prompt.kind === "display"
                                ? "This is the first time this device has connected."
                                : "Pairing happens once; after that these devices trust each other."}
                        </span>
                    </div>

                    <button
                        className="visualizer-close"
                        aria-label="Cancel pairing"
                        onClick={() => onCancel(prompt.deviceId)}
                    >
                        ✕
                    </button>
                </div>

                {prompt.kind === "display" ? (
                    <>
                        <div className="pairing-pin" aria-label="Pairing PIN">
                            {(prompt.pin ?? "").split("").join(" ")}
                        </div>
                        <p className="pairing-hint">
                            Type this PIN on <strong>{peer}</strong> to allow it to
                            connect. Only continue if you started this connection
                            yourself.
                        </p>
                    </>
                ) : (
                    <form
                        className="pairing-form"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void submit();
                        }}
                    >
                        <input
                            className="pairing-input"
                            inputMode="numeric"
                            autoFocus
                            autoComplete="off"
                            maxLength={6}
                            placeholder="000000"
                            value={pin}
                            onChange={(event) =>
                                setPin(event.target.value.replace(/\D/g, ""))
                            }
                            aria-label="6-digit PIN"
                        />
                        <button
                            type="submit"
                            className="connect-button"
                            disabled={busy || pin.length !== 6}
                        >
                            {busy ? "Checking…" : "Pair"}
                        </button>
                    </form>
                )}

                {error && <div className="pairing-error">{error}</div>}

                <div className="pairing-footer">
                    <span>
                        {prompt.attemptsLeft} attempt
                        {prompt.attemptsLeft === 1 ? "" : "s"} left
                    </span>
                    <span>
                        {secondsLeft > 0
                            ? `Expires in ${secondsLeft}s`
                            : "Expired"}
                    </span>
                </div>
            </div>
        </div>
    );
}
