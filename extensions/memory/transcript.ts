/**
 * Lists Pi session files for dreams. Free of Pi imports so `node --test` can run it.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// ── Session files ────────────────────────────────────────────────────────────

export interface SessionFile {
	path: string;
	id: string;
	mtimeMs: number;
}

export function sessionIdFromFile(name: string): string {
	const base = name.replace(/\.jsonl$/, "");
	const underscore = base.indexOf("_");
	return underscore >= 0 ? base.slice(underscore + 1) : base;
}

/** Session files in `dir` changed after `since`, oldest first, leaving out `excludeId`. */
export async function sessionsSince(dir: string, since: number, excludeId?: string): Promise<SessionFile[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const out: SessionFile[] = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const id = sessionIdFromFile(name);
		if (id === excludeId) continue;
		try {
			const info = await stat(join(dir, name));
			if (info.isFile() && info.mtimeMs > since) out.push({ path: join(dir, name), id, mtimeMs: info.mtimeMs });
		} catch {}
	}
	return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}
