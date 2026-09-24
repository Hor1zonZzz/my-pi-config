import { homedir } from "node:os";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	getAgentDir,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	countLines,
	diffStats,
	displayPath,
	exitCodeOf,
	firstLine,
	formatToolDuration,
	lastLine,
	oneLine,
	readLines,
} from "./format.ts";
import { type CardModel, type CardStatus, diffSummary, renderCard, renderSubLine } from "./layout.ts";
import { C, fg, frameAt } from "./style.ts";

export const TOOL_KINDS = ["read", "bash", "edit", "write"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

type AnyTool = ToolDefinition<any, any, any>;
type RenderContext = Parameters<NonNullable<AnyTool["renderCall"]>>[2];
interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: any;
}

/** Per-row renderer state. Pi shares `context.state` between the call and result renderers. */
interface CardState {
	startedAt?: number;
	endedAt?: number;
	executionStarted?: boolean;
	isError?: boolean;
	isPartial?: boolean;
	result?: ToolResult;
	args?: any;
	cwd?: string;
	/** Pi's own renderers keep separate state and components (expanded view, skin off). */
	builtIn?: { state: Record<string, unknown>; call?: Component; result?: Component; used?: boolean; settled?: boolean };
}

export interface HairlineToolsOptions {
	isEnabled(): boolean;
	now?(): number;
}

/**
 * Built-in tool definitions with the settings Pi itself applies when it builds
 * its tools (image resizing, shell path and command prefix).
 */
export function createBaseTool(kind: ToolKind, cwd: string, settings?: SettingsManager): AnyTool {
	switch (kind) {
		case "read":
			return createReadToolDefinition(cwd, settings ? { autoResizeImages: settings.getImageAutoResize() } : undefined);
		case "bash":
			return createBashToolDefinition(
				cwd,
				settings ? { commandPrefix: settings.getShellCommandPrefix(), shellPath: settings.getShellPath() } : undefined,
			);
		case "edit":
			return createEditToolDefinition(cwd);
		case "write":
			return createWriteToolDefinition(cwd);
	}
}

class Lines implements Component {
	private readonly produce: (width: number) => string[];
	constructor(produce: (width: number) => string[]) {
		this.produce = produce;
	}
	render(width: number): string[] {
		return this.produce(width);
	}
	invalidate(): void {}
}

/** Built-in components are drawn for Pi's padded tool box; indent them under the self-drawn shell. */
class Indent implements Component {
	private readonly inner: Component;
	constructor(inner: Component) {
		this.inner = inner;
	}
	render(width: number): string[] {
		if (width <= 2) return this.inner.render(width);
		return this.inner.render(width - 2).map((line) => `  ${line}`);
	}
	invalidate(): void {
		this.inner.invalidate();
	}
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function textOf(result: ToolResult | undefined): string {
	if (!result) return "";
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => (block.text ?? "").replace(ANSI, "").replace(/\r/g, ""))
		.join("\n");
}

function statusOf(s: CardState): CardStatus {
	if (s.isError) return "error";
	if (s.result && !s.isPartial) return "ok";
	return s.executionStarted ? "running" : "pending";
}

function argText(kind: ToolKind, args: any, cwd: string): string {
	if (kind === "bash") return typeof args?.command === "string" ? oneLine(args.command) : "…";
	const raw = args?.path ?? args?.file_path;
	if (typeof raw !== "string" || !raw) return "…";
	const path = displayPath(raw, cwd, homedir());
	if (kind !== "read" || (args.offset === undefined && args.limit === undefined)) return path;
	const start = typeof args.offset === "number" ? args.offset : 1;
	return typeof args.limit === "number" ? `${path}:${start}-${start + args.limit - 1}` : `${path}:${start}-`;
}

function summaryOf(kind: ToolKind, s: CardState, status: CardStatus, now: number): string {
	const elapsed = s.startedAt !== undefined ? formatToolDuration((s.endedAt ?? now) - s.startedAt) : undefined;
	if (status === "pending") return "";
	if (status === "running") return kind === "bash" && elapsed ? fg(C.muted, `running · ${elapsed}`) : "";
	if (status === "error") {
		if (kind !== "bash") return fg(C.error, "failed");
		const code = exitCodeOf(textOf(s.result));
		return fg(C.error, code === undefined ? "failed" : `exit ${code}`) + (elapsed ? fg(C.dim, ` · ${elapsed}`) : "");
	}
	switch (kind) {
		case "read": {
			if (s.result?.content.some((block) => block.type === "image")) return fg(C.dim, "image");
			const { shown, total } = readLines(textOf(s.result));
			return fg(C.dim, total !== undefined && total > shown ? `${shown} of ${total} lines` : `${shown} lines`);
		}
		case "edit": {
			const diff = s.result?.details?.diff;
			if (typeof diff !== "string") return fg(C.dim, "applied");
			const { added, removed } = diffStats(diff);
			return diffSummary(added, removed);
		}
		case "write":
			return fg(C.dim, `${countLines(typeof s.args?.content === "string" ? s.args.content : "")} lines`);
		case "bash":
			return fg(C.dim, `exit 0${elapsed ? ` · ${elapsed}` : ""}`);
	}
}

