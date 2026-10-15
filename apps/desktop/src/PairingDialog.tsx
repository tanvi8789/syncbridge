import { useEffect, useState } from "react";

import type { PairingPrompt } from "./api";
import { PinInput } from "./PinInput";

interface PairingDialogProps {
    prompt: PairingPrompt;
    onSubmit: (deviceId: string, pin: string) => Promise<void>;
    onCancel: (deviceId: string) => void;
}

/**
 * One side of pairing. The device being connected *to* shows a
 * 6-digit PIN; the device connecting *from* is asked to type it.
 * The PIN is never sent over the network: each side proves it
 * knows it (see docs/protocol/messages.md).
 */
export function PairingDialog({ prompt, onSubmit, onCancel }: PairingDialogProps) {
    const [pin, setPin] = useState("");
    const [busy, setBusy] = useState(false);
    const [localError, setLocalError] = useState<string | null>(null);
    const [now, setNow] = useState(() => Date.now());

    const peer = prompt.deviceName ?? prompt.deviceId.slice(0, 8);
    const secondsLeft = Math.max(0, Math.round((prompt.expiresAt - now) / 1000));
    const fraction = Math.max(0, Math.min(1, (prompt.expiresAt - now) / 120_000));

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 500);

        return () => clearInterval(timer);
    }, []);

    const submit = async (value: string) => {
        if (value.length !== 6 || busy) {
            return;
        }

        try {
            setBusy(true);
            setLocalError(null);
            await onSubmit(prompt.deviceId, value);
        } catch (err) {
            setBusy(false);
            setLocalError(
                err instanceof Error ? err.message : "Could not send the PIN"
            );
        }
    };

    const error = localError ?? prompt.error;

    return (
        <div className="modal-overlay">
            <div className="modal modal-narrow" role="dialog" aria-modal="true">
                <div className="modal-header">
                    <div>
                        <strong>
                            {prompt.kind === "display"
                                ? `Pair with ${peer}`
                                : `Enter the PIN shown on ${peer}`}
                        </strong>
                        <span className="modal-subtitle">
                            {prompt.kind === "display"
                                ? "This device has not connected here before."
                                : "You only do this once. After that the devices trust each other."}
                        </span>
                    </div>

                    <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => onCancel(prompt.deviceId)}
                    >
                        Cancel
                    </button>
                </div>

                {prompt.kind === "display" ? (
                    <>
                        <div className="pin-display" aria-label="Pairing PIN">
                            {(prompt.pin ?? "").split("").map((digit, index) => (
                                <span
                                    key={index}
                                    className="pin-tile"
                                    style={{ animationDelay: `${index * 45}ms` }}
                                >
                                    {digit}
                                </span>
                            ))}
                        </div>

                        <p className="modal-note">
                            Type this PIN on <strong>{peer}</strong> to let it
                            connect. Only continue if you started this connection
                            yourself.
                        </p>
                    </>
                ) : (
                    <>
                        <PinInput
                            value={pin}
                            onChange={setPin}
                            onComplete={(value) => void submit(value)}
                            disabled={busy}
                            invalid={Boolean(error)}
                            autoFocus
                        />

                        <div className="modal-actions">
                            <button
                                className="btn btn-primary"
                                disabled={busy || pin.length !== 6}
                                onClick={() => void submit(pin)}
                            >
                                {busy ? "Checking" : "Pair"}
                            </button>
                        </div>
                    </>
                )}

                {error && <div className="inline-error">{error}</div>}

                <div className="pairing-meter" aria-hidden="true">
                    <div
                        className="pairing-meter-fill"
                        style={{ width: `${fraction * 100}%` }}
                    />
                </div>

                <div className="modal-footnote">
                    <span>
                        {prompt.attemptsLeft} attempt
                        {prompt.attemptsLeft === 1 ? "" : "s"} left
                    </span>
                    <span>
                        {secondsLeft > 0 ? `Expires in ${secondsLeft}s` : "Expired"}
                    </span>
                </div>
            </div>
        </div>
    );
}
