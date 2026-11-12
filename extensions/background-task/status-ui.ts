import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	isKeyRelease,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { StateTone } from "./format.ts";
import { readLogTail } from "./log-tail.ts";
import {
	type FocusKey,
	focusTransition,
	listWindow,
	mergeIntoStatsLine,
	PANEL_ORDER,
	type PanelKind,
	reconcileFocus,
} from "./status-focus.ts";

const LIST_ROWS = 10;
const TICK_MS = 1000;
/** Rows of the screen the output viewer leaves for Pi's transcript, status, and footer. */
const VIEWER_RESERVED_ROWS = 14;
const VIEWER_MIN_ROWS = 5;
const STDERR_ROWS = 4;
/** Zero-line widget below the editor whose only job is to hand over the TUI. */
const FOCUS_PROBE_WIDGET = "background-task-focus-probe";

export interface PanelRow {
	id: string;
	running: boolean;
	state: { text: string; tone: StateTone };
	elapsed: string;
	label: string;
}

/** What the output viewer shows for one task or monitor. */
export interface PanelDetail {
	id: string;
	running: boolean;
	state: { text: string; tone: StateTone };
	elapsed: string;
	/** The command or the monitor description. */
	title: string;
	/** Counts and timing after the elapsed time, such as `128 lines` or `3 events · 25m left`. */
	meta: string;
	/** What the log holds, such as `output` or `stdout`. */
	logLabel: string;
	logPath: string;
	/** A monitor's stderr, shown below its stdout when not empty. */
	stderrPath?: string;
}

/** One footer entry and the list behind it. */
export interface PanelSource {
	kind: PanelKind;
	/** Footer status key; Pi orders statuses by key, so keys follow PANEL_ORDER. */
	statusKey: string;
	label: string;
	title: string;
	empty: string;
	running(): number;
	/** Running rows first, then finished ones, newest first in each group. */
	rows(now: number): PanelRow[];
	/** The output viewer's data for a row, or undefined once the row is gone. */
	detail(id: string, now: number): PanelDetail | undefined;
	stop(id: string): boolean;
}

function focusKey(data: string): FocusKey {
	if (matchesKey(data, Key.down)) return "down";
	if (matchesKey(data, Key.up)) return "up";
	if (matchesKey(data, Key.left)) return "left";
	if (matchesKey(data, Key.right)) return "right";
	if (matchesKey(data, Key.enter)) return "enter";
	if (matchesKey(data, Key.escape)) return "escape";
	return "other";
}

/** The parts of pi-tui's Editor used to decide whether ↓ can leave it. */
interface FocusedEditor {
	getText(): string;
	getLines?(): string[];
	getCursor?(): { line: number; col: number };
	isShowingAutocomplete?(): boolean;
	/** Private in pi-tui; true when the cursor is on the last wrapped row of the text. */
	isOnLastVisualLine?(): boolean;
	/** Private in pi-tui; -1 unless ↑/↓ are browsing input history. */
	historyIndex?: number;
}

/**
 * Whether ↓ in the editor would have nothing left to do, so it can move to the footer:
 * no autocomplete list to move through, no history to browse forward, and the cursor
 * already on the last line. Editor internals are optional; the fallback is the last
 * logical line, which only differs while that line wraps.
 */
function editorAtBottom(editor: FocusedEditor): boolean {
	if (editor.getText() === "") return true;
	if (editor.isShowingAutocomplete?.()) return false;
	if (typeof editor.historyIndex === "number" && editor.historyIndex > -1) return false;
	if (typeof editor.isOnLastVisualLine === "function") return editor.isOnLastVisualLine();
	const lines = editor.getLines?.();
	const cursor = editor.getCursor?.();
	return !!lines && !!cursor && cursor.line >= lines.length - 1;
}

/** Pi's built-in footer: the pwd line, the stats line, then one line of extension statuses. */
type BuiltinFooter = Component;

/**
 * Find Pi's built-in footer in the TUI tree. It is not exported to extensions as an instance,
 * and module identity may differ under the extension loader, so it is recognized by the
 * methods only it has.
 */
