import { constants } from "node:os";

export const TAIL_LINES = 30;
const TAIL_LINE_CHARS = 300;
const TAIL_BYTES = 4 * 1024;
const COMMAND_CHARS = 500;

export type TaskStatus = "running" | "exited" | "stopped" | "failed";
export type StopReason = "user" | "shutdown" | "timeout";

export interface TaskRecord {
	id: string;
	command: string;
	cwd: string;
	sessionId: string;
	logPath: string;
	pgid?: number;
	startedAt: number;
	endedAt?: number;
	status: TaskStatus;
	exitCode?: number;
	signal?: string;
	stopReason?: StopReason;
	error?: string;
	lines: number;
	/** Set when a `bash` call was moved to the background after running this long. */
	promotedAfterMs?: number;
	/** The `bash` call's timeout in seconds, which still applies in the background. */
	timeout?: number;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Shells report a signal-terminated command as 128 + the signal number. */
export function signalFromExitCode(exitCode: number | undefined): string | undefined {
	if (exitCode === undefined || exitCode <= 128) return undefined;
	const number = exitCode - 128;
	return Object.entries(constants.signals).find(([, value]) => value === number)?.[0];
}

export function firstLine(command: string, max = 80): string {
	const lines = command.trim().split("\n");
	const line = lines[0] ?? "";
	const more = lines.length > 1 ? " …" : "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : `${line}${more}`;
}

export function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function codeBlock(text: string): string {
	const longestRun = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longestRun + 1);
	return `${fence}text\n${text}\n${fence}`;
}

export function boundedTail(lines: readonly string[]): string[] {
	const selected: string[] = [];
	let bytes = 0;
	for (let index = lines.length - 1; index >= 0 && selected.length < TAIL_LINES; index--) {
		const line = clip(lines[index], TAIL_LINE_CHARS);
		bytes += Buffer.byteLength(line) + 1;
		if (bytes > TAIL_BYTES) break;
		selected.unshift(line);
	}
	return selected;
}

export function outcomeText(task: TaskRecord): string {
	if (task.status === "running") return "is running";
	if (task.status === "failed") return `failed to run: ${task.error ?? "unknown error"}`;
	if (task.status === "stopped") {
		if (task.stopReason === "timeout") return `was killed by its ${task.timeout}-second timeout`;
		return task.stopReason === "user" ? "was stopped by the user" : "was stopped";
	}
	if (task.signal) return `was terminated by ${task.signal} (exit ${task.exitCode})`;
	return `exited with code ${task.exitCode}`;
}

export function completionMessage(task: TaskRecord, tail: readonly string[]): string {
	const elapsed = formatDuration((task.endedAt ?? task.startedAt) - task.startedAt);
	const lines = [
		`Background task ${task.id} ${outcomeText(task)} after ${elapsed}.`,
		"",
		`Command: ${clip(task.command.trim().replace(/\s*\n\s*/g, " ; "), COMMAND_CHARS)}`,
		`Working directory: ${task.cwd}`,
		`Log: ${task.logPath} (${task.lines} line${task.lines === 1 ? "" : "s"})`,
	];
	const shown = boundedTail(tail);
	if (shown.length > 0) {
		const firstShown = task.lines - shown.length + 1;
		lines.push(
			"",
			`Last ${shown.length} line${shown.length === 1 ? "" : "s"} (from line ${firstShown}):`,
			codeBlock(shown.join("\n")),
		);
	} else {
		lines.push("", "The command produced no output.");
	}
	return lines.join("\n");
}

export function startedMessage(task: TaskRecord): string {
	const stop = task.pgid
		? `Stop it with \`kill -- -${task.pgid}\` (signals the whole process group).`
		: "Its process group ID was not reported yet; it can be stopped with the user's /bg command.";
	return [
		`Started background task ${task.id}${task.pgid ? ` (process group ${task.pgid})` : ""}.`,
		`Log: ${task.logPath}`,
		"Its exit will be reported automatically with the exit code and the end of the log; do not poll or sleep waiting for it.",
		stop,
	].join("\n");
}

