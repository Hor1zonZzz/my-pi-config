import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { formatDuration, preview } from "./format.ts";
import { glyph } from "./render.ts";
import type { LiveRun, RunRegistry, RunSnapshot } from "./runs.ts";

// State notices: when a run inside a multi-run background job finishes while
// the job keeps going, one short message is appended to the main session.
// It is persisted like any message, so the prompt prefix only ever grows and
// provider caching and continuation are unaffected. Nothing is sent for
// activity, for foreground runs (the tool result reports them), or for the run
// that ends a job (the job's completion message reports it).

export const NOTICE_TYPE = "subagent-status";
/** Codex CLI's tag for the same purpose; codex-server-compaction never retains it as user input. */
export const NOTICE_OPEN = "<subagent_notification>";
export const NOTICE_CLOSE = "</subagent_notification>";

export interface NoticeDetails {
	job: string;
	run: string;
	agent: string;
	status: RunSnapshot["status"];
	done: number;
	total: number;
	elapsedMs: number;
}

/** How many runs of the job have finished, or undefined when this run's finish ends the job. */
export function jobProgress(run: RunSnapshot, jobRuns: RunSnapshot[]): number | undefined {
	const { kind, index, total } = run.group;
	if (run.mode !== "async" || !run.jobId || total <= 1 || run.status === "running") return undefined;
	if (kind === "chain") {
		// A chain stops at a failed or stopped step, and its last step ends the job.
		return run.status === "completed" && index < total - 1 ? index + 1 : undefined;
	}
	const done = jobRuns.filter((s) => s.status !== "running").length;
	return done < total ? done : undefined;
}

export function noticeText(d: NoticeDetails, error?: string): string {
	const body: Record<string, string> = {
		job: d.job,
		run: d.run,
		agent: d.agent,
		status: d.status === "cancelled" ? "stopped" : d.status,
		done: `${d.done}/${d.total}`,
		elapsed: formatDuration(d.elapsedMs),
	};
	if (error) body.error = preview(error, 160);
	return `${NOTICE_OPEN}\n${JSON.stringify(body)}\n${NOTICE_CLOSE}`;
}

export interface NoticeOptions {
	/** The parent session now active; notices for runs of another session are dropped. */
	sessionId(): string | undefined;
}

/** Watches the registry and sends one notice per qualifying run. Returns an unsubscribe function. */
export function watchRunNotices(pi: ExtensionAPI, registry: RunRegistry, options: NoticeOptions): () => void {
	const sent = new Set<string>();
	return registry.subscribe((changed: LiveRun | undefined) => {
		const s = changed?.snapshot;
		if (!s || s.status === "running" || sent.has(s.id) || s.parentSessionId !== options.sessionId()) return;
		const jobRuns = registry.list().map((run) => run.snapshot).filter((other) => other.jobId === s.jobId);
		const done = jobProgress(s, jobRuns);
		if (done === undefined) return;
		sent.add(s.id);
		const details: NoticeDetails = {
			job: s.jobId!,
			run: s.id.slice(0, 8),
			agent: s.agent,
			status: s.status,
			done,
			total: s.group.total,
			elapsedMs: (s.endedAt ?? Date.now()) - s.startedAt,
		};
		const error = s.status === "failed" ? s.errorMessage || s.output || s.stopReason : undefined;
		// triggerTurn false: appended at the end of the current turn, or at once when idle, without starting a turn.
		pi.sendMessage({ customType: NOTICE_TYPE, content: noticeText(details, error), display: true, details }, { triggerTurn: false });
	});
}

/** One line in the chat: `● scout completed · job subagent-1a2b3c4d · 2/4 done · 1m 12s`. */
export function noticeComponent(theme: Theme, details: NoticeDetails | undefined): Component {
	return {
		render(width: number): string[] {
			if (!details) return [];
			const status = details.status === "cancelled" ? "stopped" : details.status;
			const line = `  ${glyph(theme, details.status, 0)}  ${theme.fg("text", details.agent)} ${theme.fg("muted", status)}`
				+ theme.fg("dim", ` · job ${details.job} · ${details.done}/${details.total} done · ${formatDuration(details.elapsedMs)}`);
			return [truncateToWidth(line, width, "")];
		},
		invalidate() {},
	};
}
