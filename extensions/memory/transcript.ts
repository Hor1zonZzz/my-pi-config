/**
 * Turns Pi session entries into compact text for the capture window and for dreams.
 * Free of Pi imports so `node --test` can run it; the shapes follow docs/session-format.md.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const TOOL_ARGS_CHARS = 200;
const TOOL_RESULT_CHARS = 300;
const TOOL_ERROR_CHARS = 800;

/** The parts of pi-ai messages this module reads. */
export interface LooseMessage {
	role: string;
	content?: unknown;
	toolName?: string;
	isError?: boolean;
	customType?: string;
}

export interface LooseEntry {
	type: string;
	id?: string;
	timestamp?: string;
	message?: LooseMessage;
}

/** One user prompt and everything the agent did until the next one. */
export type Turn = LooseMessage[];

export function messagesFromEntries(entries: readonly LooseEntry[]): LooseMessage[] {
	return entries
		.filter((entry) => entry.type === "message" && entry.message)
		.map((entry) => entry.message as LooseMessage)
		.filter((message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult");
}

export function splitTurns(messages: readonly LooseMessage[]): Turn[] {
	const turns: Turn[] = [];
	for (const message of messages) {
		if (message.role === "user" || turns.length === 0) turns.push([]);
		turns[turns.length - 1].push(message);
	}
	return turns.filter((turn) => turn.some((message) => message.role === "user"));
}

function clip(text: string, max: number): string {
	const flat = text.trim();
	return flat.length > max ? `${flat.slice(0, max)}… [${flat.length - max} more chars]` : flat;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const block = part as { type?: string; text?: string };
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function toolCallsOf(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((part) => (part as { type?: string }).type === "toolCall")
		.map((part) => {
			const call = part as { name?: string; arguments?: unknown };
			return `TOOL CALL ${call.name ?? "?"}: ${clip(JSON.stringify(call.arguments ?? {}), TOOL_ARGS_CHARS)}`;
		});
}

/** USER / AGENT text in full; thinking dropped; tool calls and results cut short (errors less so). */
export function renderTurn(turn: Turn): string {
	const lines: string[] = [];
	for (const message of turn) {
		if (message.role === "user") {
			const text = textOf(message.content).trim();
			if (text) lines.push(`USER: ${text}`);
		} else if (message.role === "assistant") {
			const text = textOf(message.content).trim();
			if (text) lines.push(`AGENT: ${text}`);
			lines.push(...toolCallsOf(message.content));
		} else if (message.role === "toolResult") {
			const max = message.isError ? TOOL_ERROR_CHARS : TOOL_RESULT_CHARS;
			lines.push(`TOOL RESULT (${message.toolName ?? "?"})${message.isError ? " ERROR" : ""}: ${clip(textOf(message.content), max)}`);
		}
	}
	return lines.join("\n");
}

export interface CaptureWindow {
	/** Earlier turns, oldest first, for understanding the focus turn only. */
	earlier: string[];
	/** The turn that just settled. Only what it teaches is written down. */
	focus: string;
}

/**
 * The last `maxTurns` turns, dropping the oldest first while over `maxChars`.
 * The focus turn itself is clipped from the middle if it alone is too long.
 */
export function buildWindow(turns: readonly Turn[], maxTurns: number, maxChars: number): CaptureWindow | undefined {
	if (turns.length === 0) return undefined;
	const rendered = turns.slice(-maxTurns).map(renderTurn);
	let focus = rendered.pop() ?? "";
	if (focus.length > maxChars) focus = clipMiddle(focus, maxChars);
	const earlier = [...rendered];
	const size = () => focus.length + earlier.reduce((sum, text) => sum + text.length, 0);
	while (earlier.length > 0 && size() > maxChars) earlier.shift();
	return { earlier, focus };
}

export function clipMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const half = Math.floor((max - 40) / 2);
	return `${text.slice(0, half)}\n… [${text.length - 2 * half} chars omitted] …\n${text.slice(-half)}`;
}

export function windowText(window: CaptureWindow): string {
	return [...window.earlier.map((text, i) => `## Earlier turn ${i + 1}\n${text}`), `## Focus turn\n${window.focus}`].join("\n\n");
}

// ── Session files ────────────────────────────────────────────────────────────

export interface SessionFile {
	path: string;
	id: string;
	mtimeMs: number;
}

export function sessionIdFromFile(name: string): string {
	const base = name.replace(/\.jsonl$/, "");
	const underscore = base.indexOf("_");
	return underscore >= 0 ? base.slice(underscore + 1) : base;
}

/** Session files in `dir` changed after `since`, oldest first, leaving out `excludeId`. */
export async function sessionsSince(dir: string, since: number, excludeId?: string): Promise<SessionFile[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const out: SessionFile[] = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const id = sessionIdFromFile(name);
		if (id === excludeId) continue;
		try {
			const info = await stat(join(dir, name));
			if (info.isFile() && info.mtimeMs > since) out.push({ path: join(dir, name), id, mtimeMs: info.mtimeMs });
		} catch {}
	}
	return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export async function readSessionEntries(path: string): Promise<LooseEntry[]> {
	const out: LooseEntry[] = [];
	for (const line of (await readFile(path, "utf8")).split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as LooseEntry);
		} catch {
			// A partly written last line is skipped.
		}
	}
	return out;
}

/** The whole session as text for a dream, clipped from the middle when it is too long. */
export function renderTranscript(entries: readonly LooseEntry[], sessionId: string, maxChars: number): string {
	const header = entries.find((entry) => entry.type === "session");
	const body = splitTurns(messagesFromEntries(entries)).map(renderTurn).join("\n\n");
	return clipMiddle(`SESSION ${sessionId}${header?.timestamp ? ` started ${header.timestamp}` : ""}\n\n${body}`, maxChars);
}
