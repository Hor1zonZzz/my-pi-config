import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentScope } from "./agents.ts";
import {
	describeToolCall,
	emptyUsage,
	finalOutput,
	formatDuration,
	formatTokens,
	formatUsage,
	preview,
	type RunStatus,
	shortenPath,
	sumUsage,
} from "./format.ts";
import type { GroupKind, RunSnapshot } from "./runs.ts";

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface PendingTask {
	agent: string;
	task: string;
	index: number;
}

/** Tool-result details (version 2). Version 1 stored `results` with full messages. */
export interface SubagentDetails {
	version: 2;
	mode: GroupKind;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	runs: RunSnapshot[];
	pending: PendingTask[];
	async?: boolean;
	jobId?: string;
	/** Set on the immediate result of an async dispatch. */
	dispatched?: boolean;
}

type Status = RunStatus | "pending";

class Lines implements Component {
	private readonly produce: (width: number) => string[];
	constructor(produce: (width: number) => string[]) {
		this.produce = produce;
	}
	render(width: number): string[] {
		return this.produce(width).map((line) => truncateToWidth(line, width, ""));
	}
	invalidate(): void {}
}

/** Left text, spaces, then right text, never wider than `width`; the left side gives way first. */
export function spread(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(left, width, "");
	let head = left;
	if (visibleWidth(head) + rightWidth > width) head = truncateToWidth(head, width - rightWidth, "…");
	return head + " ".repeat(Math.max(0, width - visibleWidth(head) - rightWidth)) + right;
}

export function frame(now: number): number {
	return Math.floor(now / 80);
}

export function glyph(theme: Theme, status: Status, now: number): string {
	switch (status) {
		case "running":
			return theme.fg("accent", SPINNER[frame(now) % SPINNER.length]!);
		case "completed":
			return theme.fg("success", "●");
		case "failed":
			return theme.fg("error", "✕");
		case "cancelled":
			return theme.fg("warning", "○");
		default:
			return theme.fg("dim", "·");
	}
}

export function elapsed(run: RunSnapshot, now: number): number {
	return (run.endedAt ?? now) - run.startedAt;
}

/** Right-hand status for a run: activity while running, duration and output tokens afterwards. */
export function runRight(theme: Theme, run: RunSnapshot, now: number): string {
	const time = formatDuration(elapsed(run, now));
	if (run.status === "running") return theme.fg("muted", `${run.activity ?? "starting"} · ${time}`);
	if (run.status === "failed") {
		const reason = run.exitCode && run.exitCode !== 0 ? `exit ${run.exitCode}` : run.stopReason ?? "failed";
		return theme.fg("error", reason) + theme.fg("dim", ` · ${time}`);
	}
	if (run.status === "cancelled") return theme.fg("warning", "stopped") + theme.fg("dim", ` · ${time}`);
	return theme.fg("dim", `${time} · ↓${formatTokens(run.usage.output)}`);
}

function groupStatus(details: SubagentDetails): Status {
	const runs = details.runs;
	if (details.dispatched) return "running";
	if (runs.length === 0) return "pending";
	if (runs.some((run) => run.status === "running")) return "running";
	if (runs.some((run) => run.status === "failed")) return "failed";
	if (runs.some((run) => run.status === "cancelled")) return "cancelled";
	// Between chain steps, or while parallel tasks wait for a free slot.
	if (details.pending.length > 0) return "running";
	return "completed";
}

function title(theme: Theme, label: string): string {
	return theme.fg("toolTitle", theme.bold(label));
}

// --- Version 1 compatibility ----------------------------------------------

