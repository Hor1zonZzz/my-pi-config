import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { formatDuration } from "./format.ts";
import { glyph, type SubagentDetails } from "./render.ts";
import type { LiveRun, RunRegistry, RunSnapshot } from "./runs.ts";
import { shortRunId } from "./store.ts";
import { initialStatus, modelStatus, resultBlock } from "./tool.ts";

// What a background job tells the main agent between its dispatch result and
// its final message:
// - parallel: a run that finishes while others still run delivers its own
//   <subagent_result> at once and wakes the main agent; the job's final message
//   then carries only the answers not delivered yet.
// - chain: a step that completes while later steps follow appends a one-line
//   <subagent_notification> (its answer feeds the next step), and a later step
//   starting appends one too. Notices never start a turn.
// Nothing is sent while a state holds, for the change that ends a job (the
// final message reports it), for the main agent's own stops, or for runs
// cancelled with their whole job.

export const NOTICE_TYPE = "subagent-status";
/** Codex CLI's tag for the same purpose; codex-server-compaction never retains it as user input. */
export const NOTICE_OPEN = "<subagent_notification>";
export const NOTICE_CLOSE = "</subagent_notification>";

/** Kept in the message details for the chat line; the model sees only run and status. */
export interface NoticeDetails {
	run: string;
	agent: string;
	status: RunSnapshot["status"];
	job?: string;
	elapsedMs: number;
}

/** True when this run's finish ends its background job, so the final message reports it. */
export function endsJob(run: RunSnapshot, jobRuns: RunSnapshot[]): boolean {
	const { kind, index, total } = run.group;
	if (total <= 1) return true;
	// A chain stops at a failed or stopped step, and its last step ends it.
	if (kind === "chain") return run.status !== "completed" || index === total - 1;
	return jobRuns.filter((s) => s.status !== "running").length >= total;
}

export function noticeText(run: string, status: RunSnapshot["status"]): string {
	return `${NOTICE_OPEN}\n${JSON.stringify({ run, status: modelStatus(status) })}\n${NOTICE_CLOSE}`;
}

export interface NoticeOptions {
	/** The parent session now active; notices for runs of another session are dropped. */
	sessionId(): string | undefined;
}

/** One run's answer, delivered ahead of its job's final message; rendered like a completion card. */
function deliverResult(pi: ExtensionAPI, run: LiveRun): void {
	const s = run.snapshot;
	const snapshot = { ...s, usage: { ...s.usage }, toolCalls: [...s.toolCalls], group: { ...s.group } };
	const details: SubagentDetails = { version: 2, mode: "single", agentScope: "user", projectAgentsDir: null, runs: [snapshot], pending: [] };
	const text = resultBlock(snapshot);
	run.delivered = true;
	pi.sendMessage(
		{ customType: "subagent-completion", content: text, display: true, details: { jobId: s.jobId, status: modelStatus(s.status), result: { content: [{ type: "text", text }], details } } },
		{ deliverAs: "steer", triggerTurn: true },
	);
}

/** Watches the registry and reports background runs' changes of state as described above. */
export function watchRunNotices(pi: ExtensionAPI, registry: RunRegistry, options: NoticeOptions): () => void {
	const lastSent = new Map<string, RunSnapshot["status"]>();
	return registry.subscribe((changed: LiveRun | undefined) => {
		const s = changed?.snapshot;
		if (!s || s.mode !== "async" || !s.jobId || s.parentSessionId !== options.sessionId()) return;
		// The dispatch result already said "running" for tasks that started at once.
		// Keyed by job: a run continued with subagent_control starts over in a new job.
		const key = `${s.jobId}:${s.id}`;
		const previous = lastSent.get(key) ?? initialStatus(s.group.kind, s.group.index);
		if (previous === s.status) return;
		lastSent.set(key, s.status);
		// The main agent learned about its own stop from subagent_control's result;
		// a run cancelled without a stop went down with its whole job.
		if (s.status === "cancelled" && changed?.stoppedBy !== "user") return;
		if (s.status === "running" && s.group.kind !== "chain") return;
		if (s.status !== "running") {
			const jobRuns = registry.list().map((run) => run.snapshot).filter((other) => other.jobId === s.jobId);
			if (endsJob(s, jobRuns)) return;
			if (s.group.kind === "parallel" && changed) {
				deliverResult(pi, changed);
				return;
			}
		}
		const details: NoticeDetails = {
			run: shortRunId(s.id),
			agent: s.agent,
			status: s.status,
			job: s.jobId,
			elapsedMs: (s.endedAt ?? Date.now()) - s.startedAt,
		};
		// triggerTurn false: appended at the end of the current turn, or at once when idle, without starting a turn.
		pi.sendMessage({ customType: NOTICE_TYPE, content: noticeText(details.run, s.status), display: true, details }, { triggerTurn: false });
	});
}

/** One line in the chat: `● scout a3f9c2e1 completed · 1m 12s`. */
export function noticeComponent(theme: Theme, details: NoticeDetails | undefined): Component {
	return {
		render(width: number): string[] {
			if (!details) return [];
			const time = details.status === "running" ? "" : ` · ${formatDuration(details.elapsedMs)}`;
			const line = `  ${glyph(theme, details.status, 0)}  ${theme.fg("text", details.agent)} ${theme.fg("dim", details.run)} ${theme.fg("muted", modelStatus(details.status))}${theme.fg("dim", time)}`;
			return [truncateToWidth(line, width, "")];
		},
		invalidate() {},
	};
}
