import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { formatDuration } from "./format.ts";
import { glyph } from "./render.ts";
import type { LiveRun, RunRegistry, RunSnapshot } from "./runs.ts";
import { shortRunId } from "./store.ts";
import { initialStatus, modelStatus } from "./tool.ts";

// State notices for background runs. The dispatch result names every run with
// its initial state (running or queued); after that, each change of state
// appends one persisted line to the main session, and nothing is appended
// while the state stays the same. The change that ends a job is carried by the
// job's final message with the answers instead. Notices never start a turn.

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

/** Watches the registry and appends a notice for each change of a background run's state. */
export function watchRunNotices(pi: ExtensionAPI, registry: RunRegistry, options: NoticeOptions): () => void {
	const lastSent = new Map<string, RunSnapshot["status"]>();
	return registry.subscribe((changed: LiveRun | undefined) => {
		const s = changed?.snapshot;
		if (!s || s.mode !== "async" || !s.jobId || s.parentSessionId !== options.sessionId()) return;
		// The dispatch result already said "running" for tasks that started at once.
		const previous = lastSent.get(s.id) ?? initialStatus(s.group.kind, s.group.index);
		if (previous === s.status) return;
		lastSent.set(s.id, s.status);
		if (s.status !== "running") {
			const jobRuns = registry.list().map((run) => run.snapshot).filter((other) => other.jobId === s.jobId);
			if (endsJob(s, jobRuns)) return;
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