interface LegacyResult {
	agent: string;
	agentSource?: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages?: Array<{ role: string; content?: unknown }>;
	stderr?: string;
	usage?: RunSnapshot["usage"];
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

/** Normalize current or legacy details; undefined when there is nothing to draw. */
export function readDetails(value: unknown): SubagentDetails | undefined {
	const d = value as (Partial<SubagentDetails> & { results?: LegacyResult[]; status?: string }) | undefined;
	if (!d || typeof d !== "object") return undefined;
	if (d.version === 2 && Array.isArray(d.runs)) return { pending: [], ...d } as SubagentDetails;
	if (!Array.isArray(d.results)) return undefined;
	const mode = (d.mode ?? "single") as GroupKind;
	const runs = d.results.map((r, index): RunSnapshot => {
		const failed = r.exitCode > 0 || r.stopReason === "error" || r.stopReason === "aborted";
		const messages = r.messages ?? [];
		const toolCalls: string[] = [];
		for (const message of messages) {
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const part of message.content as Array<{ type: string; name?: string; arguments?: Record<string, unknown> }>) {
				if (part.type === "toolCall") toolCalls.push(describeToolCall(part.name ?? "tool", part.arguments));
			}
		}
		return {
			version: 1,
			id: `legacy-${index}`,
			parentSessionId: "",
			agent: r.agent,
			agentSource: r.agentSource ?? "unknown",
			task: r.task,
			cwd: "",
			mode: d.jobId ? "async" : "sync",
			group: { kind: mode, index, total: d.results!.length },
			status: r.exitCode === -1 ? "running" : failed ? "failed" : "completed",
			startedAt: 0,
			endedAt: 0,
			usage: r.usage ?? emptyUsage(),
			model: r.model,
			exitCode: r.exitCode,
			stopReason: r.stopReason,
			errorMessage: r.errorMessage,
			stderr: r.stderr,
			output: failed ? r.errorMessage || r.stderr || finalOutput(messages) : finalOutput(messages),
			toolCalls,
			sessionDir: "",
		};
	});
	return {
		version: 2,
		mode,
		agentScope: (d.agentScope ?? "user") as AgentScope,
		projectAgentsDir: d.projectAgentsDir ?? null,
		runs,
		pending: [],
		jobId: d.jobId,
		dispatched: d.status === "running" && runs.length === 0 && Boolean(d.jobId),
	};
}

// --- Tool row -------------------------------------------------------------

interface ToolArgs {
	agent?: string;
	task?: string;
	tasks?: Array<{ agent: string; task: string }>;
	chain?: Array<{ agent: string; task: string }>;
	async?: boolean;
}

function argsAgents(args: ToolArgs): string[] {
	return args.chain?.map((i) => i.agent) ?? args.tasks?.map((i) => i.agent) ?? (args.agent ? [args.agent] : []);
}

/** The tool row's first line: status, mode, and group totals. */
export function headerLine(theme: Theme, args: ToolArgs, details: SubagentDetails | undefined, width: number, now: number): string {
	const agents = argsAgents(args);
	const status: Status = details ? groupStatus(details) : "pending";
	const mark = details?.dispatched ? theme.fg("accent", "↗") : glyph(theme, status, now);
	let label: string;
	if (details?.dispatched || (args.async && !details)) {
		label = `${agents.join(", ") || "…"} · background${details?.jobId ? ` ${details.jobId}` : ""}`;
	} else if (args.chain?.length) {
		const current = details ? Math.min(args.chain.length, details.runs.length) : 0;
		label = `chain · step ${Math.max(1, current)}/${args.chain.length}`;
	} else if (args.tasks?.length) {
		const done = details?.runs.filter((run) => run.status !== "running").length ?? 0;
		label = `parallel · ${done}/${args.tasks.length} done`;
	} else {
		label = `${args.agent ?? "…"} · ${preview(args.task ?? "", 200)}`;
	}
	let right = "";
	if (details && details.runs.length > 0 && !details.dispatched) {
		const start = Math.min(...details.runs.map((run) => run.startedAt));
		const end = details.runs.some((run) => run.status === "running") ? now : Math.max(...details.runs.map((run) => run.endedAt ?? now));
		right = theme.fg("dim", `${formatDuration(end - start)} · ↓${formatTokens(sumUsage(details.runs.map((r) => r.usage)).output)}`);
	}
	return spread(`  ${mark}  ${title(theme, "subagent")}  ${theme.fg("accent", label)}`, right ? `  ${right}  ` : "", width);
}

