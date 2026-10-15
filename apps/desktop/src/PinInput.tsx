import {
    useRef,
    type ClipboardEvent,
    type KeyboardEvent,
} from "react";

interface PinInputProps {
    value: string;
    onChange: (value: string) => void;
    onComplete?: (value: string) => void;
    length?: number;
    disabled?: boolean;
    invalid?: boolean;
    autoFocus?: boolean;
}

/** One box per digit; typing advances, backspace retreats, paste fills. */
export function PinInput({
    value,
    onChange,
    onComplete,
    length = 6,
    disabled,
    invalid,
    autoFocus,
}: PinInputProps) {
    const refs = useRef<Array<HTMLInputElement | null>>([]);

    const focusBox = (index: number) => {
        refs.current[Math.max(0, Math.min(length - 1, index))]?.focus();
    };

    const commit = (next: string) => {
        const digits = next.replace(/\D/g, "").slice(0, length);

        onChange(digits);

        if (digits.length === length) {
            onComplete?.(digits);
        }
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
        if (event.key === "Backspace" && !value[index]) {
            event.preventDefault();
            commit(value.slice(0, Math.max(0, index - 1)));
            focusBox(index - 1);
        } else if (event.key === "ArrowLeft") {
            focusBox(index - 1);
        } else if (event.key === "ArrowRight") {
            focusBox(index + 1);
        }
    };

    const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
        event.preventDefault();
        const pasted = event.clipboardData
            .getData("text")
            .replace(/\D/g, "")
            .slice(0, length);

        commit(pasted);
        focusBox(pasted.length);
    };

    return (
        <div
            className={`pin-boxes${invalid ? " invalid" : ""}`}
            role="group"
            aria-label={`${length}-digit PIN`}
        >
            {Array.from({ length }, (_, index) => (
                <input
                    key={index}
                    ref={(node) => {
                        refs.current[index] = node;
                    }}
                    className="pin-box"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={1}
                    disabled={disabled}
                    autoFocus={autoFocus && index === 0}
                    value={value[index] ?? ""}
                    aria-label={`Digit ${index + 1}`}
                    onChange={(event) => {
                        const digit = event.target.value.replace(/\D/g, "").slice(-1);

                        if (!digit) {
                            return;
                        }

                        commit(value.slice(0, index) + digit + value.slice(index + 1));
                        focusBox(index + 1);
                    }}
                    onKeyDown={(event) => onKeyDown(event, index)}
                    onPaste={onPaste}
                    onFocus={(event) => event.target.select()}
                />
            ))}
        </div>
    );
}
