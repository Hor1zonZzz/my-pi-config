import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { panelLines } from "./render.ts";
import type { RunRegistry, RunSnapshot } from "./runs.ts";

export const STOP_CONFIRM_MS = 3000;

export interface PanelHost {
	/** True when Pi's main prompt editor has focus (not a dialog or overlay). */
	isEditorFocused(): boolean;
	isEditorEmpty(): boolean;
	requestRender(): void;
	open(runId: string): void;
	stop(runId: string): void;
	now?(): number;
}

type InputResult = { consume: true } | undefined;

/**
 * The list of running subagents below the editor. On an empty prompt, ↓
 * moves the selection into the list; ↑ from the first row, Esc, or any other
 * key hands input back to the editor.
 */
export class RunPanel {
	private readonly registry: RunRegistry;
	private readonly host: PanelHost;
	private selectedId: string | undefined;
	private stopArmed: { id: string; at: number } | undefined;

	constructor(registry: RunRegistry, host: PanelHost) {
		this.registry = registry;
		this.host = host;
	}

	private now(): number {
		return this.host.now?.() ?? Date.now();
	}

	runs(): RunSnapshot[] {
		return this.registry.running().map((run) => run.snapshot);
	}

	get active(): boolean {
		return this.selectedId !== undefined;
	}

	/** Index of the selected row, following the run if the list order changes. */
	selectedIndex(runs = this.runs()): number | undefined {
		if (this.selectedId === undefined || runs.length === 0) return undefined;
		const index = runs.findIndex((run) => run.id === this.selectedId);
		return index >= 0 ? index : Math.min(runs.length - 1, 0);
	}

	deactivate(): void {
		this.selectedId = undefined;
		this.stopArmed = undefined;
	}

	private done(): InputResult {
		this.host.requestRender();
		return { consume: true };
	}

	handleInput(data: string): InputResult {
		const runs = this.runs();
		if (this.selectedId === undefined) {
			if (runs.length > 0 && matchesKey(data, "down") && this.host.isEditorFocused() && this.host.isEditorEmpty()) {
				this.selectedId = runs[0]!.id;
				return this.done();
			}
			return undefined;
		}
		// A dialog or overlay took focus, or every run finished: leave the list.
		if (!this.host.isEditorFocused() || runs.length === 0) {
			this.deactivate();
			this.host.requestRender();
			return undefined;
		}
		const index = this.selectedIndex(runs) ?? 0;
		const run = runs[index]!;
		this.selectedId = run.id;
		if (matchesKey(data, "up")) {
			if (index === 0) this.deactivate();
			else this.selectedId = runs[index - 1]!.id;
			this.stopArmed = undefined;
			return this.done();
		}
		if (matchesKey(data, "down")) {
			this.selectedId = runs[Math.min(runs.length - 1, index + 1)]!.id;
			this.stopArmed = undefined;
			return this.done();
		}
		if (matchesKey(data, "enter")) {
			this.stopArmed = undefined;
			this.host.open(run.id);
			return this.done();
		}
		if (data === "x") {
			const now = this.now();
			if (this.stopArmed?.id === run.id && now - this.stopArmed.at <= STOP_CONFIRM_MS) {
				this.stopArmed = undefined;
				this.host.stop(run.id);
			} else {
				this.stopArmed = { id: run.id, at: now };
			}
			return this.done();
		}
		if (matchesKey(data, "escape")) {
			// Consumed so Esc leaves the list instead of interrupting the main agent.
			this.deactivate();
			return this.done();
		}
		// Typing goes back to the editor.
		this.deactivate();
		this.host.requestRender();
		return undefined;
	}

	lines(theme: Theme, width: number): string[] {
		const runs = this.runs();
		if (runs.length === 0) {
			if (this.selectedId !== undefined) this.deactivate();
			return [];
		}
		const now = this.now();
		const lines = panelLines(theme, runs, this.selectedIndex(runs), width, now);
		const armed = this.stopArmed && now - this.stopArmed.at <= STOP_CONFIRM_MS
			? runs.find((run) => run.id === this.stopArmed!.id)
			: undefined;
		if (armed) {
			lines[0] = truncateToWidth(`  ${theme.fg("warning", "!")} ${theme.fg("warning", `press x again to stop ${armed.agent}`)}${theme.fg("dim", " · any other key cancels")}`, width, "");
		}
		return lines;
	}
}
