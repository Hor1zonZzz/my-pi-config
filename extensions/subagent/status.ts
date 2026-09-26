import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDuration, preview } from "./format.ts";
import type { RunRegistry, RunSnapshot } from "./runs.ts";

// A request-local <system_status> block: before each model call the main agent
// gets the current subagent list as a last user message. It is added through
// Pi's `context` event, so it is never written to the session; the next request
// replaces it with a fresh one. codex-server-compaction recognizes the tag:
// it sends full input after a request that carried it and never retains it.

export const STATUS_OPEN = "<system_status>";
export const STATUS_CLOSE = "</system_status>";

function shortId(id: string): string {
	return id.slice(0, 8);
}

function runLine(s: RunSnapshot, now: number): string {
	const time = formatDuration((s.endedAt ?? now) - s.startedAt);
	const job = s.mode === "async" && s.jobId ? `, background job ${s.jobId}` : "";
	let state: string;
	if (s.status === "running") state = `running ${time}${job}, now: ${preview(s.activity ?? "starting", 80)}`;
	else if (s.status === "completed") state = `completed in ${time}${job}`;
	else if (s.status === "cancelled") state = `stopped after ${time}${job}`;
	else state = `failed after ${time}${job}: ${preview(s.errorMessage || s.output || s.stopReason || "error", 120)}`;
	return `- ${shortId(s.id)} ${s.agent}: ${state}. Task: ${preview(s.task, 120)}`;
}

/** A background job whose runs have not started yet (the dispatch returned before they did). */
export interface StartingJob {
	id: string;
	task: string;
}

export function statusText(runs: RunSnapshot[], now = Date.now(), starting: StartingJob[] = []): string {
	const running = runs.filter((s) => s.status === "running").length;
	const counts = [`${running} running`, `${runs.length - running} just finished`];
	if (starting.length) counts.unshift(`${starting.length} starting`);
	return [
		STATUS_OPEN,
		`Subagents: ${counts.join(", ")}. This status is current for this request only and is not kept in the conversation.`,
		...starting.map((job) => `- background job ${job.id}: starting. Task: ${preview(job.task, 120)}`),
		...runs.map((s) => runLine(s, now)),
		"Use subagent_control to inspect, read, or wait for a run.",
		STATUS_CLOSE,
	].join("\n");
}

/**
 * Which runs to report: every running one, plus finished ones the model has not
 * yet seen in their final state. With nothing to report there is no block.
 */
export class StatusTracker {
	private readonly reported = new Set<string>();

	reset(): void {
		this.reported.clear();
	}

	next(registry: RunRegistry, now = Date.now(), jobs: StartingJob[] = []): string | undefined {
		const all = registry.list().map((run) => run.snapshot);
		const runs = all.filter((s) => s.status === "running" || !this.reported.has(s.id));
		const started = new Set(all.map((s) => s.jobId).filter(Boolean));
		const starting = jobs.filter((job) => !started.has(job.id));
		if (runs.length === 0 && starting.length === 0) return undefined;
		for (const s of runs) if (s.status !== "running") this.reported.add(s.id);
		return statusText(runs, now, starting);
	}
}

export function registerStatusInjection(pi: ExtensionAPI, registry: RunRegistry, jobs: () => StartingJob[] = () => []): StatusTracker {
	const tracker = new StatusTracker();
	pi.on("context", (event) => {
		const text = tracker.next(registry, Date.now(), jobs());
		if (!text) return;
		return { messages: [...event.messages, { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] };
	});
	return tracker;
}
