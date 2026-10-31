import { mkdir, readdir, rm, stat, utimes } from "node:fs/promises";
import { basename, join } from "node:path";

/** Scratchpads untouched for this long are removed when a later session starts. */
export const SCRATCHPAD_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export function scratchpadRoot(agentDir: string): string {
	return join(agentDir, "scratchpad");
}

/** A session ID is used as a directory name, so anything unusual is made path-safe. */
export function safeSessionDirName(sessionId: string): string {
	const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
	return /^[A-Za-z0-9]/.test(safe) ? safe : `s${safe}`;
}

export function sessionScratchpad(agentDir: string, sessionId: string): string {
	return join(scratchpadRoot(agentDir), safeSessionDirName(sessionId));
}

/** Create the directory and refresh its mtime so retention counts from the latest use. */
export async function ensureScratchpad(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	await touch(dir);
}

export async function touch(dir: string): Promise<void> {
	const now = new Date();
	await utimes(dir, now, now);
}

/** Remove other sessions' scratchpads whose directory has not been touched within the retention period. */
export async function pruneScratchpads(
	root: string,
	keepDir: string,
	now = Date.now(),
	retentionMs = SCRATCHPAD_RETENTION_MS,
): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const keep = basename(keepDir);
	const removed: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === keep) continue;
		const dir = join(root, entry.name);
		try {
			const info = await stat(dir);
			if (now - info.mtimeMs <= retentionMs) continue;
			await rm(dir, { recursive: true, force: true });
			removed.push(dir);
		} catch {
			// Another Pi process may be pruning or using the same root; skip this entry.
		}
	}
	return removed;
}

export function scratchpadPromptSection(dir: string): string {
	return [
		`This session's scratchpad directory is ${dir}`,
		"Put temporary files there instead of /tmp or the project: intermediate results, throwaway scripts, downloads, and outputs that do not belong in the repository.",
		"The directory is private to this Pi session and is kept when the session is resumed. When you mention a file in it, give its full absolute path.",
	].join("\n");
}