/** The `bash` result for a command that is still running and continues in the background. */
export function promotedMessage(task: TaskRecord, tail: readonly string[]): string {
	const after = formatDuration(task.promotedAfterMs ?? 0);
	const lines = [
		`The command was still running after ${after}, so it continues as background task ${task.id}${task.pgid ? ` (process group ${task.pgid})` : ""}.`,
		`Log: ${task.logPath} (complete output from the start; ${task.lines} line${task.lines === 1 ? "" : "s"} so far)`,
		"Its exit will be reported automatically with the exit code and the end of the log; do not poll, sleep, or rerun the command waiting for it.",
	];
	if (task.timeout !== undefined) lines.push(`It is still killed when its ${task.timeout}-second timeout expires.`);
	lines.push(
		task.pgid
			? `Stop it with \`kill -- -${task.pgid}\` (signals the whole process group).`
			: "Its process group ID is unknown; the user can stop it with /bg stop.",
	);
	const shown = boundedTail(tail);
	if (shown.length > 0) {
		lines.push("", `Output so far (last ${shown.length} line${shown.length === 1 ? "" : "s"}):`, codeBlock(shown.join("\n")));
	} else {
		lines.push("", "No output so far.");
	}
	return lines.join("\n");
}

/** Tones for compact list states, mapped to theme colors by the UI. */
export type StateTone = "running" | "success" | "error" | "muted";

/** A compact outcome for the task list. */
export function shortOutcome(task: TaskRecord): { text: string; tone: StateTone } {
	if (task.status === "running") return { text: "running", tone: "running" };
	if (task.status === "failed") return { text: "failed", tone: "error" };
	if (task.stopReason === "timeout") return { text: "timeout", tone: "error" };
	if (task.status === "stopped") return { text: "stopped", tone: "muted" };
	if (task.signal) return { text: task.signal, tone: "muted" };
	return { text: `exit ${task.exitCode}`, tone: task.exitCode === 0 ? "success" : "error" };
}

/**
 * The periodic reminder for a task still running. `newLines` is the output added since the
 * previous reminder (or since the start), so a stalled task is visible at a glance.
 */
export function checkMessage(
	task: TaskRecord,
	elapsedMs: number,
	lineCount: number,
	/** Lines added since the previous reminder; undefined for the first one. */
	newLines: number | undefined,
	tail: readonly string[],
): string {
	const elapsed = formatDuration(elapsedMs);
	const progress =
		newLines === undefined
			? ""
			: newLines > 0
				? ` (${newLines} new line${newLines === 1 ? "" : "s"} since the last check)`
				: " (no new output since the last check)";
	const stop = task.pgid ? `\`kill -- -${task.pgid}\`` : "the user's /bg stop";
	const lines = [
		`Background task ${task.id} is still running after ${elapsed}${progress}.`,
		`Check that it is progressing as expected. If it is stuck, failing, or no longer needed, stop it with ${stop} and adjust; if it looks fine, say so in one line and continue. Its exit is still reported automatically, so do not poll or sleep waiting for it.`,
		"",
		`Command: ${clip(task.command.trim().replace(/\s*\n\s*/g, " ; "), COMMAND_CHARS)}`,
		`Log: ${task.logPath} (${lineCount} line${lineCount === 1 ? "" : "s"} so far)`,
	];
	const shown = boundedTail(tail);
	if (shown.length > 0) {
		lines.push("", `Last ${shown.length} line${shown.length === 1 ? "" : "s"}:`, codeBlock(shown.join("\n")));
	} else {
		lines.push("", "No output so far.");
	}
	return lines.join("\n");
}

const PREVIEW_LINE_CHARS = 240;

/** The last `count` lines, clipped for message details that renderers show without parsing content. */
export function previewLines(lines: readonly string[], count: number): string[] {
	return lines.slice(-count).map((line) => clip(line, PREVIEW_LINE_CHARS));
}
