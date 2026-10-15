export type ToastKind = "error" | "success" | "info";

export interface Toast {
    id: number;
    kind: ToastKind;
    message: string;
}

interface ToastStackProps {
    toasts: Toast[];
    onDismiss: (id: number) => void;
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
    if (toasts.length === 0) {
        return null;
    }

    return (
        <div className="toast-stack" aria-live="polite">
            {toasts.map((toast) => (
                <div
                    key={toast.id}
                    className={`toast toast-${toast.kind}`}
                    role={toast.kind === "error" ? "alert" : "status"}
                >
                    <span className="toast-message">{toast.message}</span>
                    <button
                        type="button"
                        className="toast-dismiss"
                        onClick={() => onDismiss(toast.id)}
                    >
                        Dismiss
                    </button>
                </div>
            ))}
        </div>
    );
}
