/** Footer entries that can take focus, in footer order (Pi sorts statuses by key). */
export type PanelKind = "bg" | "mon";
export const PANEL_ORDER: readonly PanelKind[] = ["bg", "mon"];

export type FocusKey = "down" | "up" | "left" | "right" | "enter" | "escape" | "other";

export interface FocusResult {
	/** The focused footer entry after the key, or undefined when the editor has focus. */
	focused?: PanelKind;
	/** Whether the key is swallowed instead of reaching the editor. */
	consume: boolean;
	/** The entry whose list should open. */
	open?: PanelKind;
}

/**
 * Footer focus as a pure transition.
 *
 * Down in an empty editor moves focus to the first visible entry; left/right move between
 * entries; enter opens the focused entry's list; up or escape return to the editor. Any other
 * key returns focus to the editor and reaches it, so typing is never lost.
 */
export function focusTransition(
	focused: PanelKind | undefined,
	key: FocusKey,
	visible: readonly PanelKind[],
	editorEmpty: boolean,
): FocusResult {
	const current = focused && visible.includes(focused) ? focused : undefined;
	if (!current) {
		if (key === "down" && editorEmpty && visible.length > 0) return { focused: visible[0], consume: true };
		return { focused: undefined, consume: false };
	}
	const index = visible.indexOf(current);
	switch (key) {
		case "left":
			return { focused: visible[Math.max(0, index - 1)], consume: true };
		case "right":
			return { focused: visible[Math.min(visible.length - 1, index + 1)], consume: true };
		case "down":
			return { focused: current, consume: true };
		case "enter":
			return { focused: current, consume: true, open: current };
		case "up":
		case "escape":
			return { focused: undefined, consume: true };
		default:
			return { focused: undefined, consume: false };
	}
}

/** Keep focus on an entry that is still visible, or give it back to the editor. */
export function reconcileFocus(focused: PanelKind | undefined, visible: readonly PanelKind[]): PanelKind | undefined {
	return focused && visible.includes(focused) ? focused : undefined;
}

/** Keep the selected row valid and inside a scrolling window of `height` rows. */
export function listWindow(
	selected: number,
	count: number,
	height: number,
): { selected: number; start: number; end: number } {
	if (count === 0) return { selected: 0, start: 0, end: 0 };
	const clamped = Math.min(Math.max(0, selected), count - 1);
	const size = Math.max(1, Math.min(height, count));
	const start = Math.min(Math.max(0, clamped - Math.floor(size / 2)), count - size);
	return { selected: clamped, start, end: start + size };
}