function findBuiltinFooter(component: Component): BuiltinFooter | undefined {
	const candidate = component as Component & {
		getSessionStats?: unknown;
		setAutoCompactEnabled?: unknown;
		children?: Component[];
	};
	if (typeof candidate.getSessionStats === "function" && typeof candidate.setAutoCompactEnabled === "function") {
		return candidate;
	}
	for (const child of candidate.children ?? []) {
		const found = findBuiltinFooter(child);
		if (found) return found;
	}
	return undefined;
}

/**
 * Pi's built-in footer with the bg/mon entries placed on its stats line, after the context
 * usage, instead of on their own status line. Without room they lead the status line.
 */
class InlineFooter implements Component {
	constructor(
		private readonly builtin: BuiltinFooter,
		private readonly theme: Theme,
		private readonly entries: () => { candidates: string[]; compact: string } | undefined,
	) {}

	invalidate(): void {
		this.builtin.invalidate();
	}

	render(width: number): string[] {
		const lines = [...this.builtin.render(width)];
		const entries = this.entries();
		if (!entries || lines.length < 2) return lines;
		const restore = this.theme.getFgAnsi("dim");
		for (const segment of entries.candidates) {
			const merged = mergeIntoStatsLine(lines[1], segment, restore, visibleWidth);
			if (merged) {
				lines[1] = merged;
				return lines;
			}
		}
		const statusLine = lines.length > 2 ? `${entries.compact} ${lines[2]}` : entries.compact;
		lines.splice(2, lines.length > 2 ? 1 : 0, truncateToWidth(statusLine, width, this.theme.fg("dim", "...")));
		return lines;
	}
}

function toneColor(tone: StateTone): "accent" | "success" | "error" | "muted" {
	return tone === "running" ? "accent" : tone;
}

/**
 * Footer entries for background tasks and monitors that can take focus.
 *
 * The editor keeps real keyboard focus. A raw terminal input listener runs before it and,
 * while a footer entry is focused, takes the navigation keys. Enter opens the entry's list.
 *
 * The listener runs before every focused component, not just the editor, so it only acts
 * while the main editor has focus; otherwise built-in selectors such as /login would lose ↓.
 */
export class StatusPanels {
	private readonly sources: Map<PanelKind, PanelSource>;
	private ui?: ExtensionUIContext;
	private tui?: TUI;
	private unsubscribe?: () => void;
	private focused?: PanelKind;
	private list?: PanelList;
	/** True while the entries are drawn on the built-in footer's stats line instead of as statuses. */
	private inline = false;

	constructor(sources: PanelSource[]) {
		this.sources = new Map(sources.map((source) => [source.kind, source]));
	}

	attach(ui: ExtensionUIContext, interactive: boolean): void {
		this.detach();
		this.ui = ui;
		if (interactive) {
			// Pi exposes no "editor has focus" query; a widget factory is the public way to get
			// the TUI, whose focused component tells the editor apart from selectors and dialogs.
			ui.setWidget(
				FOCUS_PROBE_WIDGET,
				(tui) => {
					this.tui = tui;
					return { render: () => [], invalidate: () => {} };
				},
				{ placement: "belowEditor" },
			);
			this.unsubscribe = ui.onTerminalInput((data) => this.onInput(data));
			// The widget factory runs synchronously, so the TUI is known here.
			const builtin = this.tui ? findBuiltinFooter(this.tui) : undefined;
			if (builtin) {
				this.inline = true;
				ui.setFooter((_tui, theme) => new InlineFooter(builtin, theme, () => this.entries(theme)));
			}
		}
		this.refresh();
	}

	detach(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.focused = undefined;
		const ui = this.ui;
		if (this.tui) ui?.setWidget(FOCUS_PROBE_WIDGET, undefined);
		if (this.inline) ui?.setFooter(undefined);
		this.inline = false;
		this.tui = undefined;
		this.ui = undefined;
		for (const source of this.sources.values()) ui?.setStatus(source.statusKey, undefined);
	}

