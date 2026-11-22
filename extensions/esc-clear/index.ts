/**
 * Double Escape clears the input editor.
 *
 * Pi gives Escape a job in most states: it aborts a run or a compaction, closes autocomplete and
 * selectors, and, twice on an empty editor, opens /tree. With a draft in an idle editor it does
 * nothing, which is the one case handled here: two presses within 500 ms clear the draft.
 * The editor's undo (ctrl+-) brings it back.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { DoublePress } from "./double-press.ts";

const FOCUS_PROBE_WIDGET = "esc-clear-focus-probe";

/** The parts of pi-tui's Editor used here; Pi's editor and custom editors extend it. */
interface FocusedEditor {
	getText(): string;
	isShowingAutocomplete?(): boolean;
}

export default function (pi: ExtensionAPI) {
	let detach: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		detach?.();
		detach = undefined;
		if (ctx.mode !== "tui") return;
		const ui = ctx.ui;

		// Pi exposes no "editor has focus" query; a widget factory is the public way to get the
		// TUI, whose focused component tells the editor apart from selectors and dialogs.
		let tui: (TUI & { getFocusedComponent?: () => unknown }) | undefined;
		ui.setWidget(
			FOCUS_PROBE_WIDGET,
			(widgetTui) => {
				tui = widgetTui;
				return { render: () => [], invalidate: () => {} };
			},
			{ placement: "belowEditor" },
		);

		/** The draft a double Escape would clear, or undefined while Escape means something else. */
		const clearableDraft = (): string | undefined => {
			// Escape aborts a run or a compaction.
			if (!ctx.isIdle()) return undefined;
			// Since Pi 1.5 the public TUI interface omits getFocusedComponent(); probe for it.
			// Only the editor has getText(); a selector or dialog closes on Escape instead.
			const focused = tui?.getFocusedComponent?.() as Partial<FocusedEditor> | null | undefined;
			if (typeof focused?.getText !== "function") return undefined;
			// Escape closes the autocomplete menu.
			if (focused.isShowingAutocomplete?.()) return undefined;
			// A blank editor is Pi's own double Escape (doubleEscapeAction).
			const draft = focused.getText();
			return draft.trim() ? draft : undefined;
		};

		const presses = new DoublePress();
		const unsubscribe = ui.onTerminalInput((data) => {
			// Holding the key down is not a double press.
			if (isKeyRelease(data) || isKeyRepeat(data) || !matchesKey(data, Key.escape)) return undefined;
			if (!presses.press(Date.now(), clearableDraft())) return undefined;
			ui.setEditorText("");
			// A consumed key skips the render that follows normal input handling.
			tui?.requestRender();
			// Keep the press from Pi, which would count it toward its empty-editor double Escape.
			return { consume: true };
		});

		detach = () => {
			unsubscribe();
			ui.setWidget(FOCUS_PROBE_WIDGET, undefined);
		};
	});

	pi.on("session_shutdown", () => {
		detach?.();
		detach = undefined;
	});
}
