import { type Message, StringEnum } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionAPI, type Theme, truncateHead } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describeToolCall, formatDuration, formatTokens, formatUsage, oneLine, preview, shortenPath } from "./format.ts";
import { glyph, spread } from "./render.ts";
import { interrupted, type LiveRun, type RunRegistry, type RunSnapshot } from "./runs.ts";
import { findSessionFile, listRuns, parentSessionDir, readSessionMessages } from "./store.ts";

// subagent_control: lets the main agent look at the runs it started. Runs come
// from this process's registry (live) and from <run id>.meta.json on disk
// (earlier runs of the same parent session, including before /reload).

export const CONTROL_ACTIONS = ["list", "inspect", "read", "wait"] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export const ControlParams = Type.Object({
	action: StringEnum(CONTROL_ACTIONS, {
		description: "list: all runs · inspect: one run's progress · read: page through a run's transcript · wait: block until runs finish",
	}),
	run: Type.Optional(
		Type.String({ description: "Run id or a unique prefix of it (from list), or a background job id. Required for inspect and read." }),
	),
	from: Type.Optional(Type.Integer({ minimum: 1, description: "read: first message number (messages are numbered from 1). Default: the last `limit` messages." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "read: number of messages. Default: 20." })),
	timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: "wait: seconds to wait before returning. Default: 60." })),
});

const DEFAULT_READ_LIMIT = 20;
const DEFAULT_WAIT_SECONDS = 60;
const RECENT_CALLS = 8;
const TEXT_CAP = 2000;
const RESULT_CAP = 1500;
const OUTPUT_CAP = 8 * 1024;

export const CONTROL_DESCRIPTION = [
	"Look at subagent runs started from this session, in the foreground or with async: true.",
	"Actions: list — every run with its id, status, and current activity;",
	"inspect — one run's task, progress, recent tool calls, and output;",
	"read — page through a run's transcript (messages numbered from 1; default the last 20);",
	"wait — block until the given run or job finishes (with no run: until any running run finishes), up to timeout seconds.",
	"Async results still arrive on their own; check only when you need the information now, and use wait instead of repeated list or inspect calls.",
].join(" ");

export interface ControlEntry {
	snapshot: RunSnapshot;
	live?: LiveRun;
}

export function shortId(id: string): string {
	return id.slice(0, 8);
}

/** This session's runs, oldest first: live runs from the registry and finished ones from disk. */
export function sessionRuns(registry: RunRegistry, sessionId: string): ControlEntry[] {
	const entries = new Map<string, ControlEntry>();
	for (const snapshot of listRuns(parentSessionDir(sessionId))) entries.set(snapshot.id, { snapshot: interrupted(snapshot) });
	for (const live of registry.list()) {
		if (live.snapshot.parentSessionId === sessionId) entries.set(live.id, { snapshot: live.snapshot, live });
	}
	return [...entries.values()].sort((a, b) => a.snapshot.startedAt - b.snapshot.startedAt);
}

/** Runs named by an exact id, a background job id, or a unique id prefix. */
export function resolveRuns(entries: ControlEntry[], ref: string): ControlEntry[] {
	const key = ref.trim();
	if (!key) throw new Error("run is empty. Use action list to see run ids.");
	const exact = entries.filter((e) => e.snapshot.id === key);
	if (exact.length) return exact;
	const job = entries.filter((e) => e.snapshot.jobId === key);
	if (job.length) return job;
	const prefix = entries.filter((e) => e.snapshot.id.startsWith(key));
	if (prefix.length === 0) throw new Error(`No subagent run matches "${key}". Use action list to see run ids.`);
	if (prefix.length > 1) throw new Error(`"${key}" matches ${prefix.length} runs (${prefix.map((e) => shortId(e.snapshot.id)).join(", ")}); use a longer prefix.`);
	return prefix;
}

function resolveOne(entries: ControlEntry[], ref: string | undefined, action: string): ControlEntry {
	if (!ref) throw new Error(`${action} needs run. Use action list to see run ids.`);
	const found = resolveRuns(entries, ref);
	if (found.length > 1) {
		throw new Error(`${ref} is a job with ${found.length} runs (${found.map((e) => shortId(e.snapshot.id)).join(", ")}); name one run.`);
	}
	return found[0]!;
}

function elapsed(s: RunSnapshot, now: number): string {
	return formatDuration((s.endedAt ?? now) - s.startedAt);
}

function statusText(s: RunSnapshot): string {
	if (s.status !== "failed") return s.status;
	return s.exitCode && s.exitCode !== 0 ? `failed (exit ${s.exitCode})` : `failed (${s.stopReason ?? "error"})`;
}

export function listText(entries: ControlEntry[], now = Date.now()): string {
	if (entries.length === 0) return "No subagent runs in this session.";
	const running = entries.filter((e) => e.snapshot.status === "running").length;
	const lines = [`${entries.length} run${entries.length === 1 ? "" : "s"} · ${running} running`];
	for (const { snapshot: s } of entries) {
		const mode = s.mode === "async" ? ` · bg ${s.jobId ?? ""}`.trimEnd() : "";
		const activity = s.status === "running" && s.activity ? ` · now: ${preview(s.activity, 80)}` : "";
		lines.push(
			`${shortId(s.id)}  ${s.agent}  ${statusText(s)}${mode} · ${elapsed(s, now)} · ↓${formatTokens(s.usage.output)}${activity}`,
			`          task: ${preview(s.task, 120)}`,
		);
	}
	return lines.join("\n");
}