	/** Redraw the footer entries and any open list after a task or monitor changes. */
	refresh(): void {
		const ui = this.ui;
		if (!ui) return;
		this.focused = reconcileFocus(this.focused, this.visible());
		if (this.inline) {
			this.tui?.requestRender();
			this.list?.update();
			return;
		}
		const theme = ui.theme;
		for (const source of this.sources.values()) {
			const count = source.running();
			if (count === 0) {
				ui.setStatus(source.statusKey, undefined);
				continue;
			}
			const text = ` ${source.label} ${count} `;
			ui.setStatus(
				source.statusKey,
				this.focused === source.kind && !this.list
					? theme.bg("selectedBg", theme.fg("accent", theme.bold(text))) +
							theme.fg("dim", " enter view · ←→ switch · esc back")
					: theme.fg("accent", text),
			);
		}
		this.list?.update();
	}

	/**
	 * The entries for the stats line, from the longest focus key hint to none, the first that
	 * fits being drawn; undefined when nothing runs.
	 */
	private entries(theme: Theme): { candidates: string[]; compact: string } | undefined {
		const parts: string[] = [];
		let hints: string[] = [];
		for (const kind of PANEL_ORDER) {
			const source = this.sources.get(kind);
			const count = source?.running() ?? 0;
			if (!source || count === 0) continue;
			const text = ` ${source.label} ${count} `;
			if (this.focused === kind && !this.list) {
				parts.push(theme.bg("selectedBg", theme.fg("accent", theme.bold(text))));
				hints = [" enter view · ←→ switch · esc back", " ↵ view · esc"].map((hint) => theme.fg("dim", hint));
			} else {
				parts.push(theme.fg("accent", text));
			}
		}
		if (parts.length === 0) return undefined;
		const compact = parts.join("");
		return { candidates: [...hints.map((hint) => compact + hint), compact], compact };
	}

	private visible(): PanelKind[] {
		return PANEL_ORDER.filter((kind) => (this.sources.get(kind)?.running() ?? 0) > 0);
	}

	/**
	 * The main input editor, when it has keyboard focus. Only pi-tui's Editor (which Pi's editor
	 * and custom editors extend) has getText; duck typing avoids depending on module identity.
	 * Since Pi 1.5 the public TUI interface omits getFocusedComponent(); both screens extend
	 * TuiBase, which still has it, so probe for it and treat its absence as "not the editor".
	 */
	private focusedEditor(): FocusedEditor | undefined {
		const tui = this.tui as (TUI & { getFocusedComponent?: () => Component | null }) | undefined;
		if (typeof tui?.getFocusedComponent !== "function") return undefined;
		const focused = tui.getFocusedComponent() as Partial<FocusedEditor> | null;
		return typeof focused?.getText === "function" ? (focused as FocusedEditor) : undefined;
	}

	private onInput(data: string): { consume?: boolean } | undefined {
		// The open list owns input; key releases carry no action.
		if (this.list || !this.ui || isKeyRelease(data)) return undefined;
		// A selector or dialog has replaced the editor (for example /login): leave its keys alone.
		const editor = this.focusedEditor();
		if (!editor) {
			if (this.focused) {
				this.focused = undefined;
				this.refresh();
			}
			return undefined;
		}
		const key = focusKey(data);
		if (!this.focused && key !== "down") return undefined;
		const result = focusTransition(this.focused, key, this.visible(), editorAtBottom(editor));
		const changed = result.focused !== this.focused;
		this.focused = result.focused;
		if (result.open) void this.open(result.open);
		else if (changed) this.refresh();
		return result.consume ? { consume: true } : undefined;
	}

	private async open(kind: PanelKind): Promise<void> {
		const ui = this.ui;
		const source = this.sources.get(kind);
		if (!ui || !source || this.list) return;
		try {
			await ui.custom<void>((tui, theme, keybindings, done) => {
				this.list = new PanelList(source, tui, theme, keybindings, () => done());
				this.refresh();
				return this.list;
			});
		} finally {
			this.list = undefined;
			this.refresh();
		}
	}
}

/**
 * The list of one footer entry's tasks or monitors; x stops the selected running one and
 * Enter opens the output viewer for the selected row. The viewer shows the end of the row's
 * log, follows it while it grows, and scrolls back with ↑/↓ and page keys. Both redraw every
 * second only while open, so nothing updates in the background.
 */
class PanelList implements Component {
	private selectedId?: string;
	private selectedIndex = 0;
	private readonly stopping = new Set<string>();
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly source: PanelSource;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly close: () => void;
	/** The row whose output is open, if any. */
	private viewing?: string;
	/** Wrapped lines between the bottom of the viewer and the end of the log; 0 follows the log. */
	private scroll = 0;
	private lastTotal = 0;
	private lastHeight = VIEWER_MIN_ROWS;

