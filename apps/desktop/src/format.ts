/** Shared value formatters for the analytics and history views. */

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes)) {
        return "—";
    }

    if (bytes < 1024) {
        return `${Math.round(bytes)} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatRate(bytesPerSecond?: number): string {
    if (bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) {
        return "—";
    }

    return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(ms?: number): string {
    if (ms === undefined || !Number.isFinite(ms)) {
        return "—";
    }

    if (ms < 1000) {
        return `${Math.round(ms)} ms`;
    }

    if (ms < 60_000) {
        return `${(ms / 1000).toFixed(1)} s`;
    }

    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);

    return `${minutes}m ${seconds}s`;
}

export function formatMs(ms?: number): string {
    if (ms === undefined || !Number.isFinite(ms)) {
        return "—";
    }

    return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

export function formatPercent(ratio?: number): string {
    if (ratio === undefined || !Number.isFinite(ratio)) {
        return "—";
    }

    return `${(ratio * 100).toFixed(ratio >= 0.995 || ratio === 0 ? 0 : 1)}%`;
}

export function formatCount(value: number): string {
    return value.toLocaleString();
}

export function formatDay(epochMs: number): string {
    return new Date(epochMs).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
    });
}