function runRow(theme: Theme, run: RunSnapshot | PendingTask, last: boolean, width: number, now: number): string {
	const branch = theme.fg("dim", last ? "└" : "├");
	if (!("status" in run)) {
		return spread(`     ${branch} ${glyph(theme, "pending", now)} ${theme.fg("text", run.agent)}  ${theme.fg("dim", preview(run.task, 200))}`, `  ${theme.fg("dim", "queued")}  `, width);
	}
	const left = `     ${branch} ${glyph(theme, run.status, now)} ${theme.fg("text", run.agent)}  ${theme.fg("dim", preview(run.task, 200))}`;
	return spread(left, `  ${runRight(theme, run, now)}  `, width);
}

function subLine(theme: Theme, text: string, color: "dim" | "error" | "muted", width: number): string {
	return truncateToWidth(`     ${theme.fg("dim", "╰")} ${theme.fg(color, preview(text, 400))}`, width, theme.fg("dim", "…"));
}

function outputLine(run: RunSnapshot): string {
	const text = (run.output ?? "").split("\n").find((line) => line.trim()) ?? "";
	return text.trim();
}

/** Collapsed body under the header: one sub-line for a single run, one row per task for groups. */
export function bodyLines(theme: Theme, details: SubagentDetails, width: number, now: number): string[] {
	if (details.dispatched) {
		return [subLine(theme, "running in the background · press ↓ on an empty prompt to watch or stop it", "dim", width)];
	}
	if (details.mode === "single") {
		const run = details.runs[0];
		if (!run) return [];
		if (run.status === "running") return [subLine(theme, run.activity ?? "starting", "muted", width)];
		const line = outputLine(run);
		return line ? [subLine(theme, line, run.status === "failed" ? "error" : "dim", width)] : [];
	}
	const rows: Array<RunSnapshot | PendingTask> = [...details.runs, ...details.pending].sort(
		(a, b) => ("group" in a ? a.group.index : a.index) - ("group" in b ? b.group.index : b.index),
	);
	return rows.map((row, i) => runRow(theme, row, i === rows.length - 1, width, now));
}

/** Expanded view: every run with its task, tool calls, output, usage, and transcript location. */
export function expandedComponent(theme: Theme, details: SubagentDetails): Component {
	const container = new Container();
	const markdown = getMarkdownTheme();
	const now = Date.now();
	const runs = [...details.runs].sort((a, b) => a.group.index - b.group.index);
	for (const run of runs) {
		container.addChild(new Spacer(1));
		const label = details.mode === "chain" ? `step ${run.group.index + 1} · ${run.agent}` : run.agent;
		const status = run.status === "running" ? "running" : run.status;
		container.addChild(new Lines((width) => [
			spread(`  ${glyph(theme, run.status, now)}  ${title(theme, label)} ${theme.fg("muted", `(${run.agentSource}) ${status}`)}`, `  ${runRight(theme, run, now)}  `, width),
		]));
		container.addChild(new Lines((width) => wrapTextWithAnsi(theme.fg("dim", `Task: ${run.task}`), Math.max(10, width - 4)).map((l) => `    ${l}`)));
		if (run.toolCalls.length > 0) {
			container.addChild(new Lines((width) => run.toolCalls.map((call) => truncateToWidth(`    ${theme.fg("muted", "→")} ${theme.fg("toolOutput", call)}`, width, "…"))));
		}
		if (run.output) {
			container.addChild(new Spacer(1));
			if (run.status === "failed") container.addChild(new Text(theme.fg("error", run.output), 4, 0));
			else container.addChild(new Markdown(run.output.trim(), 4, 0, markdown));
		}
		const usage = formatUsage(run.usage, run.model);
		const where = run.sessionDir ? `transcript: /subagent-history · ${shortenPath(run.sessionDir)}` : "";
		container.addChild(new Lines((width) => [usage, where].filter(Boolean).map((l) => truncateToWidth(`    ${theme.fg("dim", l)}`, width, "…"))));
	}
	if (details.pending.length > 0) {
		container.addChild(new Lines((width) => details.pending.map((p, i) => runRow(theme, p, i === details.pending.length - 1, width, now))));
	}
	if (runs.length > 1) {
		const total = formatUsage(sumUsage(runs.map((r) => r.usage)));
		if (total) container.addChild(new Lines((width) => ["", truncateToWidth(`  ${theme.fg("dim", `Total: ${total}`)}`, width, "…")]));
	}
	// Markdown and Text keep their padding even in very narrow terminals; clamp every line.
	return new Lines((width) => container.render(width));
}

