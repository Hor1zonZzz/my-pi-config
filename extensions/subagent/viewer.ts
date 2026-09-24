import type { Message } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { describeToolCall, formatDuration, formatTokens, formatUsage, preview, shortenPath } from "./format.ts";
import { elapsed, glyph, runRight, spread } from "./render.ts";
import type { LiveRun, RunSnapshot, StreamingMessage } from "./runs.ts";

const THINKING_PREVIEW_LINES = 4;
const STOP_CONFIRM_MS = 3000;

/** Two presses of x within three seconds stop a run, so a stray key cannot. */
class StopGuard {
	private armed: { id: string; at: number } | undefined;
	press(id: string, stop: (id: string) => void): void {
		const now = Date.now();
		if (this.armed?.id === id && now - this.armed.at <= STOP_CONFIRM_MS) {
			this.armed = undefined;
			stop(id);
		} else this.armed = { id, at: now };
	}
	isArmed(id: string | undefined): boolean {
		return !!id && this.armed?.id === id && Date.now() - this.armed.at <= STOP_CONFIRM_MS;
	}
	reset(): void {
		this.armed = undefined;
	}
}

export interface RunSource {
	snapshot: RunSnapshot;
	messages: readonly Message[];
	streaming?: StreamingMessage;
}

interface ViewTui {
	requestRender(): void;
	terminal: { rows: number };
}

function pad(line: string, width: number): string {
	return truncateToWidth(line, width, "", true);
}

function wrap(text: string, width: number, indent: number): string[] {
	const inner = Math.max(10, width - indent);
	return wrapTextWithAnsi(text, inner).map((line) => " ".repeat(indent) + line);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { type?: string; text?: string }) => (part?.type === "text" ? part.text ?? "" : part?.type === "image" ? "[image]" : ""))
		.join("\n");
}

/** Transcript lines for finalized messages. */
export function messageLines(theme: Theme, messages: readonly Message[], width: number, showThinking: boolean): string[] {
	const lines: string[] = [];
	const markdown = getMarkdownTheme();
	for (const message of messages) {
		if (message.role === "user") {
			lines.push("", `  ${theme.fg("accent", "▸")} ${theme.fg("muted", "task")}`);
			lines.push(...wrap(theme.fg("dim", textOf(message.content)), width, 4));
		} else if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "thinking") {
					const thinking = part.thinking.trim();
					if (!thinking) continue;
					const all = wrap(theme.fg("dim", theme.italic(thinking)), width, 4);
					lines.push("", `  ${theme.fg("dim", "∴ thinking")}`);
					lines.push(...(showThinking ? all : all.slice(0, THINKING_PREVIEW_LINES)));
					if (!showThinking && all.length > THINKING_PREVIEW_LINES) lines.push(`    ${theme.fg("dim", `… ${all.length - THINKING_PREVIEW_LINES} more lines · t to show`)}`);
				} else if (part.type === "text") {
					if (!part.text.trim()) continue;
					lines.push("", ...new Markdown(part.text.trim(), 2, 0, markdown).render(width));
				} else if (part.type === "toolCall") {
					lines.push(truncateToWidth(`  ${theme.fg("muted", "→")} ${theme.fg("toolOutput", describeToolCall(part.name, part.arguments))}`, width, "…"));
				}
			}
			if (message.stopReason === "error" && message.errorMessage) lines.push(...wrap(theme.fg("error", message.errorMessage), width, 2));
		} else if (message.role === "toolResult") {
			const text = textOf(message.content).trim();
			const all = text ? text.split("\n") : [];
			const first = all.find((line) => line.trim()) ?? "";
			const summary = message.isError
				? theme.fg("error", preview(first || "error", 200))
				: theme.fg("dim", all.length > 1 ? `${all.length} lines · ${preview(first, 160)}` : preview(first || "(no output)", 200));
			lines.push(truncateToWidth(`    ${theme.fg("dim", "↳")} ${summary}`, width, "…"));
		}
	}
	return lines;
}

/** Lines for the assistant message that is still streaming. */
export function streamingLines(theme: Theme, streaming: StreamingMessage | undefined, width: number, showThinking: boolean): string[] {
	if (!streaming) return [];
	const lines: string[] = [];
	const thinking = streaming.thinking.trim();
	if (thinking) {
		const all = wrap(theme.fg("dim", theme.italic(thinking)), width, 4);
		lines.push("", `  ${theme.fg("dim", "∴ thinking")}`, ...(showThinking ? all : all.slice(-THINKING_PREVIEW_LINES)));
	}
	if (streaming.text.trim()) lines.push("", ...wrap(`${streaming.text.trim()}${theme.fg("accent", "▍")}`, width, 2));
	return lines;
}

