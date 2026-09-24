import * as os from "node:os";

// Pure helpers shared by the runner, renderers, and views.

export type RunStatus = "running" | "completed" | "failed" | "cancelled";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function sumUsage(items: UsageStats[]): UsageStats {
	const total = emptyUsage();
	for (const usage of items) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost += usage.cost;
		total.turns += usage.turns;
		total.contextTokens = Math.max(total.contextTokens, usage.contextTokens);
	}
	return total;
}

export function formatTokens(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return "0";
	if (count < 1000) return String(Math.round(count));
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** `3 turns ↑12k ↓3.1k R118k $0.0123 ctx:40k model` — the previous extension's usage line. */
export function formatUsage(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function preview(text: string, max: number): string {
	const flat = oneLine(text);
	return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

export function shortenPath(p: string): string {
	const home = os.homedir();
	return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Plain-text description of a tool call, e.g. `read src/a.ts:1-20` or `$ git status`. */
export function describeToolCall(name: string, args: Record<string, unknown> | undefined): string {
	const a = args ?? {};
	const path = (value: unknown, fallback = "…") => shortenPath(typeof value === "string" && value ? value : fallback);
	switch (name) {
		case "bash":
			return `$ ${preview(typeof a.command === "string" ? a.command : "…", 80)}`;
		case "read": {
			const offset = typeof a.offset === "number" ? a.offset : undefined;
			const limit = typeof a.limit === "number" ? a.limit : undefined;
			const range = offset !== undefined || limit !== undefined
				? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`
				: "";
			return `read ${path(a.file_path ?? a.path)}${range}`;
		}
		case "write": {
			const lines = typeof a.content === "string" ? a.content.split("\n").length : 0;
			return `write ${path(a.file_path ?? a.path)}${lines > 1 ? ` (${lines} lines)` : ""}`;
		}
		case "edit":
			return `edit ${path(a.file_path ?? a.path)}`;
		case "ls":
			return `ls ${path(a.path, ".")}`;
		case "find":
			return `find ${typeof a.pattern === "string" ? a.pattern : "*"} in ${path(a.path, ".")}`;
		case "grep":
			return `grep /${typeof a.pattern === "string" ? a.pattern : ""}/ in ${path(a.path, ".")}`;
		default: {
			const json = JSON.stringify(a);
			return `${name} ${json.length > 60 ? `${json.slice(0, 59)}…` : json}`;
		}
	}
}

interface ContentLike {
	type: string;
	text?: string;
}

interface MessageLike {
	role: string;
	content?: unknown;
}

/** Last text part of the last assistant message: the subagent's answer. */
export function finalOutput(messages: readonly MessageLike[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content as ContentLike[]) {
			if (part.type === "text" && typeof part.text === "string") return part.text;
		}
	}
	return "";
}

/** Truncate to a UTF-8 byte budget, keeping whole code points. */
export function truncateBytes(text: string, maxBytes: number, note = "Full output preserved in tool details."): string {
	const size = Buffer.byteLength(text, "utf8");
	if (size <= maxBytes) return text;
	let cut = text.slice(0, maxBytes);
	while (Buffer.byteLength(cut, "utf8") > maxBytes) cut = cut.slice(0, -1);
	return `${cut}\n\n[Output truncated: ${size - Buffer.byteLength(cut, "utf8")} bytes omitted. ${note}]`;
}

/** Pi warns on stderr when `--session-id` creates a new session; that is expected here. */
export function cleanStderr(stderr: string): string {
	return stderr
		.split("\n")
		.filter((line) => !/No project session found with id/.test(line))
		.join("\n")
		.trim();
}

/** Keep the end of a growing text buffer. */
export function tail(text: string, maxChars: number): string {
	return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}
