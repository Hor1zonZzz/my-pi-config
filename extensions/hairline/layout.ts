import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { diffBlocks, formatCount, formatDuration, formatSpeed, sparkLevels, type Weekly } from "./format.ts";
import { bold, C, fg, gradient, mix, SPINNER, shimmer, spread } from "./style.ts";

// Pure renderers: plain models in, width-safe ANSI lines out.

/** Three-row π made of half blocks; colored column by column. */
const PI_MARK = ["████████", " ██  ██ ", "▄█▀  ██▄"];

function mark(row: string): string {
	return [...row].map((ch, x) => (ch === " " ? " " : fg(mix(C.mint, C.sky, x / 7), ch))).join("");
}

function dashes(width: number, color: string): string {
	return width > 0 ? fg(color, "─".repeat(width)) : "";
}

export interface HeaderModel {
	version: string;
	model?: string;
	thinking?: string;
	cwd: string;
	branch?: string | null;
	hints: Array<[key: string, label: string]>;
}

export function renderHeader(m: HeaderModel, width: number): string[] {
	const title = bold(gradient("pi", C.mint, C.sky)) + fg(C.dim, ` ${m.version}`);
	if (width < 30) return ["", truncateToWidth(` ${title}`, width, ""), ""];
	const inner = width - 13;
	const model = m.model ? fg(C.text, m.model) + fg(C.muted, ` · ${m.thinking ?? "off"}`) : "";
	const place = fg(C.muted, m.cwd) + (m.branch ? fg(C.mint, `  ${m.branch}`) : "");
	const hints = m.hints.map(([key, label]) => fg(C.text, key) + fg(C.dim, ` ${label}`)).join("   ");
	const info = [
		spread(title, model ? `  ${model}` : "", inner),
		spread(place, "", inner),
		truncateToWidth(hints, inner, ""),
	];
	return ["", ...PI_MARK.map((row, i) => `  ${mark(row)}   ${info[i]}`), ""];
}

export interface WorkingModel {
	label: string;
	elapsedMs: number;
	errors: number;
	frame: number;
}

export interface TopBorderModel {
	lineColor: string;
	working?: WorkingModel;
	/** Pre-styled text from Pi's retry/compaction indicator. */
	status?: string;
	hiddenAbove: number;
}

/** A plain rule, optionally carrying working status on the left and scroll state on the right. */
export function renderTopBorder(m: TopBorderModel, width: number): string {
	let left = "";
	if (m.working) {
		const w = m.working;
		left =
			` ${fg(w.errors ? C.warning : C.sky, SPINNER[w.frame % SPINNER.length]!)} ${shimmer(w.label, w.frame)}` +
			fg(C.dim, ` · ${formatDuration(w.elapsedMs)} `) +
			(w.errors ? fg(C.error, `✕ ${w.errors} error${w.errors === 1 ? "" : "s"} `) : "");
	} else if (m.status) {
		left = ` ${m.status} `;
	}
	const right = m.hiddenAbove > 0 ? fg(C.muted, ` ↑ ${m.hiddenAbove} more `) : "";
	return rule(width, left, right, m.lineColor);
}

export interface BottomBorderModel {
	lineColor: string;
	model?: string;
	thinking?: string;
	contextPercent?: number | null;
	hiddenBelow: number;
}

export function contextGauge(percent: number, cells = 10): string {
	const filled = Math.min(cells, Math.max(0, Math.round((cells * percent) / 100)));
	let out = "";
	for (let i = 0; i < cells; i++) {
		out += i < filled ? fg(mix(C.mint, C.sky, i / Math.max(1, cells - 1)), "▰") : fg(C.rule, "▰");
	}
	return out;
}

export function renderBottomBorder(m: BottomBorderModel, width: number): string {
	const left = m.model
		? ` ${fg(C.text, m.model)}${fg(C.muted, ` · ${m.thinking ?? "off"}`)} `
		: ` ${fg(C.muted, "no model")} `;
	let right = m.hiddenBelow > 0 ? fg(C.muted, ` ↓ ${m.hiddenBelow} more `) + fg(m.lineColor, "─") : "";
	const percent = m.contextPercent;
	if (percent === undefined || percent === null || !Number.isFinite(percent)) {
		right += ` ${fg(C.dim, "context")} ${fg(C.muted, "?")} `;
	} else {
		const color = percent > 90 ? C.error : percent > 70 ? C.warning : C.muted;
		const gauge = width >= 60 ? `${contextGauge(percent)} ` : "";
		right += ` ${fg(C.dim, "context")} ${gauge}${fg(color, `${Math.round(percent)}%`)} `;
	}
	return rule(width, left, right, m.lineColor);
}

function rule(width: number, left: string, right: string, color: string): string {
	if (width < 2) return dashes(width, color);
	return fg(color, "─") + spread(left, right, width - 2, "─", color) + fg(color, "─");
}

export interface FooterModel {
	cwd: string;
	branch?: string | null;
	input: number;
	output: number;
	/** Session cache-read tokens; hidden when zero. */
	cacheRead?: number;
	/** Latest reply's cache hit rate in percent; hidden when undefined. */
	cacheHit?: number;
	cost: number;
	subscription: boolean;
	statuses: string[];
}

