import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WeeklyQuota } from "./quota.ts";

export const REFRESH_MS = 5 * 60 * 1000;

export interface QuotaCache {
	version: 1;
	attemptedAt: number;
	nextCheckAt: number;
	state: "pending" | "ok" | "error";
	quota?: WeeklyQuota;
}

function hasCode(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

async function readCache(path: string, now: number): Promise<QuotaCache | undefined> {
	try {
		const json = await readFile(path, "utf8");
		if (json.length > 4096) return undefined;
		const value = JSON.parse(json) as QuotaCache;
		if (value?.version !== 1 || !["pending", "ok", "error"].includes(value.state)
			|| !Number.isFinite(value.attemptedAt) || !Number.isFinite(value.nextCheckAt)
			|| value.attemptedAt < 0 || value.attemptedAt > now
			|| value.nextCheckAt !== value.attemptedAt + REFRESH_MS) return undefined;
		if (value.quota !== undefined && (!value.quota
			|| !Number.isFinite(value.quota.remainingPercent)
			|| value.quota.remainingPercent < 0 || value.quota.remainingPercent > 100
			|| (value.quota.resetAt !== undefined && !Number.isFinite(value.quota.resetAt)))) return undefined;
		return value;
	} catch {
		return undefined;
	}
}

async function writeCache(path: string, value: QuotaCache): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function releaseLock(path: string, owner: string): Promise<void> {
	try {
		await unlink(join(path, owner));
	} catch (error) {
		if (hasCode(error, "ENOENT")) return;
		throw error;
	}
	try {
		await rmdir(path);
	} catch (error) {
		// Another process may have atomically replaced the now-empty directory.
		// Never recursively remove a directory that could belong to its new owner.
		if (!hasCode(error, "ENOENT") && !hasCode(error, "ENOTEMPTY") && !hasCode(error, "EEXIST")) throw error;
	}
}

/** Publish a nonempty directory atomically, so there is no ownerless-lock gap. */
async function tryLock(root: string, path: string): Promise<(() => Promise<void>) | undefined> {
	const owner = `${process.pid}-${randomUUID()}`;
	const prepared = await mkdtemp(join(root, ".claim-"));
	try {
		await writeFile(join(prepared, owner), "", { flag: "wx", mode: 0o600 });
		try {
			await rename(prepared, path);
			return () => releaseLock(path, owner);
		} catch (error) {
			if (!hasCode(error, "ENOTEMPTY") && !hasCode(error, "EEXIST")) throw error;
		}
		const owners = await readdir(path).catch(() => []);
		if (owners.length === 1 && /^\d+-[a-f0-9-]{36}$/.test(owners[0])) {
			try {
				process.kill(Number(owners[0].split("-")[0]), 0);
			} catch (error) {
				if (hasCode(error, "ESRCH")) await releaseLock(path, owners[0]);
			}
		}
		// A busy or recovered lock is retried by the next local status tick.
		return undefined;
	} finally {
		await rm(prepared, { recursive: true, force: true });
	}
}

/** One quota attempt per identity per five minutes, shared across Pi processes. */
export async function getSharedQuota(options: {
	root: string;
	key: string;
	signal: AbortSignal;
	query: () => Promise<WeeklyQuota | undefined>;
	now?: () => number;
}): Promise<QuotaCache | undefined> {
	if (!/^[a-f0-9]{64}$/.test(options.key)) throw new Error("Invalid Codex quota cache key");
	const now = options.now ?? Date.now;
	const path = join(options.root, `${options.key}.json`);
	let cached = await readCache(path, now());
	if (options.signal.aborted || (cached && cached.nextCheckAt > now())) return cached;
	await mkdir(options.root, { recursive: true, mode: 0o700 });
	const release = await tryLock(options.root, join(options.root, `${options.key}.lock`));
	if (!release) return (await readCache(path, now())) ?? cached;
	try {
		// Another process could have refreshed after our first read.
		cached = await readCache(path, now());
		if (options.signal.aborted || (cached && cached.nextCheckAt > now())) return cached;
		const attemptedAt = now();
		const pending: QuotaCache = {
			version: 1, attemptedAt, nextCheckAt: attemptedAt + REFRESH_MS,
			state: "pending", quota: cached?.quota,
		};
		// Persist the cooldown BEFORE querying. Even a killed process cannot cause
		// the other sessions to immediately repeat an already-issued request.
		await writeCache(path, pending);
		let result: QuotaCache;
		try {
			options.signal.throwIfAborted();
			const quota = await options.query();
			options.signal.throwIfAborted();
			result = { ...pending, state: "ok", quota };
		} catch {
			result = { ...pending, state: "error" };
		}
		await writeCache(path, result);
		return result;
	} finally {
		await release();
	}
}
