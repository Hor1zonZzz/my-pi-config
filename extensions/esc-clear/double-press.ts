/** Two presses this close together are a double press; Pi's own double Escape uses the same window. */
export const DOUBLE_PRESS_MS = 500;

/**
 * Detects two presses in a row over the same draft.
 *
 * The draft is compared instead of watching the keys in between: terminal replies and other
 * non-key input pass through the same listener, and any edit already changes the draft.
 */
export class DoublePress {
	private readonly windowMs: number;
	private first?: { at: number; draft: string };

	constructor(windowMs = DOUBLE_PRESS_MS) {
		this.windowMs = windowMs;
	}

	/**
	 * Record a press at `now` over `draft`, or over nothing clearable (undefined), which also
	 * forgets an earlier press. True when the press completes a double press.
	 */
	press(now: number, draft: string | undefined): boolean {
		const first = this.first;
		this.first = undefined;
		if (draft === undefined) return false;
		if (first && first.draft === draft && now - first.at < this.windowMs) return true;
		this.first = { at: now, draft };
		return false;
	}
}
