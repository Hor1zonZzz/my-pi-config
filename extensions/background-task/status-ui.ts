import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, isKeyRelease, Key, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { StateTone } from "./format.ts";
import { type FocusKey, focusTransition, listWindow, PANEL_ORDER, type PanelKind, reconcileFocus } from "./status-focus.ts";

const LIST_ROWS = 10;
const TICK_MS = 1000;

export interface PanelRow {
	id: string;
	running: boolean;
	state: { text: string; tone: StateTone };
	elapsed: string;
	label: string;
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

function toneColor(tone: StateTone): "accent" | "success" | "error" | "muted" {
	return tone === "running" ? "accent" : tone;
}

/**
 * Footer entries for background tasks and monitors that can take focus.
 *
 * The editor keeps real keyboard focus. A raw terminal input listener runs before it and,
 * while a footer entry is focused, takes the navigation keys. Enter opens the entry's list.
 */
export class StatusPanels {
	private readonly sources: Map<PanelKind, PanelSource>;
	private ui?: ExtensionUIContext;
	private unsubscribe?: () => void;
	private focused?: PanelKind;
	private list?: PanelList;

	constructor(sources: PanelSource[]) {
		this.sources = new Map(sources.map((source) => [source.kind, source]));
	}

	attach(ui: ExtensionUIContext, interactive: boolean): void {
		this.detach();
		this.ui = ui;
		if (interactive) this.unsubscribe = ui.onTerminalInput((data) => this.onInput(data));
		this.refresh();
	}

	detach(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.focused = undefined;
		const ui = this.ui;
		this.ui = undefined;
		for (const source of this.sources.values()) ui?.setStatus(source.statusKey, undefined);
	}

	/** Redraw the footer entries and any open list after a task or monitor changes. */
	refresh(): void {
		const ui = this.ui;
		if (!ui) return;
		this.focused = reconcileFocus(this.focused, this.visible());
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

	private visible(): PanelKind[] {
		return PANEL_ORDER.filter((kind) => (this.sources.get(kind)?.running() ?? 0) > 0);
	}

	private onInput(data: string): { consume?: boolean } | undefined {
		// The open list owns input; key releases carry no action.
		if (this.list || !this.ui || isKeyRelease(data)) return undefined;
		const key = focusKey(data);
		if (!this.focused && key !== "down") return undefined;
		const result = focusTransition(this.focused, key, this.visible(), this.ui.getEditorText() === "");
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

/** The list of one footer entry's tasks or monitors; x stops the selected running one. */
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

	constructor(source: PanelSource, tui: TUI, theme: Theme, keybindings: KeybindingsManager, close: () => void) {
		this.source = source;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.close = close;
		// Running durations change every second.
		this.timer = setInterval(() => {
			if (this.source.running() > 0) this.tui.requestRender();
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
		const { rows, selected } = this.current();
		if (this.keybindings.matches(data, "tui.select.cancel") || this.keybindings.matches(data, "tui.select.confirm")) {
			this.close();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.select(rows, selected - 1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.select(rows, selected + 1);
		} else if (matchesKey(data, "x")) {
			const row = rows[selected];
			if (row?.running && this.source.stop(row.id)) this.stopping.add(row.id);
		} else {
			return;
		}
		this.tui.requestRender();
	}

	private select(rows: PanelRow[], index: number): void {
		if (rows.length === 0) return;
		this.selectedIndex = (index + rows.length) % rows.length;
		this.selectedId = rows[this.selectedIndex].id;
	}

	render(width: number): string[] {
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
			theme.fg("dim", ` ↑↓ select${canStop ? " · x stop" : ""} · esc close`),
			theme.fg("accent", "─".repeat(width)),
		);
		return lines.map((line) => truncateToWidth(line, width));
	}
}