function headerLines(theme: Theme, run: RunSnapshot, width: number, now: number): string[] {
	const mode = run.mode === "async" ? "background" : "foreground";
	const top = spread(
		`  ${glyph(theme, run.status, now)}  ${theme.fg("toolTitle", theme.bold(run.agent))} ${theme.fg("muted", `${run.status} · ${mode}`)}`,
		`  ${runRight(theme, run, now)}  `,
		width,
	);
	const usage = formatUsage(run.usage, run.model);
	return [
		top,
		...wrap(theme.fg("dim", `Task: ${run.task}`), width, 2).slice(0, 3),
		truncateToWidth(`  ${theme.fg("dim", [usage, shortenPath(run.sessionDir)].filter(Boolean).join(" · "))}`, width, "…"),
		theme.fg("dim", "─".repeat(Math.max(0, width))),
	];
}

/** Scrollable transcript of one run. Live runs follow new output until the user scrolls up. */
export class RunView implements Component {
	private readonly theme: Theme;
	private readonly tui: ViewTui;
	private readonly source: () => RunSource;
	private readonly onClose: () => void;
	private readonly onStop: ((runId: string) => void) | undefined;
	private scroll = 0;
	private follow = true;
	private showThinking = false;
	private cache: { key: string; lines: string[] } | undefined;
	private lastBody = 0;
	private lastMaxScroll = 0;
	private readonly guard = new StopGuard();

	constructor(options: { theme: Theme; tui: ViewTui; source: () => RunSource; onClose: () => void; onStop?: (runId: string) => void }) {
		this.theme = options.theme;
		this.tui = options.tui;
		this.source = options.source;
		this.onClose = options.onClose;
		this.onStop = options.onStop;
	}

	private bodyLines(source: RunSource, width: number): string[] {
		const key = `${width}:${source.messages.length}:${this.showThinking}`;
		if (this.cache?.key !== key) this.cache = { key, lines: messageLines(this.theme, source.messages, width, this.showThinking) };
		return [...this.cache.lines, ...streamingLines(this.theme, source.streaming, width, this.showThinking)];
	}

	render(width: number): string[] {
		const source = this.source();
		const now = Date.now();
		const height = Math.max(10, this.tui.terminal.rows);
		const header = headerLines(this.theme, source.snapshot, width, now);
		const running = source.snapshot.status === "running";
		const hint = this.guard.isArmed(source.snapshot.id) && running
			? this.theme.fg("warning", `press x again to stop ${source.snapshot.agent}`)
			: this.theme.fg("dim", `↑↓ scroll · pgup/pgdn · g/G top/end · t thinking${running && this.onStop ? " · x stop" : ""} · esc back`);
		const footer = [this.theme.fg("dim", "─".repeat(Math.max(0, width))), truncateToWidth(`  ${hint}`, width, "")];
		const bodyHeight = Math.max(1, height - header.length - footer.length);
		let body = this.bodyLines(source, width);
		if (body.length === 0) body = ["", `  ${this.theme.fg("dim", running ? "waiting for the first output…" : "no transcript recorded for this run")}`];
		const maxScroll = Math.max(0, body.length - bodyHeight);
		if (this.follow) this.scroll = maxScroll;
		this.scroll = Math.min(Math.max(0, this.scroll), maxScroll);
		this.lastBody = bodyHeight;
		this.lastMaxScroll = maxScroll;
		const visible = body.slice(this.scroll, this.scroll + bodyHeight);
		while (visible.length < bodyHeight) visible.push("");
		return [...header, ...visible, ...footer].map((line) => pad(line, width));
	}

	private move(delta: number): void {
		this.scroll = Math.max(0, this.scroll + delta);
		this.follow = false;
	}