function subLineOf(kind: ToolKind, s: CardState): { text: string; color: string } | undefined {
	const status = statusOf(s);
	if (status === "error") {
		const text = textOf(s.result);
		const line = kind === "bash" ? lastLine(text) : firstLine(text);
		return line ? { text: line, color: C.error } : undefined;
	}
	if (status === "running" && kind === "bash") {
		const line = lastLine(textOf(s.result));
		return line ? { text: line, color: C.dim } : undefined;
	}
	return undefined;
}

export function cardModel(kind: ToolKind, s: CardState, now: number): CardModel {
	const status = statusOf(s);
	return {
		name: kind,
		arg: argText(kind, s.args, s.cwd ?? ""),
		status,
		summary: summaryOf(kind, s, status, now),
		frame: frameAt(now),
	};
}

function builtInState(s: CardState) {
	s.builtIn ??= { state: {} };
	return s.builtIn;
}

function builtInCall(template: AnyTool, args: any, theme: any, context: RenderContext, s: CardState): Component {
	const b = builtInState(s);
	b.used = true;
	b.call = template.renderCall!(args, theme, { ...context, state: b.state, lastComponent: b.call });
	return b.call;
}

function builtInResult(template: AnyTool, result: ToolResult, options: any, theme: any, context: RenderContext, s: CardState): Component {
	const b = builtInState(s);
	b.used = true;
	b.result = template.renderResult!(result as any, options, theme, { ...context, state: b.state, lastComponent: b.result });
	return b.result;
}

/**
 * Re-registers read/bash/edit/write with Hairline renderers. Execution is
 * delegated unchanged to Pi's built-in implementation for the call's cwd.
 */
export function registerHairlineTools(pi: ExtensionAPI, options: HairlineToolsOptions): { clearCache(): void } {
	const now = options.now ?? Date.now;
	const cache = new Map<string, AnyTool>();

	for (const kind of TOOL_KINDS) {
		// Metadata, schema, and renderers do not depend on cwd or settings.
		const template = createBaseTool(kind, process.cwd());
		pi.registerTool({
			...template,
			renderShell: "self",
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const trusted = ctx.isProjectTrusted();
				const key = `${ctx.cwd}\0${trusted}`;
				let tool = cache.get(`${kind}\0${key}`);
				if (!tool) {
					const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: trusted });
					tool = createBaseTool(kind, ctx.cwd, settings);
					cache.set(`${kind}\0${key}`, tool);
				}
				return tool.execute(toolCallId, params, signal, onUpdate, ctx);
			},
			renderCall(args, theme, context) {
				const s = context.state as CardState;
				s.args = args;
				s.cwd = context.cwd;
				s.executionStarted = context.executionStarted;
				if (context.executionStarted && s.startedAt === undefined) s.startedAt = now();
				if (!options.isEnabled()) return builtInCall(template, args, theme, context, s);
				if (context.expanded) return new Indent(builtInCall(template, args, theme, context, s));
				return new Lines((width) => [renderCard(cardModel(kind, s, now()), width)]);
			},
			renderResult(result, renderOptions, theme, context) {
				const s = context.state as CardState;
				s.result = result as ToolResult;
				s.isPartial = renderOptions.isPartial;
				s.isError = context.isError;
				const final = !renderOptions.isPartial || context.isError;
				if (final && s.startedAt !== undefined) s.endedAt ??= now();
				if (!options.isEnabled()) return builtInResult(template, s.result, renderOptions, theme, context, s);
				if (renderOptions.expanded) return new Indent(builtInResult(template, s.result, renderOptions, theme, context, s));
				// Pi's bash renderer runs a refresh timer while partial; give it the final result once so it stops.
				if (final && s.builtIn?.used && !s.builtIn.settled) {
					builtInResult(template, s.result, renderOptions, theme, context, s);
					s.builtIn.settled = true;
				}
				return new Lines((width) => {
					const sub = subLineOf(kind, s);
					return sub ? [renderSubLine(sub.text, sub.color, width)] : [];
				});
			},
		} as AnyTool);
	}

	return { clearCache: () => cache.clear() };
}