	constructor(source: PanelSource, tui: TUI, theme: Theme, keybindings: KeybindingsManager, close: () => void) {
		this.source = source;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.close = close;
		// Running durations and open logs change every second.
		this.timer = setInterval(() => {
			if (this.viewing || this.source.running() > 0) this.tui.requestRender();
		}, TICK_MS);
	}

	update(): void {
		this.tui.requestRender();
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
	}

	/** Rows with the selection kept on the same ID when rows reorder. */
	private current(): { rows: PanelRow[]; selected: number } {
		const rows = this.source.rows(Date.now());
		const byId = this.selectedId ? rows.findIndex((row) => row.id === this.selectedId) : -1;
		const selected = Math.min(Math.max(0, byId >= 0 ? byId : this.selectedIndex), Math.max(0, rows.length - 1));
		this.selectedIndex = selected;
		this.selectedId = rows[selected]?.id;
		return { rows, selected };
	}

	handleInput(data: string): void {
		if (this.viewing) {
			this.handleViewerInput(data);
			this.tui.requestRender();
			return;
		}
		const { rows, selected } = this.current();
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.close();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const row = rows[selected];
			if (!row) {
				this.close();
				return;
			}
			this.viewing = row.id;
			this.scroll = 0;
			this.lastTotal = 0;
		} else if (this.keybindings.matches(data, "tui.select.up")) {
			this.select(rows, selected - 1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.select(rows, selected + 1);
		} else if (matchesKey(data, "x")) {
			this.stopRow(rows[selected]);
		} else {
			return;
		}
		this.tui.requestRender();
	}