export function inspectText(entry: ControlEntry, now = Date.now()): string {
	const s = entry.snapshot;
	const lines = [
		`run ${s.id} · ${s.agent} (${s.agentSource}) · ${statusText(s)}${s.mode === "async" ? ` · background job ${s.jobId ?? "?"}` : " · foreground"}`,
		`elapsed ${elapsed(s, now)}${formatUsage(s.usage, s.model) ? ` · ${formatUsage(s.usage, s.model)}` : ""}`,
		`cwd ${shortenPath(s.cwd)}`,
		`task: ${truncateText(s.task, TEXT_CAP)}`,
	];
	if (s.status === "running") lines.push(`now: ${s.activity ?? "starting"}`);
	if (s.toolCalls.length) {
		const recent = s.toolCalls.slice(-RECENT_CALLS);
		lines.push(`tool calls (last ${recent.length} of ${s.toolCalls.length}):`, ...recent.map((call) => `  ${call}`));
	}
	const streaming = entry.live?.streaming?.text.trim();
	if (s.status === "running" && streaming) lines.push(`writing: …${streaming.slice(-600)}`);
	if (s.status !== "running" && s.output) lines.push("output:", truncateText(s.output, OUTPUT_CAP));
	const messages = entry.live ? entry.live.messages.length : undefined;
	const file = findSessionFile(s.sessionDir, s.id);
	lines.push(`transcript: ${messages ?? "?"} messages${file ? ` · ${shortenPath(file)}` : ""} (use action read)`);
	return lines.join("\n");
}

function truncateText(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { type?: string; text?: string }) => (part?.type === "text" ? part.text ?? "" : part?.type === "image" ? "[image]" : ""))
		.join("\n");
}

function indent(text: string): string {
	return text.split("\n").map((line) => `  ${line}`).join("\n");
}

function messageText(message: Message, number: number): string {
	if (message.role === "user") return `#${number} user\n${indent(truncateText(textOf(message.content).trim(), TEXT_CAP))}`;
	if (message.role === "toolResult") {
		const result = message as Message & { toolName?: string; isError?: boolean };
		const body = textOf(result.content).trim();
		return `#${number} tool ${result.toolName ?? ""} ${result.isError ? "error" : "ok"}`.replace(/  +/g, " ") + (body ? `\n${indent(truncateText(body, RESULT_CAP))}` : "");
	}
	// Pi records the subagent's full system prompt as the first message; it is not progress.
	if (message.role === "system") return `#${number} system prompt (${textOf(message.content).length} chars, not shown)`;
	const parts: string[] = [];
	for (const part of message.content) {
		if (part.type === "thinking" && part.thinking.trim()) parts.push(indent(`thinking: ${preview(part.thinking, 300)}`));
		else if (part.type === "text" && part.text.trim()) parts.push(indent(truncateText(part.text.trim(), TEXT_CAP)));
		else if (part.type === "toolCall") parts.push(`  → ${describeToolCall(part.name, part.arguments)}`);
	}
	if (message.stopReason === "error" && message.errorMessage) parts.push(`  error: ${oneLine(message.errorMessage)}`);
	return [`#${number} assistant`, ...parts].join("\n");
}

export function transcriptOf(entry: ControlEntry): Message[] {
	if (entry.live) return entry.live.messages;
	const file = findSessionFile(entry.snapshot.sessionDir, entry.snapshot.id);
	return file ? readSessionMessages(file) : [];
}

export function readText(entry: ControlEntry, from: number | undefined, limit = DEFAULT_READ_LIMIT): string {
	const messages = transcriptOf(entry);
	const total = messages.length;
	const s = entry.snapshot;
	const head = `run ${shortId(s.id)} · ${s.agent} · ${statusText(s)}`;
	if (total === 0) return `${head}\nNo transcript messages yet.`;
	const start = Math.min(total, Math.max(1, from ?? total - limit + 1));
	const end = Math.min(total, start + limit - 1);
	const body = messages.slice(start - 1, end).map((message, i) => messageText(message, start + i));
	let footer = `messages ${start}-${end} of ${total}`;
	if (end < total) footer += ` · next: from ${end + 1}`;
	if (start > 1) footer += ` · earlier: from ${Math.max(1, start - limit)}`;
	const streaming = entry.live?.streaming?.text.trim();
	if (s.status === "running" && streaming) footer += `\nwriting now: …${oneLine(streaming).slice(-300)}`;
	const text = [head, ...body, footer].join("\n\n");
	const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	return truncated.truncated ? `${truncated.content}\n\n[Output truncated; read fewer messages with a smaller limit.]` : truncated.content;
}

/**
 * Resolves when `done()` holds, re-checking on every registry change.
 * Returns false on timeout; throws when the tool call is aborted.
 */