export function toolCallComponent(theme: Theme, getArgs: () => ToolArgs, getDetails: () => SubagentDetails | undefined): Component {
	return new Lines((width) => [headerLine(theme, getArgs(), getDetails(), width, Date.now())]);
}

export function toolBodyComponent(theme: Theme, details: SubagentDetails | undefined, expanded: boolean, fallbackText: string): Component {
	if (!details) return new Lines((width) => (fallbackText ? [subLine(theme, fallbackText, "muted", width)] : []));
	if (expanded && !details.dispatched && details.runs.length > 0) return expandedComponent(theme, details);
	return new Lines((width) => bodyLines(theme, details, width, Date.now()));
}

// --- Async completion card ------------------------------------------------

export interface CompletionDetails {
	jobId?: string;
	status?: string;
	result?: { content?: Array<{ type: string; text?: string }>; details?: unknown };
}

export function completionComponent(theme: Theme, content: string, value: unknown, expanded: boolean): Component {
	const d = (value ?? {}) as CompletionDetails;
	const details = readDetails(d.result?.details);
	const status = (d.status === "completed" || d.status === "failed" || d.status === "cancelled" ? d.status : "completed") as Status;
	const now = Date.now();
	const agents = details ? [...new Set(details.runs.map((r) => r.agent))].join(", ") : "";
	const header = new Lines((width) => {
		let right = "";
		if (details && details.runs.length > 0) {
			const start = Math.min(...details.runs.map((r) => r.startedAt));
			const end = Math.max(...details.runs.map((r) => r.endedAt ?? now));
			right = theme.fg("dim", `${start ? `${formatDuration(end - start)} · ` : ""}↓${formatTokens(sumUsage(details.runs.map((r) => r.usage)).output)}`);
		}
		const label = `${d.jobId ?? "background job"} ${status}${agents ? ` · ${agents}` : ""}`;
		return [spread(`  ${glyph(theme, status, now)}  ${title(theme, "subagent")}  ${theme.fg("accent", label)}`, right ? `  ${right}  ` : "", width)];
	});
	const container = new Container();
	container.addChild(header);
	const clamped = new Lines((width) => container.render(width));
	if (!details) {
		container.addChild(new Markdown(content, 4, 0, getMarkdownTheme()));
		return clamped;
	}
	if (expanded) {
		container.addChild(expandedComponent(theme, details));
		return clamped;
	}
	if (details.mode === "single" && details.runs[0]) {
		const run = details.runs[0];
		const lines = (run.output ?? "").split("\n").filter((l) => l.trim()).slice(0, 3);
		container.addChild(new Lines((width) => lines.map((l) => subLine(theme, l, run.status === "failed" ? "error" : "dim", width))));
	} else {
		container.addChild(new Lines((width) => bodyLines(theme, details, width, now)));
	}
	return clamped;
}

// --- Panel below the editor -----------------------------------------------

export function panelLines(theme: Theme, runs: RunSnapshot[], selected: number | undefined, width: number, now: number): string[] {
	if (runs.length === 0) return [];
	const lines: string[] = [];
	const count = `${runs.length} subagent${runs.length === 1 ? "" : "s"} running`;
	lines.push(truncateToWidth(
		selected === undefined
			? `  ${theme.fg("dim", "▸")} ${theme.fg("muted", count)}${theme.fg("dim", "  ·  ↓ select")}`
			: `  ${theme.fg("accent", "▾")} ${theme.fg("muted", count)}${theme.fg("dim", "  ·  ↑↓ select · enter view · x stop · esc back")}`,
		width,
		"",
	));
	runs.forEach((run, i) => {
		const active = i === selected;
		const marker = active ? theme.fg("accent", "›") : " ";
		const mode = run.mode === "async" ? theme.fg("dim", " bg") : "";
		const left = `  ${marker} ${glyph(theme, run.status, now)} ${theme.fg(active ? "accent" : "text", run.agent)}${mode}  ${theme.fg("dim", preview(run.task, 200))}`;
		const line = spread(left, `  ${runRight(theme, run, now)}  `, width);
		lines.push(active ? theme.bg("selectedBg", line) : line);
	});
	return lines;
}
