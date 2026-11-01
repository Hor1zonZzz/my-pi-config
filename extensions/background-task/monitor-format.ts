import { boundedTail, clip, codeBlock, formatDuration, type StateTone, type TaskStatus } from "./format.ts";

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_TIMEOUT_MS = 30 * 60 * 1000;
export const MIN_TIMEOUT_MS = 1000;
const EVENT_LINES = 40;
const EVENT_LINE_CHARS = 500;
const EVENT_BYTES = 4 * 1024;
const DESCRIPTION_CHARS = 120;
const COMMAND_CHARS = 500;

export type MonitorStopReason = "user" | "shutdown" | "timeout" | "flood";

export interface MonitorRecord {
	id: string;
	description: string;
	command: string;
	cwd: string;
	sessionId: string;
	/** Cleaned stdout: every line here was also an event. */
	logPath: string;
	stderrPath: string;
	pgid?: number;
	startedAt: number;
	endedAt?: number;
	timeoutMs: number;
	status: TaskStatus;
	exitCode?: number;
	signal?: string;
	stopReason?: MonitorStopReason;
	error?: string;
	/** stdout lines seen. */
	lines: number;
	/** Event notifications delivered. */
	events: number;
}

export interface EventBatch {
	/** 1-based log line number of the first line. */
	firstLine: number;
	lines: string[];
}

export function clampTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
	return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(timeoutMs)));
}

function label(monitor: MonitorRecord): string {
	return `${monitor.id} (${clip(monitor.description.trim().replace(/\s+/g, " "), DESCRIPTION_CHARS)})`;
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The lines of one batch that fit in a notification, plus how many were left out. */
function boundedEvent(lines: readonly string[]): { shown: string[]; omitted: number } {
	const shown: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		if (shown.length >= EVENT_LINES) break;
		const clipped = clip(line, EVENT_LINE_CHARS);
		bytes += Buffer.byteLength(clipped) + 1;
		if (bytes > EVENT_BYTES && shown.length > 0) break;
		shown.push(clipped);
	}
	return { shown, omitted: lines.length - shown.length };
}

function eventBlock(monitor: MonitorRecord, batch: EventBatch): string[] {
	const { shown, omitted } = boundedEvent(batch.lines);
	const block = [codeBlock(shown.join("\n"))];
	if (omitted > 0) {
		const last = batch.firstLine + batch.lines.length - 1;
		block.push(`${plural(omitted, "more line")} omitted; see ${monitor.logPath} lines ${batch.firstLine}–${last}.`);
	}
	return block;
}

export function eventMessage(monitor: MonitorRecord, batch: EventBatch): string {
	return [`Monitor ${label(monitor)} event:`, ...eventBlock(monitor, batch)].join("\n");
}

export function monitorOutcomeText(monitor: MonitorRecord): string {
	if (monitor.status === "running") return "is running";
	if (monitor.status === "failed") return `failed to run: ${monitor.error ?? "unknown error"}`;
	if (monitor.status === "stopped") {
		switch (monitor.stopReason) {
			case "user":
				return "was stopped by the user";
			case "timeout":
				return "expired";
			case "flood":
				return "was stopped for producing too many events";
			default:
				return "was stopped";
		}
	}
	if (monitor.signal) return `was terminated by ${monitor.signal} (exit ${monitor.exitCode})`;
	return `exited with code ${monitor.exitCode}`;
}

/** A compact outcome for the monitor list. */
export function shortMonitorOutcome(monitor: MonitorRecord): { text: string; tone: StateTone } {
	if (monitor.status === "running") return { text: "running", tone: "running" };
	if (monitor.status === "failed") return { text: "failed", tone: "error" };
	if (monitor.status === "stopped") {
		if (monitor.stopReason === "timeout") return { text: "expired", tone: "muted" };
		if (monitor.stopReason === "flood") return { text: "flooded", tone: "error" };
		return { text: "stopped", tone: "muted" };
	}
	if (monitor.signal) return { text: monitor.signal, tone: "muted" };
	return { text: `exit ${monitor.exitCode}`, tone: monitor.exitCode === 0 ? "success" : "error" };
}

export function finalMessage(
	monitor: MonitorRecord,
	pending: EventBatch | undefined,
	stderrTail: readonly string[],
): string {
	const elapsed = formatDuration((monitor.endedAt ?? monitor.startedAt) - monitor.startedAt);
	const lines = [
		`Monitor ${label(monitor)} ${monitorOutcomeText(monitor)} after ${elapsed}: ${plural(monitor.events, "event")}, ${plural(monitor.lines, "line")}.`,
	];
	if (monitor.stopReason === "timeout") {
		lines.push("Start a new monitor with the same command if the watch is still needed.");
	} else if (monitor.stopReason === "flood") {
		lines.push(
			"Start it again with a tighter filter that emits only the lines you would act on, or write the output to a file and read it on demand.",
		);
	}
	lines.push(
		"",
		`Command: ${clip(monitor.command.trim().replace(/\s*\n\s*/g, " ; "), COMMAND_CHARS)}`,
		`Output: ${monitor.logPath}`,
	);
	if (pending && pending.lines.length > 0) {
		lines.push("", "Final events:", ...eventBlock(monitor, pending));
	}
	const stderr = boundedTail(stderrTail);
	if (stderr.length > 0) {
		lines.push("", `Last stderr lines (${monitor.stderrPath}):`, codeBlock(stderr.join("\n")));
	}
	return lines.join("\n");
}

export function monitorStartedMessage(monitor: MonitorRecord): string {
	const stop = monitor.pgid
		? `Stop it early with \`kill -- -${monitor.pgid}\` (signals the whole process group).`
		: "Its process group ID was not reported yet; it can be stopped with the user's /bg command.";
	return [
		`Started monitor ${monitor.id}${monitor.pgid ? ` (process group ${monitor.pgid})` : ""}; it expires in ${formatDuration(monitor.timeoutMs)}.`,
		"Each stdout line is delivered to you as an event, and its end is reported; do not poll or sleep waiting for events.",
		`stdout: ${monitor.logPath}`,
		`stderr (not events): ${monitor.stderrPath}`,
		stop,
	].join("\n");
}