	handleInput(data: string): void {
		const page = Math.max(1, this.lastBody - 1);
		if (matchesKey(data, "escape") || data === "q") {
			this.onClose();
			return;
		}
		if (matchesKey(data, "up") || data === "k") this.move(-1);
		else if (matchesKey(data, "down") || data === "j") this.move(1);
		else if (matchesKey(data, "pageUp")) this.move(-page);
		else if (matchesKey(data, "pageDown") || data === " ") this.move(page);
		else if (matchesKey(data, "home") || data === "g") {
			this.scroll = 0;
			this.follow = false;
		} else if (matchesKey(data, "end") || data === "G") this.follow = true;
		else if (data === "t") {
			this.showThinking = !this.showThinking;
			this.cache = undefined;
		} else if (data === "x") {
			const run = this.source().snapshot;
			if (run.status === "running" && this.onStop) this.guard.press(run.id, this.onStop);
		} else return;
		if (data !== "x") this.guard.reset();
		// Following resumes once the user scrolls back to the end.
		if (!this.follow && this.scroll >= this.lastMaxScroll) this.follow = true;
		this.tui.requestRender();
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

export interface HistoryItem {
	snapshot: RunSnapshot;
	live?: LiveRun;
}

function timeAgo(timestamp: number, now: number): string {
	const minutes = Math.floor((now - timestamp) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** `/subagent-history`: every run of this session, newest first; enter opens its transcript. */
export class HistoryView implements Component {
	private readonly theme: Theme;
	private readonly tui: ViewTui;
	private readonly load: () => HistoryItem[];
	private readonly open: (item: HistoryItem) => RunSource | (() => RunSource);
	private readonly onClose: () => void;
	private readonly onStop: (runId: string) => void;
	private items: HistoryItem[];
	private selected = 0;
	private offset = 0;
	private detail: RunView | undefined;
	private readonly guard = new StopGuard();

	constructor(options: {
		theme: Theme;
		tui: ViewTui;
		load: () => HistoryItem[];
		open: (item: HistoryItem) => RunSource | (() => RunSource);
		onClose: () => void;
		onStop: (runId: string) => void;
		initialRunId?: string;
	}) {
		this.theme = options.theme;
		this.tui = options.tui;
		this.load = options.load;
		this.open = options.open;
		this.onClose = options.onClose;
		this.onStop = options.onStop;
		this.items = this.load();
		if (options.initialRunId) {
			const index = this.items.findIndex((item) => item.snapshot.id === options.initialRunId);
			if (index >= 0) {
				this.selected = index;
				this.openSelected();
			}
		}
	}

	refresh(): void {
		const id = this.items[this.selected]?.snapshot.id;
		this.items = this.load();
		const index = this.items.findIndex((item) => item.snapshot.id === id);
		this.selected = index >= 0 ? index : Math.min(this.selected, Math.max(0, this.items.length - 1));
	}

	private openSelected(): void {
		const item = this.items[this.selected];
		if (!item) return;
		const opened = this.open(item);
		const source = typeof opened === "function" ? opened : () => opened;
		this.detail = new RunView({
			theme: this.theme,
			tui: this.tui,
			source,
			onClose: () => {
				this.detail = undefined;
				this.refresh();
				this.tui.requestRender();
			},
			onStop: this.onStop,
		});
	}

	render(width: number): string[] {
		if (this.detail) return this.detail.render(width);
		const now = Date.now();
		const height = Math.max(10, this.tui.terminal.rows);
		const title = spread(
			`  ${this.theme.fg("toolTitle", this.theme.bold("Subagent history"))}  ${this.theme.fg("muted", `${this.items.length} run${this.items.length === 1 ? "" : "s"} in this session`)}`,
			"",
			width,
		);
		const header = [title, this.theme.fg("dim", "─".repeat(Math.max(0, width)))];
		const armed = this.items[this.selected]?.snapshot;
		const hint = armed && this.guard.isArmed(armed.id) && armed.status === "running"
			? this.theme.fg("warning", `press x again to stop ${armed.agent}`)
			: this.theme.fg("dim", "↑↓ select · enter open · x stop · r refresh · esc close");
		const footer = [this.theme.fg("dim", "─".repeat(Math.max(0, width))), truncateToWidth(`  ${hint}`, width, "")];
		const bodyHeight = Math.max(1, height - header.length - footer.length);
		const rows = this.items.map((item, i) => {
			const run = item.snapshot;
			const active = i === this.selected;
			const mode = run.mode === "async" ? " bg" : "";
			const left = `  ${active ? this.theme.fg("accent", "›") : " "} ${glyph(this.theme, run.status, now)} ${this.theme.fg(active ? "accent" : "text", run.agent)}${this.theme.fg("dim", mode)}  ${this.theme.fg("dim", preview(run.task, 200))}`;
			const right = run.status === "running"
				? runRight(this.theme, run, now)
				: this.theme.fg("dim", `${formatDuration(elapsed(run, now))} · ↓${formatTokens(run.usage.output)} · ${timeAgo(run.startedAt, now)}`);
			const line = spread(left, `  ${right}  `, width);
			return active ? this.theme.bg("selectedBg", line) : line;
		});
		if (rows.length === 0) rows.push(`  ${this.theme.fg("dim", "No subagent runs recorded for this session yet.")}`);
		if (this.selected < this.offset) this.offset = this.selected;
		if (this.selected >= this.offset + bodyHeight) this.offset = this.selected - bodyHeight + 1;
		const visible = rows.slice(this.offset, this.offset + bodyHeight);
		while (visible.length < bodyHeight) visible.push("");
		return [...header, ...visible, ...footer].map((line) => pad(line, width));
	}

	handleInput(data: string): void {
		if (this.detail) {
			this.detail.handleInput(data);
			return;
		}
		if (matchesKey(data, "escape") || data === "q") {
			this.onClose();
			return;
		}
		if (matchesKey(data, "up") || data === "k") this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down") || data === "j") this.selected = Math.min(Math.max(0, this.items.length - 1), this.selected + 1);
		else if (matchesKey(data, "enter")) this.openSelected();
		else if (data === "r") this.refresh();
		else if (data === "x") {
			const run = this.items[this.selected]?.snapshot;
			if (run?.status === "running") this.guard.press(run.id, this.onStop);
		} else return;
		if (data !== "x") this.guard.reset();
		this.tui.requestRender();
	}

	invalidate(): void {
		this.detail?.invalidate();
	}
}
