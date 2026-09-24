import { getCapabilities, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Hairline palette: quiet greys with one mint → sky accent gradient.
 * The skin paints its own colors instead of reading Pi theme roles, so it is
 * designed for dark terminal backgrounds.
 */
export const C = {
	text: "#e4e4e7",
	muted: "#8e8f98",
	dim: "#5d5f69",
	track: "#34363f",
	rule: "#4b4e58",
	mint: "#9fe3cf",
	sky: "#8fb4ff",
	ok: "#8fd6a0",
	error: "#f29b9b",
	warning: "#e9c77b",
	shine: "#ffffff",
	shineSoft: "#c6c8cf",
} as const;

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
	const value = Number.parseInt(hex.slice(1), 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function mix(from: string, to: string, t: number): string {
	const a = rgb(from);
	const b = rgb(to);
	const k = Math.min(1, Math.max(0, t));
	return `#${a.map((v, i) => Math.round(v + (b[i]! - v) * k).toString(16).padStart(2, "0")).join("")}`;
}

let trueColorOverride: boolean | undefined;

/** Force truecolor output on or off; `undefined` restores terminal detection. */
export function setTrueColorOverride(value: boolean | undefined): void {
	trueColorOverride = value;
}

function ansi256([r, g, b]: Rgb): number {
	if (r === g && g === b) {
		if (r < 8) return 16;
		if (r > 248) return 231;
		return Math.round(((r - 8) / 247) * 24) + 232;
	}
	const level = (v: number) => Math.round((v / 255) * 5);
	return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

/** Foreground color; resets only the foreground so surrounding styles survive. */
export function fg(hex: string, text: string): string {
	if (!text) return "";
	const color = rgb(hex);
	const trueColor = trueColorOverride ?? getCapabilities().trueColor;
	const code = trueColor ? `38;2;${color[0]};${color[1]};${color[2]}` : `38;5;${ansi256(color)}`;
	return `\x1b[${code}m${text}\x1b[39m`;
}

export function bold(text: string): string {
	return text ? `\x1b[1m${text}\x1b[22m` : "";
}

export function italic(text: string): string {
	return text ? `\x1b[3m${text}\x1b[23m` : "";
}

export function gradient(text: string, from: string, to: string): string {
	const chars = [...text];
	const last = Math.max(1, chars.length - 1);
	return chars.map((ch, i) => fg(mix(from, to, i / last), ch)).join("");
}

/** A highlight that sweeps across muted text; each frame moves it one column. */
export function shimmer(text: string, frame: number): string {
	const chars = [...text];
	const head = (frame % (chars.length + 10)) - 3;
	return chars
		.map((ch, i) => {
			const distance = Math.abs(i - head);
			const color =
				distance === 0 ? C.shine : distance === 1 ? C.shineSoft : distance === 2 ? mix(C.shineSoft, C.muted, 0.5) : C.muted;
			return fg(color, ch);
		})
		.join("");
}

/** Animation frame derived from wall time, so any render tick advances it. */
export function frameAt(now: number, stepMs = 80): number {
	return Math.floor(now / stepMs);
}

/**
 * Left text, a fill run, then right text, never wider than `width`.
 * The left side is truncated first so right-aligned status stays visible.
 */
export function spread(left: string, right: string, width: number, fill = " ", fillColor?: string): string {
	if (width <= 0) return "";
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(left, width, "");
	let head = left;
	if (visibleWidth(head) + rightWidth > width) head = truncateToWidth(head, width - rightWidth, "…");
	const gap = Math.max(0, width - visibleWidth(head) - rightWidth);
	const run = fill.repeat(gap);
	return head + (fillColor ? fg(fillColor, run) : run) + right;
}