/** One line when everything fits; otherwise extension statuses move to a second line. */
export function renderFooter(m: FooterModel, width: number): string[] {
	const left = `  ${fg(C.dim, m.cwd)}${m.branch ? `  ${fg(C.mint, m.branch)}` : ""}`;
	const sep = fg(C.rule, "  ·  ");
	const usage = [
		fg(
			C.dim,
			[
				`↑${formatCount(m.input)}`,
				`↓${formatCount(m.output)}`,
				m.cacheRead ? `R${formatCount(m.cacheRead)}` : "",
				m.cacheHit !== undefined ? `CH${m.cacheHit.toFixed(1)}%` : "",
			]
				.filter(Boolean)
				.join(" "),
		),
		m.cost > 0 || m.subscription ? fg(C.dim, `$${m.cost.toFixed(3)}${m.subscription ? " sub" : ""}`) : "",
	]
		.filter(Boolean)
		.join(sep);
	const statuses = m.statuses.join(fg(C.rule, " · "));
	const oneLine = [usage, statuses].filter(Boolean).join(sep);
	if (visibleWidth(left) + visibleWidth(oneLine) + 4 <= width) return [spread(left, `${oneLine}  `, width)];
	const lines = [spread(left, `${usage}  `, width)];
	if (statuses) lines.push(truncateToWidth(`  ${statuses}`, width, fg(C.dim, "…")));
	return lines;
}

export interface HudModel {
	/** Recent per-message speeds in tokens per second, oldest first. */
	speeds: number[];
	/** Codex weekly quota; absent when codex-statusline shows nothing (for example, other providers). */
	weekly?: Weekly;
}

const TRACK = 16;
/** Column where the weekly segment starts, so it does not shift as the speed text changes. */
const WEEKLY_COLUMN = 44;

function weeklyBar(percent: number, cells: number, stale: boolean): string {
	const filled = Math.min(cells, Math.max(0, Math.round((cells * percent) / 100)));
	let out = "";
	for (let i = 0; i < cells; i++) {
		const color = stale ? C.muted : mix(C.mint, C.sky, i / Math.max(1, cells - 1));
		out += i < filled ? fg(color, "━") : fg(C.track, "─");
	}
	return out;
}

function weeklySegment(weekly: Weekly, cells: number): string {
	const label = fg(C.dim, "weekly");
	if (weekly === "loading" || weekly === "unavailable") return `${label}  ${fg(C.dim, weekly)}`;
	const color = weekly.stale ? C.muted : weekly.percent <= 10 ? C.error : weekly.percent <= 25 ? C.warning : C.text;
	const bar = cells > 0 ? `  ${weeklyBar(weekly.percent, cells, weekly.stale)}` : "";
	return `${label}${bar}  ${fg(color, `${weekly.percent}% left`)}${weekly.stale ? fg(C.dim, " (stale)") : ""}`;
}

export function renderHud(m: HudModel, width: number): string[] {
	const window = m.speeds.slice(-TRACK);
	const levels = sparkLevels(window);
	const pad = TRACK - window.length;
	const track =
		fg(C.track, "▁".repeat(pad)) + levels.map((ch, i) => fg(mix(C.mint, C.sky, (pad + i) / (TRACK - 1)), ch)).join("");
	const last = window.length > 0 ? window[window.length - 1] : undefined;
	const value = last === undefined ? fg(C.dim, "waiting for the first reply") : fg(C.text, `${formatSpeed(last)} tok/s`);
	const speed = `  ${fg(C.dim, "speed")}    ${track}  ${value}`;
	if (!m.weekly) return [truncateToWidth(speed, width, "")];
	const column = Math.max(WEEKLY_COLUMN, visibleWidth(speed) + 4);
	const cells = width >= column + 44 ? 20 : width >= column + 32 ? 10 : 0;
	const line = speed + " ".repeat(column - visibleWidth(speed)) + weeklySegment(m.weekly, cells);
	return [truncateToWidth(line, width, "")];
}

export type CardStatus = "pending" | "running" | "ok" | "error";

export interface CardModel {
	name: string;
	arg: string;
	status: CardStatus;
	/** Pre-styled right-aligned summary. */
	summary: string;
	frame: number;
}

export function renderCard(m: CardModel, width: number): string {
	const glyph =
		m.status === "ok"
			? fg(C.ok, "●")
			: m.status === "error"
				? fg(C.error, "✕")
				: m.status === "running"
					? fg(C.sky, SPINNER[m.frame % SPINNER.length]!)
					: fg(C.dim, "·");
	const left = `  ${glyph}  ${bold(fg(C.text, m.name.padEnd(6)))}${fg(C.muted, m.arg)}`;
	return spread(left, m.summary ? `  ${m.summary}  ` : "", width);
}

export function renderSubLine(text: string, color: string, width: number): string {
	return truncateToWidth(`     ${fg(C.rule, "╰")} ${fg(color, text)}`, width, fg(C.dim, "…"));
}

export function diffSummary(added: number, removed: number): string {
	const [plus, minus, rest] = diffBlocks(added, removed);
	return (
		fg(C.ok, `+${added}`) +
		fg(C.error, ` −${removed}`) +
		"  " +
		fg(C.ok, "■".repeat(plus)) +
		fg(C.error, "■".repeat(minus)) +
		fg(C.rule, "■".repeat(rest))
	);
}
