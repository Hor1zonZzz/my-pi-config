import { execFile } from "node:child_process";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type MarkdownTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

function safeMarkdownTheme(theme: Theme): MarkdownTheme {
	try {
		const mt = getMarkdownTheme();
		// Probe once to ensure Pi's global theme singleton is initialized
		mt.bold("x");
		return mt;
	} catch {
		const id = (s: string) => s;
		return {
			heading: (s) => theme.bold(theme.fg("accent", s)),
			link: (s) => theme.fg("accent", s),
			linkUrl: (s) => theme.fg("muted", s),
			code: (s) => theme.fg("accent", s),
			codeBlock: (s) => theme.fg("text", s),
			codeBlockBorder: (s) => theme.fg("muted", s),
			quote: (s) => theme.fg("muted", s),
			quoteBorder: (s) => theme.fg("muted", s),
			hr: (s) => theme.fg("muted", s),
			listBullet: (s) => theme.fg("accent", s),
			bold: (s) => theme.bold(s),
			italic: id,
			strikethrough: id,
			underline: id,
		};
	}
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface BtwOverlayOptions {
	tui: TUI;
	theme: Theme;
	question: string;
	modelLabel: string;
	stream: AsyncIterable<AssistantMessageEvent>;
	abortController: AbortController;
	done: () => void;
}

export class BtwOverlayComponent implements Component {
	private tui: TUI;
	private theme: Theme;
	private question: string;
	private modelLabel: string;
	private abortController: AbortController;
	private done: () => void;

	private answerText = "";
	private errorText: string | null = null;
	private streaming = true;
	private startMs = performance.now();
	private elapsedMs = 0;
	private cacheReadTokens = 0;
	private outputTokens = 0;

	private scrollOffset = 0;
	private autoFollow = true;
	private maxScroll = 0;
	private spinnerIdx = 0;
	private spinnerTimer: ReturnType<typeof setInterval> | null = null;
	private copiedFlash = false;
	private copiedTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;

	private markdown: Markdown;

	constructor(opts: BtwOverlayOptions) {
		this.tui = opts.tui;
		this.theme = opts.theme;
		this.question = opts.question;
		this.modelLabel = opts.modelLabel;
		this.abortController = opts.abortController;
		this.done = opts.done;
		this.markdown = new Markdown("", 0, 0, safeMarkdownTheme(opts.theme));

		this.spinnerTimer = setInterval(() => {
			if (!this.streaming || this.disposed) return;
			this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER_FRAMES.length;
			this.tui.requestRender();
		}, 90);

		void this.consumeStream(opts.stream);
	}

	private async consumeStream(stream: AsyncIterable<AssistantMessageEvent>): Promise<void> {
		try {
			for await (const ev of stream) {
				if (this.disposed) break;
				if (ev.type === "text_delta") {
					this.answerText += ev.delta;
					this.markdown.setText(this.answerText);
					this.tui.requestRender();
				} else if (ev.type === "done") {
					const usage = ev.message.usage;
					if (usage) {
						this.cacheReadTokens = usage.cacheRead ?? 0;
						this.outputTokens = usage.output ?? 0;
					}
				} else if (ev.type === "error") {
					this.errorText = ev.error.errorMessage || "Request failed";
				}
			}
		} catch (err) {
			if (!this.disposed && !this.abortController.signal.aborted) {
				this.errorText = err instanceof Error ? err.message : String(err);
			}
		} finally {
			this.streaming = false;
			this.elapsedMs = performance.now() - this.startMs;
			if (this.spinnerTimer) {
				clearInterval(this.spinnerTimer);
				this.spinnerTimer = null;
			}
			if (!this.disposed) {
				this.tui.requestRender();
			}
		}
	}

	invalidate(): void {
		this.markdown.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		if (this.spinnerTimer) {
			clearInterval(this.spinnerTimer);
			this.spinnerTimer = null;
		}
		if (this.copiedTimer) {
			clearTimeout(this.copiedTimer);
			this.copiedTimer = null;
		}
		if (!this.abortController.signal.aborted) {
			this.abortController.abort();
		}
	}

	private copyAnswer(): void {
		if (!this.answerText.trim()) return;
		const child = execFile("pbcopy", [], () => {
			if (this.disposed) return;
			this.copiedFlash = true;
			this.tui.requestRender();
			if (this.copiedTimer) clearTimeout(this.copiedTimer);
			this.copiedTimer = setTimeout(() => {
				this.copiedFlash = false;
				if (!this.disposed) this.tui.requestRender();
			}, 1400);
		});
		child.stdin?.end(this.answerText);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.dispose();
			this.done();
			return;
		}
		if (!this.streaming && (matchesKey(data, "return") || data === " ")) {
			this.dispose();
			this.done();
			return;
		}
		if (data === "c" || data === "C") {
			this.copyAnswer();
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.autoFollow = false;
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.scrollOffset = Math.min(this.maxScroll, this.scrollOffset + 1);
			if (this.scrollOffset >= this.maxScroll) this.autoFollow = true;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.autoFollow = false;
			this.scrollOffset = Math.max(0, this.scrollOffset - 8);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollOffset = Math.min(this.maxScroll, this.scrollOffset + 8);
			if (this.scrollOffset >= this.maxScroll) this.autoFollow = true;
			this.tui.requestRender();
			return;
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			const next = Math.max(0, Math.min(this.maxScroll, this.scrollOffset + event.wheelDelta * 3));
			this.scrollOffset = next;
			this.autoFollow = next >= this.maxScroll;
			return { handled: true, render: true };
		}
		return { handled: true, render: false };
	}

	render(width: number): readonly string[] {
		const w = Math.max(36, width);
		const innerW = Math.max(20, w - 4);
		const t = this.theme;
		const border = (s: string) => t.fg("borderAccent", s);
		const muted = (s: string) => t.fg("muted", s);
		const accent = (s: string) => t.fg("accent", s);
		const text = (s: string) => t.fg("text", s);

		const boxLine = (content: string): string => {
			const clipped = truncateToWidth(content, innerW);
			const pad = " ".repeat(Math.max(0, innerW - visibleWidth(clipped)));
			return `${border("│")} ${clipped}${pad} ${border("│")}`;
		};

		// Header status
		let statusStr: string;
		if (this.streaming) {
			statusStr = accent(`${SPINNER_FRAMES[this.spinnerIdx]} thinking…`);
		} else if (this.errorText) {
			statusStr = t.fg("error", "error");
		} else {
			const parts = [`${(this.elapsedMs / 1000).toFixed(1)}s`];
			if (this.cacheReadTokens > 0) {
				parts.push(`cache ${Math.round(this.cacheReadTokens / 1000)}k`);
			}
			if (this.outputTokens > 0) {
				parts.push(`↓${this.outputTokens}`);
			}
			statusStr = muted(parts.join(" · "));
		}

		const leftTitle = `${border("╭─")} ${t.bold(accent("btw"))} ${muted(`· ${this.modelLabel}`)} `;
		const rightTitle = ` ${statusStr} ${border("─╮")}`;
		const topFill = Math.max(1, w - visibleWidth(leftTitle) - visibleWidth(rightTitle));
		const topBorder = truncateToWidth(`${leftTitle}${border("─".repeat(topFill))}${rightTitle}`, w);

		// Question line
		const qLine = boxLine(`${accent("›")} ${text(this.question)}`);
		const sepLine = `${border("├")}${border("─".repeat(Math.max(1, w - 2)))}${border("┤")}`;

		// Body lines (Markdown or loading/error)
		let rawBody: string[];
		if (this.errorText) {
			rawBody = [t.fg("error", `Error: ${this.errorText}`)];
		} else if (!this.answerText) {
			rawBody = [muted(`${SPINNER_FRAMES[this.spinnerIdx]} Asking side question (not added to context)…`)];
		} else {
			rawBody = [...this.markdown.render(innerW)];
		}

		const maxBodyRows = Math.max(6, Math.min(22, Math.floor((this.tui.terminal.rows || 40) * 0.55)));
		this.maxScroll = Math.max(0, rawBody.length - maxBodyRows);
		if (this.autoFollow) {
			this.scrollOffset = this.maxScroll;
		} else {
			this.scrollOffset = Math.max(0, Math.min(this.maxScroll, this.scrollOffset));
		}

		const visibleRows = rawBody.slice(this.scrollOffset, this.scrollOffset + maxBodyRows);
		const bodyLines = visibleRows.map((line) => boxLine(line));

		// Footer hints
		let footerHint: string;
		if (this.copiedFlash) {
			footerHint = t.fg("success", "✓ 已复制到剪贴板");
		} else if (this.streaming) {
			footerHint = muted("Esc 取消 · 不进入主对话 context");
		} else {
			const scrollHint = this.maxScroll > 0 ? " · ↑↓/滚轮 滚动" : "";
			footerHint = muted(`Esc / Enter / Space 关闭 · c 复制${scrollHint}`);
		}
		const botLeft = `${border("╰─")} ${footerHint} `;
		const botRight = border("─╯");
		const botFill = Math.max(1, w - visibleWidth(botLeft) - visibleWidth(botRight));
		const bottomBorder = truncateToWidth(`${botLeft}${border("─".repeat(botFill))}${botRight}`, w);

		return [topBorder, qLine, sepLine, ...bodyLines, bottomBorder];
	}
}