export function waitUntil(registry: RunRegistry, done: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve, reject) => {
		if (done()) {
			resolve(true);
			return;
		}
		const finish = (value: boolean | Error) => {
			clearTimeout(timer);
			unsubscribe();
			signal?.removeEventListener("abort", onAbort);
			if (value instanceof Error) reject(value);
			else resolve(value);
		};
		const onAbort = () => finish(new Error("Wait cancelled."));
		const timer = setTimeout(() => finish(false), timeoutMs);
		const unsubscribe = registry.subscribe(() => {
			if (done()) finish(true);
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

function finishedText(entry: ControlEntry): string {
	const s = entry.snapshot;
	return [`${shortId(s.id)} ${s.agent} ${statusText(s)} after ${elapsed(s, Date.now())}`, truncateText(s.output || "(no output)", OUTPUT_CAP)].join("\n");
}

async function waitText(
	registry: RunRegistry,
	entries: ControlEntry[],
	ref: string | undefined,
	timeoutSeconds: number,
	signal: AbortSignal | undefined,
): Promise<string> {
	const targets = ref ? resolveRuns(entries, ref) : entries.filter((e) => e.live?.running);
	if (targets.length === 0) return "No subagent runs are running.";
	const pending = () => targets.filter((e) => e.live?.running);
	const alreadyDone = targets.filter((e) => !e.live?.running);
	// A named run or job waits for all of its runs; with no run, the first one to finish is enough.
	const done = ref ? () => pending().length === 0 : () => pending().length < targets.length;
	const finished = await waitUntil(registry, done, timeoutSeconds * 1000, signal);
	const ended = targets.filter((e) => !e.live?.running);
	const still = pending();
	const parts: string[] = [];
	if (!finished) parts.push(`Still running after ${timeoutSeconds}s.`);
	if (ended.length) parts.push(...ended.map(finishedText));
	if (still.length) {
		parts.push(`running: ${still.map((e) => `${shortId(e.snapshot.id)} ${e.snapshot.agent} (${e.snapshot.activity ?? "starting"})`).join(", ")}`);
	}
	if (ref && alreadyDone.length === targets.length) parts.unshift("Already finished.");
	return parts.join("\n\n");
}

// --- Rendering ------------------------------------------------------------

interface ControlDetails {
	action: ControlAction;
	run?: string;
}

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

function callLine(theme: Theme, args: { action?: string; run?: string; from?: number; limit?: number; timeout?: number }, status: "pending" | "completed" | "failed", width: number): string {
	const extra = [args.run, args.from ? `from ${args.from}` : "", args.limit ? `limit ${args.limit}` : "", args.timeout ? `${args.timeout}s` : ""]
		.filter(Boolean)
		.join(" · ");
	const left = `  ${glyph(theme, status === "pending" ? "running" : status, Date.now())}  ${theme.fg("toolTitle", theme.bold("subagent_control"))}  ${theme.fg("accent", args.action ?? "…")}${extra ? theme.fg("dim", `  ${extra}`) : ""}`;
	return spread(left, "", width);
}

// --- Tool -----------------------------------------------------------------

export function registerControlTool(pi: ExtensionAPI, registry: RunRegistry): void {
	pi.registerTool({
		name: "subagent_control",
		label: "Subagent control",
		description: CONTROL_DESCRIPTION,
		promptSnippet: "Check on subagent runs started from this session: list, inspect, read transcripts, or wait for them to finish",
		parameters: ControlParams,
		renderShell: "self",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const entries = sessionRuns(registry, ctx.sessionManager.getSessionId());
			const details: ControlDetails = { action: params.action, run: params.run };
			let text: string;
			switch (params.action) {
				case "list":
					text = listText(entries);
					break;
				case "inspect":
					text = inspectText(resolveOne(entries, params.run, "inspect"));
					break;
				case "read":
					text = readText(resolveOne(entries, params.run, "read"), params.from, params.limit ?? DEFAULT_READ_LIMIT);
					break;
				case "wait":
					text = await waitText(registry, entries, params.run, params.timeout ?? DEFAULT_WAIT_SECONDS, signal);
					break;
				default:
					throw new Error(`Unknown action: ${String(params.action)}`);
			}
			return { content: [{ type: "text", text }], details };
		},

		renderCall(args, theme, context) {
			const state = context.state as { status?: "completed" | "failed" };
			return new Lines((width) => [callLine(theme, args, state.status ?? "pending", width)]);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const state = context.state as { status?: "completed" | "failed" };
			if (!isPartial) state.status = context.isError ? "failed" : "completed";
			const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n").trim();
			return new Lines((width) => {
				if (!text) return [];
				const color = context.isError ? "error" : "dim";
				if (!expanded) {
					const first = text.split("\n").find((line) => line.trim()) ?? "";
					return [truncateToWidth(`     ${theme.fg("dim", "╰")} ${theme.fg(color, first)}`, width, theme.fg("dim", "…"))];
				}
				return text.split("\n").flatMap((line) => wrapTextWithAnsi(theme.fg(color, line), Math.max(10, width - 5)).map((l) => `     ${l}`));
			});
		},
	});
}
