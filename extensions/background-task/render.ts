/**
 * TUI rendering for background tasks and monitors: the tool rows of `background_task`,
 * `monitor`, and a `bash` command moved to the background, the custom messages both managers
 * send. Both are static cards built from their result or `details` (expanded messages also
 * show the full text the model received); messages from older versions without structured
 * details fall back to that text. Current output is shown on demand by the footer viewer.
 */
import { getMarkdownTheme, type MessageRenderer, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, Spacer, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { firstLine, formatDuration, type TaskRecord } from "./format.ts";
import type { MonitorRecord } from "./monitor-format.ts";

type Color = Parameters<Theme["fg"]>[0];

const SPINNER = ["◐", "◓", "◑", "◒"];
const TICK_MS = 1000;
const COLLAPSED_TAIL = 3;
const EXPANDED_TAIL = 8;

/** A component whose lines are built for the width it is given; every line is clipped to that width. */
class Lines implements Component {
	constructor(private readonly build: (width: number) => string[]) {}
	render(width: number): string[] {
		return this.build(width).map((line) => truncateToWidth(line, Math.max(1, width)));
	}
	invalidate(): void {}
}

/** `left` and `right` on one line, `right` flush right; `right` is dropped when both do not fit. */
function spread(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : left;
}

function spinner(now = Date.now()): string {
	return SPINNER[Math.floor(now / TICK_MS) % SPINNER.length];
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The first line of `text` with tabs expanded and a trailing " …" when more lines follow. */
function oneLine(text: string): string {
	return firstLine(text.replace(/\t/g, "  "), 400);
}

/** The first line of a command, plus how many more lines it has. */
function commandHead(theme: Theme, command: string): string {
	const lines = command.trim().split("\n");
	const head = (lines[0] ?? "").replace(/\t/g, "  ").trim();
	return lines.length > 1 ? `${head}${theme.fg("muted", ` (+${lines.length - 1} lines)`)}` : head;
}

/** Output lines under a header, behind a gutter. */
function gutterLines(theme: Theme, lines: readonly string[], color: Color = "toolOutput", mark = "│"): string[] {
	return lines.map((line) => `  ${theme.fg("dim", mark)} ${theme.fg(color, oneLine(line))}`);
}

interface State {
	icon: string;
	label: string;
	color: Color;
}

function taskState(task: TaskRecord): State {
	if (task.status === "running") return { icon: spinner(), label: "running", color: "accent" };
	if (task.status === "failed") return { icon: "✗", label: "failed to start", color: "error" };
	if (task.status === "stopped") {
		if (task.stopReason === "timeout") return { icon: "✗", label: `killed by its ${task.timeout}s timeout`, color: "error" };
		return { icon: "■", label: task.stopReason === "user" ? "stopped by you" : "stopped", color: "muted" };
	}
	if (task.signal) return { icon: "■", label: `terminated by ${task.signal}`, color: "muted" };
	return task.exitCode === 0
		? { icon: "✓", label: "exit 0", color: "success" }
		: { icon: "✗", label: `exit ${task.exitCode}`, color: "error" };
}

function monitorState(monitor: MonitorRecord): State {
	if (monitor.status === "running") return { icon: spinner(), label: "watching", color: "accent" };
	if (monitor.status === "failed") return { icon: "✗", label: "failed to start", color: "error" };
	if (monitor.status === "stopped") {
		if (monitor.stopReason === "timeout") return { icon: "◷", label: "expired", color: "warning" };
		if (monitor.stopReason === "flood") return { icon: "✗", label: "stopped: too many events", color: "error" };
		return { icon: "■", label: monitor.stopReason === "user" ? "stopped by you" : "stopped", color: "muted" };
	}
	if (monitor.signal) return { icon: "■", label: `terminated by ${monitor.signal}`, color: "muted" };
	return monitor.exitCode === 0
		? { icon: "✓", label: "finished", color: "success" }
		: { icon: "✗", label: `exit ${monitor.exitCode}`, color: "error" };
}

function header(theme: Theme, state: State, id: string, text: string | undefined, right: string, width: number): string {
	let left = `${theme.fg(state.color, state.icon)} ${theme.bold(id)}  ${theme.fg(state.color, state.label)}`;
	if (text) left += theme.fg("muted", ` · ${oneLine(text)}`);
	return spread(left, theme.fg("muted", right), width);
}

// ── Tool rows ────────────────────────────────────────────────────────────────
//
// Tool rows stay in the transcript and scroll above the viewport, where Pi's differential
// renderer can only update them by clearing the screen and scrollback. Their lines therefore
// depend only on the tool result and the expanded state, never on the clock or live manager
// state. Current output is in the footer entries' viewer (↓ from the editor, Enter, Enter).

function stopHint(theme: Theme, id: string, pgid: number | undefined): string {
	return `  ${theme.fg("dim", "stop  ")} ${theme.fg("muted", pgid ? `kill -- -${pgid}  or  /bg stop ${id}` : `/bg stop ${id}`)}`;
}

export interface TaskRowInfo {
	taskId: string;
	pgid?: number;
	logPath?: string;
	/** Set for a `bash` command that moved to the background. */
	promotedAfterMs?: number;
	/** Output before the move, for a `bash` command. */
	tail?: string[];
	lines?: number;
}

export function renderTaskRow(theme: Theme, info: TaskRowInfo, expanded: boolean): Component {
	return new Lines(() => {
		const lines: string[] = [];
		const dot = theme.fg("accent", "●");
		if (info.promotedAfterMs !== undefined) {
			lines.push(
				`${dot} ${theme.bold(info.taskId)}  ${theme.fg("accent", "moved to the background")}${theme.fg("muted", ` · still running after ${formatDuration(info.promotedAfterMs)}`)}`,
			);
			const tail = (info.tail ?? []).slice(-(expanded ? EXPANDED_TAIL : COLLAPSED_TAIL));
			if (tail.length > 0) lines.push(...gutterLines(theme, tail));
		} else {
			lines.push(`${dot} ${theme.bold(info.taskId)}  ${theme.fg("accent", "started in the background")}`);
		}
		if (expanded) {
			lines.push(`  ${theme.fg("dim", "its exit is reported here; to see its output now, press ↓ from the editor, then Enter on it")}`);
			if (info.logPath) lines.push(`  ${theme.fg("dim", "log   ")} ${theme.fg("muted", info.logPath)}`);
			lines.push(stopHint(theme, info.taskId, info.pgid));
		}
		return lines;
	});
}

export function renderTaskCall(theme: Theme, command: string | undefined, cwd: string | undefined): Component {
	return new Lines(() => {
		let line = `${theme.fg("accent", theme.bold("bg"))} ${theme.fg("toolTitle", theme.bold("❯ "))}${theme.fg("toolTitle", theme.bold(commandHead(theme, command ?? "…")))}`;
		if (cwd) line += theme.fg("muted", ` in ${cwd}`);
		return [line];
	});
}

export function renderMonitorCall(
	theme: Theme,
	args: { description?: string; command?: string; timeout_ms?: number },
	expanded: boolean,
	defaultTimeoutMs: number,
): Component {
	return new Lines(() => {
		const timeout = formatDuration(args.timeout_ms ?? defaultTimeoutMs);
		const lines = [
			`${theme.fg("accent", theme.bold("mon"))} ${theme.fg("toolTitle", theme.bold(oneLine(args.description ?? "…")))}${theme.fg("muted", ` · up to ${timeout}`)}`,
		];
		if (expanded && args.command) {
			lines.push(...args.command.trim().split("\n").slice(0, 12).map((line) => `  ${theme.fg("dim", line)}`));
		}
		return lines;
	});
}

export interface MonitorRowInfo {
	monitorId: string;
	pgid?: number;
	logPath?: string;
	stderrPath?: string;
	timeoutMs?: number;
}

export function renderMonitorRow(theme: Theme, info: MonitorRowInfo, expanded: boolean): Component {
	return new Lines(() => {
		const expires = info.timeoutMs ? theme.fg("muted", ` · expires after ${formatDuration(info.timeoutMs)}`) : "";
		const lines = [`${theme.fg("accent", "●")} ${theme.bold(info.monitorId)}  ${theme.fg("accent", "watching")}${expires}`];
		if (expanded) {
			lines.push(`  ${theme.fg("dim", "each stdout line arrives here as an event; to see its output now, press ↓ from the editor, then Enter on it")}`);
			if (info.logPath) lines.push(`  ${theme.fg("dim", "stdout")} ${theme.fg("muted", info.logPath)}`);
			if (info.stderrPath) lines.push(`  ${theme.fg("dim", "stderr")} ${theme.fg("muted", info.stderrPath)}`);
			lines.push(stopHint(theme, info.monitorId, info.pgid));
		}
		return lines;
	});
}

// ── Messages ─────────────────────────────────────────────────────────────────

type Details = Record<string, unknown>;

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function clock(timestamp: number | undefined): string {
	if (!timestamp) return "";
	const date = new Date(timestamp);
	return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

/** A message card on Pi's custom message background, with the full model text when expanded. */
function card(
	theme: Theme,
	outputPad: number,
	expanded: boolean,
	content: string,
	build: ((width: number) => string[]) | undefined,
): Component {
	const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
	if (build) box.addChild(new Lines(build));
	if (expanded || !build) {
		if (build) {
			box.addChild(new Spacer(1));
			box.addChild(new Lines(() => [theme.fg("dim", "sent to the model:")]));
		}
		box.addChild(
			new Markdown(content, 0, 0, getMarkdownTheme(), { color: (text: string) => theme.fg("customMessageText", text) }),
		);
	}
	return box;
}

function taskRecordFrom(details: Details): TaskRecord {
	return {
		id: str(details.taskId) ?? "bg-?",
		command: str(details.command) ?? "",
		cwd: "",
		sessionId: "",
		logPath: str(details.logPath) ?? "",
		startedAt: 0,
		status: (str(details.status) as TaskRecord["status"]) ?? "exited",
		exitCode: num(details.exitCode),
		signal: str(details.signal),
		stopReason: str(details.stopReason) as TaskRecord["stopReason"],
		error: str(details.error),
		timeout: num(details.timeout),
		lines: num(details.lines) ?? 0,
	};
}

function monitorRecordFrom(details: Details): MonitorRecord {
	return {
		id: str(details.monitorId) ?? "mon-?",
		description: str(details.description) ?? "",
		command: "",
		cwd: "",
		sessionId: "",
		logPath: str(details.logPath) ?? "",
		stderrPath: str(details.stderrPath) ?? "",
		startedAt: 0,
		timeoutMs: num(details.timeoutMs) ?? 0,
		status: (str(details.status) as MonitorRecord["status"]) ?? "exited",
		exitCode: num(details.exitCode),
		signal: str(details.signal),
		stopReason: str(details.stopReason) as MonitorRecord["stopReason"],
		error: str(details.error),
		lines: num(details.lines) ?? 0,
		events: num(details.events) ?? 0,
	};
}

export const renderTaskMessage: MessageRenderer = (message, options, theme) => {
	const details = (message.details ?? {}) as Details;
	const content = typeof message.content === "string" ? message.content : "";
	const tail = strings(details.tail);
	const elapsedMs = num(details.elapsedMs);
	// Messages from before structured details carry no command or elapsed time.
	if (str(details.command) === undefined || elapsedMs === undefined) {
		return card(theme, options.outputPad, options.expanded, content, undefined);
	}
	const command = str(details.command) ?? "";
	const time = clock(message.timestamp);
	if (details.kind === "check") {
		const newLines = num(details.newLines);
		return card(theme, options.outputPad, options.expanded, content, (width) => {
			const state: State = { icon: "↻", label: "still running", color: "accent" };
			const lines = [header(theme, state, str(details.taskId) ?? "bg-?", undefined, `${formatDuration(elapsedMs)} · ${time}`, width)];
			const progress =
				newLines === undefined
					? theme.fg("muted", `${plural(num(details.lines) ?? 0, "line")} so far · asked the model to check it`)
					: newLines > 0
						? `${theme.fg("success", `+${plural(newLines, "line")}`)}${theme.fg("muted", " since the last check · asked the model to check it")}`
						: `${theme.fg("warning", "no new output since the last check")}${theme.fg("muted", " · asked the model to check it")}`;
			lines.push(`  ${progress}`);
			lines.push(`  ${theme.fg("dim", "❯")} ${theme.fg("muted", commandHead(theme, command))}`);
			lines.push(...gutterLines(theme, tail.slice(-COLLAPSED_TAIL)));
			return lines;
		});
	}
	const task = taskRecordFrom(details);
	return card(theme, options.outputPad, options.expanded, content, (width) => {
		const state = taskState(task);
		const lines = [
			header(theme, state, task.id, undefined, `${formatDuration(elapsedMs)} · ${plural(task.lines, "line")} · ${time}`, width),
			`  ${theme.fg("dim", "❯")} ${theme.fg("muted", commandHead(theme, command))}`,
		];
		if (task.status === "failed" && task.error) lines.push(`  ${theme.fg("error", oneLine(task.error))}`);
		lines.push(...gutterLines(theme, tail.slice(-(COLLAPSED_TAIL + 1))));
		return lines;
	});
};

export const renderMonitorMessage: MessageRenderer = (message, options, theme) => {
	const details = (message.details ?? {}) as Details;
	const content = typeof message.content === "string" ? message.content : "";
	const description = str(details.description);
	const elapsedMs = num(details.elapsedMs);
	if (description === undefined || elapsedMs === undefined) {
		return card(theme, options.outputPad, options.expanded, content, undefined);
	}
	const id = str(details.monitorId) ?? "mon-?";
	const time = clock(message.timestamp);
	const timeoutMs = num(details.timeoutMs) ?? 0;

	if (details.kind === "event") {
		const preview = strings(details.preview);
		const total = num(details.lines) ?? preview.length;
		const firstLogLine = num(details.firstLine) ?? 1;
		return card(theme, options.outputPad, options.expanded, content, (width) => {
			const state: State = { icon: "◆", label: `event ${num(details.event) ?? ""}`.trim(), color: "accent" };
			const lines = [header(theme, state, id, description, `+${formatDuration(elapsedMs)} · ${time}`, width)];
			lines.push(...gutterLines(theme, preview, "toolOutput", "▸"));
			if (total > preview.length) {
				lines.push(
					`  ${theme.fg("dim", `… ${plural(total - preview.length, "more line")} (log lines ${firstLogLine}–${firstLogLine + total - 1})`)}`,
				);
			}
			return lines;
		});
	}

	if (details.kind === "silent") {
		const stderr = strings(details.stderrTail);
		return card(theme, options.outputPad, options.expanded, content, (width) => {
			const state: State = { icon: "▲", label: `silent for ${formatDuration(elapsedMs)}`, color: "warning" };
			const lines = [
				header(theme, state, id, description, `${formatDuration(Math.max(0, timeoutMs - elapsedMs))} left · ${time}`, width),
				`  ${theme.fg("muted", "no stdout line yet · asked the model to check the script")}`,
			];
			if (stderr.length > 0) {
				lines.push(`  ${theme.fg("dim", "stderr")}`);
				lines.push(...gutterLines(theme, stderr.slice(-COLLAPSED_TAIL), "error"));
			} else {
				lines.push(`  ${theme.fg("dim", "stderr is empty")}`);
			}
			return lines;
		});
	}

	const monitor = monitorRecordFrom(details);
	const finalEvents = strings(details.finalEvents);
	const stderr = strings(details.stderrTail);
	return card(theme, options.outputPad, options.expanded, content, (width) => {
		const state = monitorState(monitor);
		const lines = [
			header(
				theme,
				state,
				id,
				description,
				`${plural(monitor.events, "event")} · ${formatDuration(elapsedMs)} · ${time}`,
				width,
			),
		];
		if (monitor.status === "failed" && monitor.error) lines.push(`  ${theme.fg("error", oneLine(monitor.error))}`);
		if (monitor.stopReason === "timeout") lines.push(`  ${theme.fg("muted", "start it again if the watch is still needed")}`);
		if (finalEvents.length > 0) lines.push(...gutterLines(theme, finalEvents.slice(0, COLLAPSED_TAIL), "toolOutput", "▸"));
		if (stderr.length > 0) {
			lines.push(`  ${theme.fg("dim", "stderr")}`);
			lines.push(...gutterLines(theme, stderr.slice(-COLLAPSED_TAIL), "error"));
		}
		return lines;
	});
};
