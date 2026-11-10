/**
 * The dream worker's status file, `<memory>/dream-status.json`: the detached worker writes it, and every
 * Pi session of the project reads it for the footer and to report the last result on the next start.
 * No Pi imports, so `node --test` can run it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DreamResult } from "./dream.ts";
import { pidAlive, writeFileAtomic } from "./store.ts";

export const STATUS_FILE = "dream-status.json";
export const WORKER_LOG = "dream-worker.log";

export type DreamState = "running" | DreamResult["status"];

export interface DreamStatus {
	state: DreamState;
	/** The worker process. */
	pid: number;
	trigger: "manual" | "auto";
	startedAt: number;
	finishedAt?: number;
	/** One line for the user, set when the worker finishes. */
	summary?: string;
	/** Set once a Pi session has shown the result. */
	reported?: boolean;
}

export async function readDreamStatus(dir: string): Promise<DreamStatus | undefined> {
	try {
		const raw = JSON.parse(await readFile(join(dir, STATUS_FILE), "utf8")) as Partial<DreamStatus>;
		if (typeof raw.state !== "string" || typeof raw.pid !== "number" || typeof raw.startedAt !== "number") return undefined;
		return raw as DreamStatus;
	} catch {
		return undefined;
	}
}

export async function writeDreamStatus(dir: string, status: DreamStatus): Promise<void> {
	await writeFileAtomic(join(dir, STATUS_FILE), `${JSON.stringify(status, null, 2)}\n`);
}

/** A worker that said "running" but whose process is gone died mid-dream (killed, or the machine stopped). */
export function isDreamRunning(status: DreamStatus | undefined, alive: (pid: number) => boolean = pidAlive): boolean {
	return status?.state === "running" && alive(status.pid);
}

/** What the next Pi session should say about a dream it has not reported yet, or undefined. */
export function pendingReport(status: DreamStatus | undefined, alive: (pid: number) => boolean = pidAlive): string | undefined {
	if (!status || status.reported) return undefined;
	if (status.state === "running") {
		return alive(status.pid) ? undefined : "上次 Dream 中途退出（进程被结束或电脑关机），这些会话下次会重新读取。";
	}
	if (status.state === "nothing" && status.trigger === "auto") return undefined;
	return status.summary;
}

export function failureSummary(reason: string | undefined): string {
	return `上次 Dream 失败：${reason ?? "未知错误"}（详见 calls.jsonl 与 dream-worker.log）`;
}

export function summarize(result: DreamResult): string {
	switch (result.status) {
		case "unavailable":
			return `上次 Dream 无法运行：${result.reason}`;
		case "error":
			return failureSummary(result.reason);
		case "aborted":
			return "上次 Dream 被停止，这些会话下次会重新读取。";
		case "nothing":
			return "上次 Dream：上次整理之后（最近 3 天内）没有新会话。";
		default:
			return `上次 Dream 完成：读取 ${result.sessions} 个会话${result.organizeFailed ? "，整理失败" : ""} · 新增 ${result.created} · 修改 ${result.updated} · 删除 ${result.deleted}（含被动 ${result.removedPassive}）· 验证被动笔记 ${result.confirmed}`;
	}
}
