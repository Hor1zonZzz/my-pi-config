import { execFile } from "node:child_process";
import type { AssistantMessageEvent, Message, Usage } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type MarkdownTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function safeMarkdownTheme(theme: Theme): MarkdownTheme {
	try {
		const mt = getMarkdownTheme();
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

interface BtwTurn {
	question: string;
	answer: string;
	markdown: Markdown;
	error?: string;
	elapsedMs: number;
	cacheRead: number;
	outputTokens: number;
}

export interface BtwPersistedTurn {
	question: string;
	answer: string;
	elapsedMs: number;
	cacheRead: number;
	outputTokens: number;
}

export interface BtwCompletedTurn {
	question: string;
	answer: string;
	elapsedMs: number;
	usage?: Usage;
}

export interface BtwOverlayOptions {
	tui: TUI;
	theme: Theme;
	initialQuestion?: string;
	initialTurns?: readonly BtwPersistedTurn[];
	modelLabel: string;
	markdownTransform?: (markdown: string, availableWidth: number) => string;
	askSideQuestion: (
		sideHistory: readonly Message[],
		question: string,
		signal: AbortSignal,
	) => AsyncIterable<AssistantMessageEvent>;
	onSelectModel?: () => Promise<string | undefined>;
	onTurnComplete?: (turn: BtwCompletedTurn) => void;
	onClear?: () => void;
	done: () => void;
}

export class BtwOverlayComponent implements Component, Focusable {
	focused = true;

	private tui: TUI;
	private theme: Theme;
	private mdTheme: MarkdownTheme;
	private markdownTransform?: (markdown: string, availableWidth: number) => string;
	private modelLabel: string;
	private askSideQuestion: BtwOverlayOptions["askSideQuestion"];
	private onSelectModel?: () => Promise<string | undefined>;
	private onTurnComplete?: BtwOverlayOptions["onTurnComplete"];
	private onClear?: () => void;
	private done: () => void;

	private turns: BtwTurn[] = [];
	private sideHistory: Message[] = [];
	private input: Input;
	private abortController: AbortController | null = null;
	private streaming = false;
	private startMs = 0;

	private scrollOffset = 0;
	private autoFollow = true;
	private maxScroll = 0;
	private expandedTurns = new Set<number>();
	private rowToTurnHeader = new Map<number, number>();
	private spinnerIdx = 0;
	private spinnerTimer: ReturnType<typeof setInterval> | null = null;
	private copiedFlash = false;
	private copiedTimer: ReturnType<typeof setTimeout> | null = null;
	private clearedNotice = false;
	private disposed = false;

	constructor(opts: BtwOverlayOptions) {
		this.tui = opts.tui;
		this.theme = opts.theme;
		this.mdTheme = safeMarkdownTheme(opts.theme);
		this.markdownTransform = opts.markdownTransform;
		this.modelLabel = opts.modelLabel;
		this.askSideQuestion = opts.askSideQuestion;
		this.onSelectModel = opts.onSelectModel;
		this.onTurnComplete = opts.onTurnComplete;
		this.onClear = opts.onClear;
		this.done = opts.done;

		this.input = new Input();
		this.input.focused = true;
		this.input.onSubmit = (val) => {
			const q = val.trim();
			if (!q || this.streaming) return;
			this.input.setValue("");
			this.startTurn(q);
		};
		this.input.onEscape = () => {
			this.handleEscape();
		};

		// Preload historical turns (e.g., when bare `/btw` is invoked to view session history)
		if (opts.initialTurns && opts.initialTurns.length > 0) {
			for (const prev of opts.initialTurns) {
				const md = new Markdown(
					prev.answer,
					0,
					0,
					this.mdTheme,
					undefined,
					this.markdownTransform ? { transform: this.markdownTransform } : undefined,
				);
				this.turns.push({
					question: prev.question,
					answer: prev.answer,
					markdown: md,
					elapsedMs: prev.elapsedMs,
					cacheRead: prev.cacheRead,
					outputTokens: prev.outputTokens,
				});
				this.sideHistory.push({
					role: "user",
					content: [{ type: "text", text: prev.question }],
					timestamp: Date.now(),
				});
				this.sideHistory.push({
					role: "assistant",
					content: [{ type: "text", text: prev.answer }],
					api: "openai-completions",
					provider: "btw",
					model: this.modelLabel,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				});
			}
		}

		if (opts.initialQuestion) {
			this.startTurn(opts.initialQuestion);
		}
	}

	private startTurn(question: string): void {
		if (this.disposed || this.streaming) return;
		this.clearedNotice = false;
		const turn: BtwTurn = {
			question,
			answer: "",
			markdown: new Markdown(
				"",
				0,
				0,
				this.mdTheme,
				undefined,
				this.markdownTransform ? { transform: this.markdownTransform } : undefined,
			),
			elapsedMs: 0,
			cacheRead: 0,
			outputTokens: 0,
		};
		this.turns.push(turn);
		this.streaming = true;
		this.autoFollow = true;
		this.startMs = performance.now();

		const ac = new AbortController();
		this.abortController = ac;

		if (!this.spinnerTimer) {
			this.spinnerTimer = setInterval(() => {
				if (!this.streaming || this.disposed) return;
				this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER_FRAMES.length;
				this.tui.requestRender();
			}, 90);
		}

		const historySnapshot = [...this.sideHistory];
		const stream = this.askSideQuestion(historySnapshot, question, ac.signal);
		this.tui.requestRender();
		void this.consumeStream(turn, question, stream, ac);
	}

	private async consumeStream(
		turn: BtwTurn,
		question: string,
		stream: AsyncIterable<AssistantMessageEvent>,
		ac: AbortController,
	): Promise<void> {
		let finalMessage: Message | null = null;
		let finalUsage: Usage | undefined;
		try {
			for await (const ev of stream) {
				if (this.disposed || ac.signal.aborted) break;
				if (ev.type === "text_delta") {
					turn.answer += ev.delta;
					turn.markdown.setText(turn.answer);
					this.tui.requestRender();
				} else if (ev.type === "done") {
					finalMessage = ev.message;
					const usage = ev.message.usage;
					if (usage) {
						finalUsage = usage;
						turn.cacheRead = usage.cacheRead ?? 0;
						turn.outputTokens = usage.output ?? 0;
					}
				} else if (ev.type === "error") {
					turn.error = ev.error.errorMessage || "Request failed";
				}
			}
		} catch (err) {
			if (!this.disposed && !ac.signal.aborted) {
				turn.error = err instanceof Error ? err.message : String(err);
			}
		} finally {
			turn.elapsedMs = performance.now() - this.startMs;
			if (!ac.signal.aborted && !turn.error && turn.answer.trim()) {
				this.sideHistory.push({
					role: "user",
					content: [{ type: "text", text: question }],
					timestamp: Date.now(),
				});
				if (finalMessage) {
					this.sideHistory.push(finalMessage);
				} else {
					this.sideHistory.push({
						role: "assistant",
						content: [{ type: "text", text: turn.answer }],
						api: "openai-completions",
						provider: "btw",
						model: this.modelLabel,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						stopReason: "stop",
						timestamp: Date.now(),
					});
				}
				this.onTurnComplete?.({
					question,
					answer: turn.answer,
					elapsedMs: turn.elapsedMs,
					usage: finalUsage,
				});
			}
			if (this.abortController === ac) {
				this.abortController = null;
				this.streaming = false;
			}
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
		for (const turn of this.turns) {
			turn.markdown.invalidate();
		}
		this.input.invalidate();
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
		if (this.abortController && !this.abortController.signal.aborted) {
			this.abortController.abort();
		}
	}

	private handleEscape(): void {
		if (this.streaming && this.abortController) {
			this.abortController.abort();
			this.streaming = false;
			this.tui.requestRender();
			return;
		}
		this.dispose();
		this.done();
	}

	private copyLastAnswer(): void {
		const last = [...this.turns].reverse().find((t) => t.answer.trim().length > 0);
		if (!last) return;
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
		child.stdin?.end(last.answer);
	}

	private clearThread(): void {
		if (this.streaming && this.abortController) {
			this.abortController.abort();
			this.abortController = null;
			this.streaming = false;
		}
		if (this.spinnerTimer) {
			clearInterval(this.spinnerTimer);
			this.spinnerTimer = null;
		}
		this.turns = [];
		this.sideHistory = [];
		this.scrollOffset = 0;
		this.maxScroll = 0;
		this.expandedTurns.clear();
		this.rowToTurnHeader.clear();
		this.autoFollow = true;
		this.clearedNotice = true;
		this.onClear?.();
		this.tui.requestRender();
	}

	private allEarlierExpanded(): boolean {
		if (this.turns.length <= 1) return false;
		for (let i = 0; i < this.turns.length - 1; i++) {
			if (!this.expandedTurns.has(i)) return false;
		}
		return true;
	}

	private toggleAllHistory(): void {
		if (this.turns.length <= 1) return;
		if (this.allEarlierExpanded()) {
			this.expandedTurns.clear();
		} else {
			for (let i = 0; i < this.turns.length - 1; i++) {
				this.expandedTurns.add(i);
			}
		}
		this.autoFollow = false;
		this.scrollOffset = 0;
		this.tui.requestRender();
	}

	private toggleTurn(idx: number): void {
		if (idx < 0 || idx >= this.turns.length - 1) return;
		if (this.expandedTurns.has(idx)) {
			this.expandedTurns.delete(idx);
		} else {
			this.expandedTurns.add(idx);
		}
		this.autoFollow = false;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.handleEscape();
			return;
		}
		if (matchesKey(data, "ctrl+y")) {
			this.copyLastAnswer();
			return;
		}
		if (matchesKey(data, "ctrl+l")) {
			if (this.turns.length > 0 || this.streaming) {
				this.clearThread();
			}
			return;
		}
		if (matchesKey(data, "ctrl+p") && !this.streaming && this.onSelectModel) {
			void this.onSelectModel().then((newLabel) => {
				if (newLabel && !this.disposed) {
					this.modelLabel = newLabel;
					this.tui.requestRender();
				}
			});
			return;
		}
		// Single-key shortcuts when input box is empty & idle (Claude Code style: x = clear, m = switch model)
		if (!this.streaming && !this.input.getValue()) {
			if ((data === "x" || data === "X") && this.turns.length > 0) {
				this.clearThread();
				return;
			}
			if ((data === "m" || data === "M") && this.onSelectModel) {
				void this.onSelectModel().then((newLabel) => {
					if (newLabel && !this.disposed) {
						this.modelLabel = newLabel;
						this.tui.requestRender();
					}
				});
				return;
			}
		}
		if (matchesKey(data, "tab") || data === "\t" || matchesKey(data, "ctrl+o")) {
			if (this.turns.length > 1) {
				this.toggleAllHistory();
			}
			return;
		}
		if (matchesKey(data, "up")) {
			this.autoFollow = false;
			this.scrollOffset = Math.max(0, this.scrollOffset - 2);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.scrollOffset = Math.min(this.maxScroll, this.scrollOffset + 2);
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
		// Forward typing/editing/Enter to follow-up input box when idle
		if (!this.streaming) {
			this.input.handleInput(data);
			this.tui.requestRender();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			const next = Math.max(0, Math.min(this.maxScroll, this.scrollOffset + event.wheelDelta * 3));
			this.scrollOffset = next;
			this.autoFollow = next >= this.maxScroll;
			return { handled: true, render: true };
		}
		if (event.type === "press" && event.button === "left") {
			const turnIdx = this.rowToTurnHeader.get(event.y);
			if (turnIdx !== undefined) {
				this.toggleTurn(turnIdx);
				return { handled: true, render: true };
			}
		}
		if (event.type === "click" || event.type === "release") {
			if (this.rowToTurnHeader.has(event.y)) {
				return { handled: true, render: false };
			}
		}
		return { handled: true, render: false };
	}

	private summarizeInline(text: string): string {
		return text
			.replace(/\[\[([^\[\]\n]+)\]\]/g, "$1")
			.replace(/[*_`#>-]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	render(width: number): readonly string[] {
		const w = Math.max(40, width);
		const innerW = Math.max(20, w - 2);
		const t = this.theme;
		const border = (s: string) => t.fg("borderAccent", s);
		const muted = (s: string) => t.fg("muted", s);
		const accent = (s: string) => t.fg("accent", s);
		const text = (s: string) => t.fg("text", s);

		const padLine = (content: string): string => ` ${truncateToWidth(content, innerW)}`;

		const lastTurn = this.turns[this.turns.length - 1];
		let statusStr: string;
		if (this.streaming) {
			statusStr = accent(`${SPINNER_FRAMES[this.spinnerIdx]} thinking…`);
		} else if (lastTurn?.error) {
			statusStr = t.fg("error", "error");
		} else if (lastTurn) {
			const parts = [`${(lastTurn.elapsedMs / 1000).toFixed(1)}s`];
			if (lastTurn.cacheRead > 0) parts.push(`cache ${Math.round(lastTurn.cacheRead / 1000)}k`);
			if (lastTurn.outputTokens > 0) parts.push(`↓${lastTurn.outputTokens}`);
			statusStr = muted(parts.join(" · "));
		} else {
			statusStr = "";
		}

		// Scheme B: Minimal 2-rule frame (1 accent top rule + 1 muted bottom rule)
		const topRule = border("─".repeat(w));
		const turnTag = this.turns.length > 1 ? ` · ${this.turns.length} 轮` : "";
		const headerLeft = `${t.bold(accent("btw"))} ${muted(`· ${this.modelLabel}${turnTag}`)}`;
		const headerGap = Math.max(1, innerW - visibleWidth(headerLeft) - visibleWidth(statusStr));
		const headerLine = padLine(`${headerLeft}${" ".repeat(headerGap)}${statusStr}`);

		// Body: earlier turns collapse to 1-line summaries unless expanded (via mouse click, Tab, or Ctrl+O)
		const rawBody: { text: string; turnHeaderIdx?: number }[] = [];
		if (this.turns.length === 0) {
			const msg = this.clearedNotice
				? "✓ 已清空当前追问上下文，直接输入新问题即可开始新对话（历史仍留存在 session 中）"
				: "输入问题开始旁路对话（不进入主对话 context）";
			rawBody.push({ text: muted(msg) });
		}
		const lastIdx = this.turns.length - 1;
		for (let i = 0; i < this.turns.length; i++) {
			const turn = this.turns[i];
			const isLast = i === lastIdx;
			const isExpanded = isLast || this.expandedTurns.has(i);
			if (!isExpanded) {
				const qBrief = turn.question.replace(/\s+/g, " ").trim();
				const aBrief = turn.error ? `Error: ${turn.error}` : this.summarizeInline(turn.answer);
				const summary = `${muted("▸")} ${muted(`${i + 1}.`)} ${muted(qBrief)} ${muted("→")} ${muted(aBrief || "…")}`;
				rawBody.push({ text: truncateToWidth(summary, innerW), turnHeaderIdx: i });
				continue;
			}
			if (i > 0 && rawBody.length > 0 && rawBody[rawBody.length - 1].turnHeaderIdx === undefined) {
				rawBody.push({ text: "" });
			}
			const qPrefix = !isLast ? `${muted("▾")} ${muted(`${i + 1}.`)} ` : `${accent("›")} `;
			rawBody.push({
				text: `${qPrefix}${t.bold(text(turn.question))}`,
				turnHeaderIdx: !isLast ? i : undefined,
			});
			if (turn.error) {
				rawBody.push({ text: `  ${t.fg("error", `Error: ${turn.error}`)}` });
			} else if (!turn.answer) {
				rawBody.push({ text: `  ${muted(`${SPINNER_FRAMES[this.spinnerIdx]} Answering… (not added to context)`)}` });
			} else {
				const mdLines = turn.markdown.render(Math.max(16, innerW - 2));
				for (const line of mdLines) {
					rawBody.push({ text: `  ${line}` });
				}
			}
		}

		const maxBodyRows = Math.max(4, Math.min(14, Math.floor((this.tui.terminal.rows || 40) * 0.35)));
		this.maxScroll = Math.max(0, rawBody.length - maxBodyRows);
		if (this.autoFollow) {
			this.scrollOffset = this.maxScroll;
		} else {
			this.scrollOffset = Math.max(0, Math.min(this.maxScroll, this.scrollOffset));
		}

		const visibleRows = rawBody.slice(this.scrollOffset, this.scrollOffset + maxBodyRows);
		// Map rendered component row y (topRule = 0, headerLine = 1, body starts at y = 2) to turn header index
		this.rowToTurnHeader.clear();
		const bodyLines = visibleRows.map((row, idx) => {
			if (row.turnHeaderIdx !== undefined) {
				this.rowToTurnHeader.set(2 + idx, row.turnHeaderIdx);
			}
			return padLine(row.text);
		});

		// Subtle dotted divider before the inline input row
		const inputSep = muted("┄".repeat(w));

		// Compact inline hints on the right side of the input row
		let rightHint: string;
		if (this.copiedFlash) {
			rightHint = t.fg("success", "✓ 已复制");
		} else if (this.streaming) {
			rightHint = muted("Esc 取消");
		} else {
			const hintParts = ["⏎ 追问", "Esc 关闭"];
			if (this.turns.length > 0) hintParts.push("^Y 复制", "x 清空");
			if (this.onSelectModel) hintParts.push("m 换模型");
			if (this.turns.length > 1) hintParts.push(this.allEarlierExpanded() ? "Tab/点击 折叠" : "Tab/点击 展开");
			if (this.maxScroll > 0) hintParts.push("↑↓ 滚动");
			rightHint = muted(hintParts.join(" · "));
		}

		// Inline follow-up input row (Input renders its own `> ` prefix)
		this.input.focused = this.focused && !this.streaming;
		let inputLeft: string;
		if (this.streaming) {
			inputLeft = muted(`${SPINNER_FRAMES[this.spinnerIdx]} 回复中…`);
		} else if (!this.input.getValue()) {
			const rendered = (this.input.render(innerW)[0] ?? "> ").trimEnd();
			const placeholder = this.turns.length === 0 ? "输入新问题…" : "继续追问…";
			inputLeft = `${rendered} ${muted(placeholder)}`;
		} else {
			inputLeft = (this.input.render(innerW)[0] ?? "").trimEnd();
		}

		const leftW = visibleWidth(inputLeft);
		const hintW = visibleWidth(rightHint);
		let inputRow: string;
		if (leftW + 2 + hintW <= innerW) {
			inputRow = padLine(`${inputLeft}${" ".repeat(innerW - leftW - hintW)}${rightHint}`);
		} else {
			inputRow = padLine(inputLeft);
		}

		const bottomRule = muted("─".repeat(w));

		return [topRule, headerLine, ...bodyLines, inputSep, inputRow, bottomRule];
	}
}
