import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import type { Baseline, BaselineEntry } from "./sync-state";

export interface ScannedFile {
    relativePath: string;
    size: number;
    mtimeMs: number;
}

/**
 * Recursively lists every regular file under `rootFolder`, as
 * relative POSIX-style paths (so entries are stable across
 * platforms). Symlinks are skipped to avoid cycles.
 */
export function scanFolder(
    rootFolder: string
): ScannedFile[] {
    const results: ScannedFile[] = [];

    function walk(currentDir: string): void {
        let entries: fs.Dirent[];

        try {
            entries = fs.readdirSync(
                currentDir,
                { withFileTypes: true }
            );
        } catch (error) {
            console.error(
                `[SYNC] Failed to read directory ${currentDir}:`,
                error
            );

            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(
                currentDir,
                entry.name
            );

            if (entry.isDirectory()) {
                walk(fullPath);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            let stats: fs.Stats;

            try {
                stats = fs.statSync(fullPath);
            } catch {
                continue;
            }

            const relativePath = path
                .relative(rootFolder, fullPath)
                .split(path.sep)
                .join("/");

            results.push({
                relativePath,
                size: stats.size,
                mtimeMs: stats.mtimeMs,
            });
        }
    }

    walk(rootFolder);

    return results;
}

export function checksumFile(
    absolutePath: string
): string {
    return createHash("sha256")
        .update(fs.readFileSync(absolutePath))
        .digest("hex");
}

export interface FolderDiff {
    /**
     * New or modified files, with a checksum already computed so
     * the caller can tell a real content change from a touched but
     * otherwise identical file.
     */
    changed: Array<ScannedFile & { checksum: string }>;

    /**
     * Relative paths that were present in the baseline but are no
     * longer on disk.
     */
    deleted: string[];
}

/**
 * Compares a fresh scan against the last known baseline. A file is
 * only hashed if its size or mtime differ from the baseline, so
 * scanning a large, mostly-unchanged folder stays cheap.
 */
export function diffAgainstBaseline(
    rootFolder: string,
    scanned: ScannedFile[],
    baseline: Baseline
): FolderDiff {
    const changed: Array<
        ScannedFile & { checksum: string }
    > = [];

    const seen = new Set<string>();

    for (const file of scanned) {
        seen.add(file.relativePath);

        const baselineEntry = baseline.get(
            file.relativePath
        );

        const looksUnchanged =
            baselineEntry &&
            baselineEntry.size === file.size &&
            baselineEntry.mtimeMs === file.mtimeMs;

        if (looksUnchanged) {
            continue;
        }

        const checksum = checksumFile(
            path.join(rootFolder, file.relativePath)
        );

        if (
            baselineEntry &&
            baselineEntry.checksum === checksum
        ) {
            // Content is identical; only the mtime changed (e.g. a
            // touch or a checkout). Not a real change.
            continue;
        }

        changed.push({ ...file, checksum });
    }

    const deleted: string[] = [];

    for (const relativePath of baseline.keys()) {
        if (!seen.has(relativePath)) {
            deleted.push(relativePath);
        }
    }

    return { changed, deleted };
}

export function toBaselineEntry(
    file: ScannedFile & { checksum: string }
): BaselineEntry {
    return {
        size: file.size,
        mtimeMs: file.mtimeMs,
        checksum: file.checksum,
    };
}
