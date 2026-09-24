import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { Language } from "./runtime.ts";
import type { NestedCall } from "./tools.ts";

export interface CodeDetails {
	language: Language;
	/** Most recent nested calls (bounded). */
	calls: NestedCall[];
	/** Total nested calls, including any dropped from `calls`. */
	callCount: number;
	running: boolean;
	durationMs?: number;
	exitCode?: number | null;
	fullOutputPath?: string;
}

interface RenderState {
	details?: CodeDetails;
}

const CODE_PREVIEW_LINES = 4;
const CALL_PREVIEW = 6;
const OUTPUT_PREVIEW_LINES = 8;

/** Renders precomputed lines, truncated to the available width. */
class Lines implements Component {
	private readonly lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(width: number): string[] {
		return this.lines.map((line) => truncateToWidth(line, Math.max(1, width)));
	}
	invalidate(): void {}
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`;
}

function textOf(content: ReadonlyArray<{ type: string; text?: string }> | undefined): string {
	return (content ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n")
		.replace(/\r/g, "")
		.replace(/\t/g, "  ");
}

export function renderCodeCall(
	args: { language?: string; code?: string; timeout?: number },
	theme: Theme,
	context: { expanded: boolean },
): Component {
	const language = args.language === "python" ? "python" : "javascript";
	const code = (args.code ?? "").replace(/\t/g, "  ").replace(/\s+$/, "");
	const codeLines = code ? code.split("\n") : [];
	let header = `${theme.fg("toolTitle", theme.bold("execute_code"))} ${theme.fg("accent", language)}`;
	header += theme.fg("dim", ` · ${codeLines.length} ${codeLines.length === 1 ? "line" : "lines"}`);
	if (typeof args.timeout === "number" && args.timeout > 0) header += theme.fg("dim", ` · timeout ${args.timeout}s`);
	const lines = [header];
	if (codeLines.length > 0) {
		const shown = context.expanded ? codeLines : codeLines.slice(0, CODE_PREVIEW_LINES);
		const highlighted = highlightCode(shown.join("\n"), language);
		lines.push(...highlighted.map((line) => `  ${line}`));
		const hidden = codeLines.length - shown.length;
		if (hidden > 0) lines.push(theme.fg("dim", `  … ${hidden} more ${hidden === 1 ? "line" : "lines"}`));
	}
	return new Lines(lines);
}

function callLine(call: NestedCall, theme: Theme): string {
	const icon =
		call.status === "running"
			? theme.fg("muted", "…")
			: call.status === "ok"
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");
	let line = `  ${icon} ${theme.fg("accent", call.tool)}`;
	if (call.label) line += ` ${theme.fg("muted", call.label)}`;
	if (call.durationMs !== undefined && call.status !== "running") {
		line += theme.fg("dim", ` ${formatDuration(call.durationMs)}`);
	}
	if (call.status === "error" && call.error) line += theme.fg("error", ` — ${call.error}`);
	return line;
}

export function renderCodeResult(
	result: { content?: ReadonlyArray<{ type: string; text?: string }>; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: { state: RenderState; isError: boolean },
): Component {
	// Failed runs throw, and a thrown result carries no details; keep the last ones we saw.
	const own = result.details as CodeDetails | undefined;
	if (own && Array.isArray(own.calls)) context.state.details = own;
	const details = own ?? context.state.details;
	const lines: string[] = [];

	if (details && details.callCount > 0) {
		const calls = options.expanded ? details.calls : details.calls.slice(-CALL_PREVIEW);
		const earlier = details.callCount - calls.length;
		if (earlier > 0) lines.push(theme.fg("dim", `  … ${earlier} earlier ${earlier === 1 ? "call" : "calls"}`));
		lines.push(...calls.map((call) => callLine(call, theme)));
	}

	const output = textOf(result.content).replace(/\s+$/, "");
	if (output) {
		const outputLines = output.split("\n");
		const shown = options.expanded ? outputLines : outputLines.slice(-OUTPUT_PREVIEW_LINES);
		const hidden = outputLines.length - shown.length;
		if (hidden > 0) lines.push(theme.fg("dim", `  … ${hidden} earlier output ${hidden === 1 ? "line" : "lines"}`));
		const color = context.isError && !options.isPartial ? "error" : "toolOutput";
		lines.push(...shown.map((line) => `  ${theme.fg(color, line)}`));
	}

	if (details && !options.isPartial && !details.running && details.durationMs !== undefined) {
		lines.push(theme.fg("dim", `  ${formatDuration(details.durationMs)}`));
	}
	return new Lines(lines);
}
