/**
 * calls.jsonl: one line per dream agent run, with its input and output, for later analysis.
 * Free of Pi imports so `node --test` can run it.
 */
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CALLS_FILE = "calls.jsonl";
export const CALLS_ROTATED = "calls.1.jsonl";
export const CALLS_MAX_BYTES = 20 * 1024 * 1024;
export const CALLS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Older lines may also carry the retired passive-capture roles `jev-judge` and `deepseek-capture`. */
export type CallRole = "deepseek-analyze" | "deepseek-organize";

export interface CallUsage {
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
}

export interface CallRecord {
	ts: string;
	session: string;
	role: CallRole;
	provider: string;
	model: string;
	reasoning: string | null;
	latencyMs: number;
	usage: CallUsage | null;
	stopReason: string;
	error: string | null;
	input: unknown;
	output: unknown;
	/** applied | error */
	outcome: string;
}

export async function appendCall(dir: string, record: CallRecord): Promise<void> {
	await mkdir(dir, { recursive: true });
	const path = join(dir, CALLS_FILE);
	await appendFile(path, `${JSON.stringify(record)}\n`);
	try {
		if ((await stat(path)).size > CALLS_MAX_BYTES) {
			await rm(join(dir, CALLS_ROTATED), { force: true });
			await rename(path, join(dir, CALLS_ROTATED));
		}
	} catch {}
}

/** Drops lines older than 30 days from calls.jsonl. Run once per session start. */
export async function pruneCalls(dir: string, now = Date.now()): Promise<number> {
	const path = join(dir, CALLS_FILE);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return 0;
	}
	const lines = text.split("\n").filter(Boolean);
	const kept = lines.filter((line) => {
		try {
			return now - Date.parse((JSON.parse(line) as CallRecord).ts) <= CALLS_MAX_AGE_MS;
		} catch {
			return false;
		}
	});
	if (kept.length === lines.length) return 0;
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, kept.length ? `${kept.join("\n")}\n` : "");
	await rename(tmp, path);
	return lines.length - kept.length;
}

/** Deletes dream agent session files (<memory>/dreams/) older than 30 days. Run once per session start. */
export async function pruneDreamSessions(dir: string, now = Date.now()): Promise<number> {
	const dreams = join(dir, "dreams");
	let removed = 0;
	let names: string[];
	try {
		names = await readdir(dreams);
	} catch {
		return 0;
	}
	for (const name of names) {
		const path = join(dreams, name);
		try {
			if (now - (await stat(path)).mtimeMs > CALLS_MAX_AGE_MS) {
				await rm(path, { recursive: true, force: true });
				removed += 1;
			}
		} catch {}
	}
	return removed;
}

/** Newest last. */
export async function readCalls(dir: string): Promise<CallRecord[]> {
	try {
		return (await readFile(join(dir, CALLS_FILE), "utf8"))
			.split("\n")
			.filter(Boolean)
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as CallRecord];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

export interface RoleSummary {
	role: CallRole;
	calls: number;
	errors: number;
	cost: number;
	outcomes: Record<string, number>;
}

export function summarizeCalls(records: readonly CallRecord[]): { total: number; cost: number; roles: RoleSummary[] } {
	const roles = new Map<CallRole, RoleSummary>();
	let cost = 0;
	for (const record of records) {
		const summary = roles.get(record.role) ?? { role: record.role, calls: 0, errors: 0, cost: 0, outcomes: {} };
		summary.calls += 1;
		if (record.error) summary.errors += 1;
		summary.cost += record.usage?.cost ?? 0;
		summary.outcomes[record.outcome] = (summary.outcomes[record.outcome] ?? 0) + 1;
		roles.set(record.role, summary);
		cost += record.usage?.cost ?? 0;
	}
	return { total: records.length, cost, roles: [...roles.values()] };
}

export function formatCost(cost: number): string {
	if (cost === 0) return "$0";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}