	private handleViewerInput(data: string): void {
		const page = Math.max(1, this.lastHeight - 1);
		if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.left)) {
			this.viewing = undefined;
		} else if (this.keybindings.matches(data, "tui.select.up")) {
			this.scroll += 1;
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.scroll = Math.max(0, this.scroll - 1);
		} else if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.scroll += page;
		} else if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.scroll = Math.max(0, this.scroll - page);
		} else if (matchesKey(data, Key.end) || matchesKey(data, "shift+g")) {
			this.scroll = 0;
		} else if (matchesKey(data, Key.home) || matchesKey(data, "g")) {
			this.scroll = Number.MAX_SAFE_INTEGER;
		} else if (matchesKey(data, "x")) {
			const row = this.source.rows(Date.now()).find((item) => item.id === this.viewing);
			this.stopRow(row);
		}
	}

	private stopRow(row: PanelRow | undefined): void {
		if (row?.running && this.source.stop(row.id)) this.stopping.add(row.id);
	}

	private select(rows: PanelRow[], index: number): void {
		if (rows.length === 0) return;
		this.selectedIndex = (index + rows.length) % rows.length;
		this.selectedId = rows[this.selectedIndex].id;
	}

	render(width: number): string[] {
		const lines = this.viewing ? this.renderViewer(width, this.viewing) : this.renderList(width);
		return lines.map((line) => truncateToWidth(line, width));
	}

	private renderList(width: number): string[] {
		const theme = this.theme;
		const { rows, selected } = this.current();
		const running = rows.filter((row) => row.running).length;
		const lines = [
			theme.fg("accent", "─".repeat(width)),
			` ${theme.fg("accent", theme.bold(this.source.title))}${theme.fg("muted", ` · ${running} running, ${rows.length - running} finished`)}`,
		];
		if (rows.length === 0) {
			lines.push(` ${theme.fg("muted", this.source.empty)}`);
		} else {
			const window = listWindow(selected, rows.length, LIST_ROWS);
			const idWidth = Math.max(...rows.map((row) => row.id.length));
			const stateWidth = Math.max(8, ...rows.map((row) => row.state.text.length));
			const elapsedWidth = Math.max(...rows.map((row) => row.elapsed.length));
			if (window.start > 0) lines.push(theme.fg("dim", `   ↑ ${window.start} more`));
			for (let index = window.start; index < window.end; index++) {
				const row = rows[index];
				const isSelected = index === selected;
				const state = row.running && this.stopping.has(row.id) ? { text: "stopping", tone: "muted" as const } : row.state;
				const line = [
					isSelected ? theme.fg("accent", " › ") : "   ",
					theme.fg(isSelected ? "accent" : "text", row.id.padEnd(idWidth)),
					"  ",
					theme.fg(toneColor(state.tone), state.text.padEnd(stateWidth)),
					"  ",
					theme.fg("muted", row.elapsed.padStart(elapsedWidth)),
					"  ",
					theme.fg(row.running ? "text" : "muted", row.label),
				].join("");
				lines.push(isSelected ? theme.bg("selectedBg", truncateToWidth(line, width, "...", true)) : line);
			}
			if (window.end < rows.length) lines.push(theme.fg("dim", `   ↓ ${rows.length - window.end} more`));
		}
		const canStop = rows[selected]?.running === true;
		lines.push(
			theme.fg("dim", ` ↑↓ select${rows.length > 0 ? " · enter output" : ""}${canStop ? " · x stop" : ""} · esc close`),
			theme.fg("accent", "─".repeat(width)),
		);
		return lines;
	}

	private renderViewer(width: number, id: string): string[] {
		const theme = this.theme;
		const detail = this.source.detail(id, Date.now());
		const rule = theme.fg("accent", "─".repeat(width));
		if (!detail) {
			this.viewing = undefined;
			return this.renderList(width);
		}
		const state = detail.running && this.stopping.has(id) ? { text: "stopping", tone: "muted" as const } : detail.state;
		const lines = [
			rule,
			` ${theme.fg("accent", theme.bold(detail.id))}  ${theme.fg(toneColor(state.tone), state.text)}  ${theme.fg("muted", `${detail.elapsed} · ${detail.meta}`)}`,
			` ${theme.fg("text", detail.title)}`,
			` ${theme.fg("dim", `${detail.logLabel} · ${detail.logPath}`)}`,
		];

		const stderr = detail.stderrPath ? readLogTail(detail.stderrPath, 8 * 1024).lines.slice(-STDERR_ROWS) : [];
		const rows = this.tui.terminal?.rows ?? 24;
		const height = Math.max(VIEWER_MIN_ROWS, rows - VIEWER_RESERVED_ROWS - (stderr.length > 0 ? stderr.length + 1 : 0));
		this.lastHeight = height;

		const tail = readLogTail(detail.logPath);
		const textWidth = Math.max(10, width - 2);
		const wrapped = tail.lines.flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, textWidth)));
		// Keep the same lines in view while scrolled back and the log grows.
		if (this.scroll > 0 && wrapped.length > this.lastTotal) this.scroll += wrapped.length - this.lastTotal;
		this.lastTotal = wrapped.length;
		const maxScroll = Math.max(0, wrapped.length - height);
		this.scroll = Math.min(this.scroll, maxScroll);
		const end = wrapped.length - this.scroll;
		const start = Math.max(0, end - height);

		lines.push(theme.fg("dim", "┄".repeat(width)));
		if (wrapped.length === 0) {
			lines.push(` ${theme.fg("dim", detail.running ? "no output yet" : "no output")}`);
		} else {
			if (start > 0 || tail.truncated) lines.push(theme.fg("dim", ` ↑ ${start} more line${start === 1 ? "" : "s"}${tail.truncated ? " (and earlier output in the log)" : ""}`));
			for (const line of wrapped.slice(start, end)) lines.push(` ${theme.fg("toolOutput", line)}`);
		}
		if (stderr.length > 0) {
			lines.push(` ${theme.fg("dim", `stderr · ${detail.stderrPath}`)}`);
			for (const line of stderr) lines.push(` ${theme.fg("error", line)}`);
		}

		const position = this.scroll === 0 ? (detail.running ? "following" : "end") : `↓ ${this.scroll} more`;
		const keys = ` ↑↓ scroll · pgup/pgdn · g/G top/end${detail.running ? " · x stop" : ""} · esc back`;
		const gap = width - visibleWidth(keys) - visibleWidth(position) - 1;
		lines.push(theme.fg("dim", keys) + (gap > 0 ? " ".repeat(gap) + theme.fg(this.scroll === 0 ? "accent" : "warning", position) : ""));
		lines.push(rule);
		return lines;
	}
}
