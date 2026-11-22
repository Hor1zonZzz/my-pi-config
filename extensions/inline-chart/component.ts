import { appendFileSync } from "node:fs";
import {
	allocateImageId,
	getCapabilities,
	getCellDimensions,
	renderImage,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	engineClient,
	type ChartControl,
	type ChartSpec,
	type PlotBoxFrac,
	type RenderResponse,
	type ThemePalette,
} from "./client.ts";

export interface HostThemeLike {
	appearance?: "dark" | "light";
	colors?: Readonly<Record<string, unknown>>;
	fg?: (token: string, text: string) => string;
	bg?: (token: string, text: string) => string;
}

interface HitRegion {
	kind: "toggle" | "slider";
	id: string;
	row: number;
	startCol: number;
	endCol: number;
	trackStartCol?: number;
	trackEndCol?: number;
	control?: ChartControl;
}

export function toHexColor(c: unknown): string | undefined {
	if (!c) return undefined;
	if (typeof c === "string") {
		const trimmed = c.trim();
		if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
		return undefined;
	}
	if (typeof c === "object" && "r" in c && "g" in c && "b" in c) {
		const { r, g, b } = c as { r: number; g: number; b: number };
		if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
			const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
			return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
		}
	}
	return undefined;
}

export function extractThemeSnapshot(theme?: HostThemeLike): {
	mode: "dark" | "light";
	palette: ThemePalette;
	fingerprint: string;
} {
	const mode: "dark" | "light" = theme?.appearance === "light" ? "light" : "dark";
	const colors = theme?.colors;
	const palette: ThemePalette = {
		bg: toHexColor(colors?.customMessageBg) ?? toHexColor(colors?.userMessageBg),
		border: toHexColor(colors?.borderMuted) ?? toHexColor(colors?.border),
		text_primary: toHexColor(colors?.text),
		text_muted: toHexColor(colors?.muted),
		accent: toHexColor(colors?.accent),
	};
	const fingerprint = `${mode}:${palette.bg ?? ""}:${palette.border ?? ""}:${palette.text_primary ?? ""}:${palette.accent ?? ""}`;
	return { mode, palette, fingerprint };
}

export interface InlineChartInitialState {
	spec: ChartSpec;
	initialFrame?: RenderResponse;
	getTheme?: () => HostThemeLike | undefined;
	onInvalidate: () => void;
}

export class InlineChartComponent implements Component {
	private spec: ChartSpec;
	private getTheme: () => HostThemeLike | undefined;
	private onInvalidate: () => void;
	private imageId: number | undefined;

	// Interactive state
	private controlValues: Record<string, number> = {};
	private hiddenSeries = new Set<string>();
	private hoverX: number | null = null;
	private hoverNormX: number | null = null;
	private hoverNormY: number | null = null;
	private activeSliderId: string | null = null;

	// Latest rendered frame from Rust
	private frame: RenderResponse | null;
	private imageStartRow = 1;
	private plotStartCol = 0;
	private lastImageCols = 0;
	private lastRenderedImageRows = 0;
	private lastTargetW = 0;
	private lastTargetH = 0;
	private lastThemeFingerprint = "";
	private hitRegions: HitRegion[] = [];

	// Latest-only async render pipeline with frame pacing (caps PTY bandwidth so terminal never queues stale frames)
	private inflight = false;
	private pendingRerender = false;
	private pendingReason = "init";
	private coalescedCount = 0;
	private mouseEventCount = 0;
	private lastFrameSentAt = 0;
	private paceTimer: ReturnType<typeof setTimeout> | null = null;
	private lastHoverCol: number | null = null;
	private desiredWidthPx = 1080;
	private desiredHeightPx = 420;
	private desiredDpr = 2.0;

	private static readonly MIN_FRAME_INTERVAL_MS = 28; // ~35 fps cap prevents PTY queue backlog

	private logTelemetry(entry: Record<string, unknown>): void {
		if (process.env.INLINE_CHART_TELEMETRY !== "1") return;
		try {
			appendFileSync("/tmp/inline-chart-telemetry.jsonl", JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
		} catch {
			// Ignore telemetry write errors
		}
	}

	constructor(init: InlineChartInitialState) {
		this.spec = init.spec;
		this.frame = init.initialFrame ?? null;
		this.getTheme = init.getTheme ?? (() => undefined);
		this.onInvalidate = init.onInvalidate;

		for (const c of init.spec.controls ?? []) {
			this.controlValues[c.id] = c.value;
		}
		for (const s of init.spec.series) {
			if (s.visible === false) {
				this.hiddenSeries.add(s.id);
			}
		}
		if (getCapabilities().images === "kitty") {
			this.imageId = allocateImageId();
		}
		const snap = extractThemeSnapshot(this.getTheme());
		this.lastThemeFingerprint = snap.fingerprint;
		if (this.frame) {
			this.lastTargetW = this.frame.width_px;
			this.lastTargetH = this.frame.height_px;
		} else {
			this.scheduleRender(this.desiredWidthPx, this.desiredHeightPx);
		}
	}

	invalidate(): void {
		// Re-check theme on host theme/appearance changes (e.g. macOS light/dark switch)
		const snap = extractThemeSnapshot(this.getTheme());
		if (snap.fingerprint !== this.lastThemeFingerprint) {
			this.lastThemeFingerprint = snap.fingerprint;
			if (this.lastTargetW > 0 && this.lastTargetH > 0) {
				this.scheduleRender(this.lastTargetW, this.lastTargetH);
			}
		}
	}

	private scheduleRender(widthPx: number, heightPx: number, dpr?: number, reason = "update"): void {
		this.desiredWidthPx = widthPx;
		this.desiredHeightPx = heightPx;
		if (dpr !== undefined) this.desiredDpr = dpr;
		this.pendingReason = reason;
		if (this.inflight) {
			this.pendingRerender = true;
			this.coalescedCount += 1;
			return;
		}
		const elapsed = performance.now() - this.lastFrameSentAt;
		const isHighFreq = reason === "hover" || reason === "slider";
		if (isHighFreq && elapsed < InlineChartComponent.MIN_FRAME_INTERVAL_MS) {
			this.pendingRerender = true;
			this.coalescedCount += 1;
			if (!this.paceTimer) {
				const wait = Math.max(1, Math.ceil(InlineChartComponent.MIN_FRAME_INTERVAL_MS - elapsed));
				this.paceTimer = setTimeout(() => {
					this.paceTimer = null;
					if (!this.inflight && this.pendingRerender) {
						this.runRenderLoop();
					}
				}, wait);
			}
			return;
		}
		if (this.paceTimer) {
			clearTimeout(this.paceTimer);
			this.paceTimer = null;
		}
		this.runRenderLoop();
	}

	private async runRenderLoop(): Promise<void> {
		this.inflight = true;
		try {
			this.pendingRerender = false;
			const reason = this.pendingReason;
			const coalesced = this.coalescedCount;
			const mouseEv = this.mouseEventCount;
			this.coalescedCount = 0;
			this.mouseEventCount = 0;
			const snap = extractThemeSnapshot(this.getTheme());
			this.lastThemeFingerprint = snap.fingerprint;
			this.lastTargetW = this.desiredWidthPx;
			this.lastTargetH = this.desiredHeightPx;
			const t0 = performance.now();
			const resp = await engineClient.render({
				width_px: this.desiredWidthPx,
				height_px: this.desiredHeightPx,
				dpr: this.desiredDpr,
				native_axes: true,
				spec: this.spec,
				control_values: { ...this.controlValues },
				hidden_series: [...this.hiddenSeries],
				hover_x: this.hoverX,
				hover_norm_x: this.hoverNormX,
				hover_norm_y: this.hoverNormY,
				view_x_domain: null,
				theme: snap.mode,
				palette: snap.palette,
			});
			const ipcMs = performance.now() - t0;
			this.lastFrameSentAt = performance.now();
			if (resp.ok && resp.png_base64) {
				this.frame = resp;
				const tInv = performance.now();
				this.onInvalidate();
				const invMs = performance.now() - tInv;
				this.logTelemetry({
					chart: this.spec.title,
					style: this.spec.series[0]?.style || "solid",
					reason,
					w: resp.width_px,
					h: resp.height_px,
					draw_ms: Number((resp.draw_ms ?? 0).toFixed(2)),
					encode_ms: Number((resp.encode_ms ?? 0).toFixed(2)),
					rust_ms: Number(resp.render_ms.toFixed(2)),
					ipc_ms: Number(ipcMs.toFixed(2)),
					invalidate_ms: Number(invMs.toFixed(2)),
					png_kb: Math.round((resp.png_base64.length * 0.75) / 1024),
					b64_kb: Math.round(resp.png_base64.length / 1024),
					coalesced,
					mouse_ev: mouseEv,
				});
			}
		} catch {
			// Keep previous valid frame on transient error
		} finally {
			this.inflight = false;
			// If more events arrived while inflight, schedule next paced frame instead of tight-looping
			if (this.pendingRerender && !this.paceTimer) {
				const wait = Math.max(
					1,
					Math.ceil(InlineChartComponent.MIN_FRAME_INTERVAL_MS - (performance.now() - this.lastFrameSentAt)),
				);
				this.paceTimer = setTimeout(() => {
					this.paceTimer = null;
					if (!this.inflight && this.pendingRerender) {
						this.runRenderLoop();
					}
				}, wait);
			}
		}
	}

	private styleFg(token: string, text: string, fallbackAnsi: string): string {
		const t = this.getTheme();
		if (t?.fg) {
			try {
				return t.fg(token, text);
			} catch {
				// fallback below
			}
		}
		return `${fallbackAnsi}${text}\x1b[0m`;
	}

	private styleButton(text: string, active: boolean): string {
		const t = this.getTheme();
		if (t?.fg && t?.bg) {
			try {
				return active ? t.bg("selectedBg", t.fg("text", text)) : t.fg("muted", text);
			} catch {
				// fallback below
			}
		}
		const isLight = t?.appearance === "light";
		if (active) {
			return isLight
				? `\x1b[48;2;226;232;240m\x1b[38;2;28;36;51m${text}\x1b[0m`
				: `\x1b[48;2;42;49;64m\x1b[38;2;232;237;247m${text}\x1b[0m`;
		}
		return isLight
			? `\x1b[38;2;100;116;139m${text}\x1b[0m`
			: `\x1b[38;2;138;148;170m${text}\x1b[0m`;
	}

	render(width: number): readonly string[] {
		const safeWidth = Math.max(28, width);
		const caps = getCapabilities();
		const cell = getCellDimensions();
		const isLight = this.getTheme()?.appearance === "light";
		const borderFb = isLight ? "\x1b[38;2;180;190;204m" : "\x1b[38;2;72;82;102m";
		const mutedFb = isLight ? "\x1b[38;2;90;101;120m" : "\x1b[38;2;154;164;186m";

		const useNativeAxes = Boolean(this.frame?.native_axes_used && this.frame?.y_ticks && this.frame?.x_ticks);
		const yTicks = this.frame?.y_ticks ?? [];
		const maxYLblW = useNativeAxes
			? Math.min(10, Math.max(4, ...yTicks.map((t) => visibleWidth(t.label))))
			: 0;
		// Left axis column format: " <right-aligned label> ┤" -> width = maxYLblW + 3
		const leftAxisCols = useNativeAxes ? maxYLblW + 3 : 0;
		this.plotStartCol = leftAxisCols;

		// Adapt to full available pane width minus native left Y-axis columns
		const maxCols = Math.max(20, safeWidth - leftAxisCols - 1);
		const paneWidthPx = maxCols * cell.widthPx;
		// Maintain comfortable chart height (12..22 rows)
		const idealHeightPx = paneWidthPx / (maxCols > 120 ? 2.9 : 2.4);
		const targetRows = Math.max(12, Math.min(22, Math.round(idealHeightPx / Math.max(1, cell.heightPx))));
		const paneHeightPx = targetRows * cell.heightPx;

		// Uniform DPR scale capped at 1600x760 for ultra-fast interactive hover/drag while staying Retina-crisp
		const dpr = Math.min(2.0, 1600 / Math.max(1, paneWidthPx), 760 / Math.max(1, paneHeightPx));
		const targetW = Math.max(480, Math.round(paneWidthPx * dpr));
		const targetH = Math.max(240, Math.round(paneHeightPx * dpr));

		const snap = extractThemeSnapshot(this.getTheme());
		const sizeChanged =
			Math.abs(targetW - this.lastTargetW) >= 24 || Math.abs(targetH - this.lastTargetH) >= 16;
		const themeChanged = snap.fingerprint !== this.lastThemeFingerprint;

		if (sizeChanged || themeChanged) {
			this.lastTargetW = targetW;
			this.lastTargetH = targetH;
			this.lastThemeFingerprint = snap.fingerprint;
			this.scheduleRender(targetW, targetH, dpr, sizeChanged ? "resize" : "theme");
		}
		this.lastImageCols = maxCols;

		const lines: string[] = [];

		// 0. Native terminal card header (crisp vector terminal typography: title + legend + live hover reading)
		lines.push(this.renderCardHeader(safeWidth));
		if (this.spec.subtitle && this.spec.subtitle.trim().length > 0) {
			lines.push(truncateToWidth(`  ${this.styleFg("muted", this.spec.subtitle, mutedFb)}`, safeWidth));
		}
		if (useNativeAxes && (this.spec.yLabel || this.spec.y2Label)) {
			const leftLbl = this.spec.yLabel ? ` ${this.styleFg("muted", this.spec.yLabel, mutedFb)}` : "";
			const rightLbl = this.spec.y2Label ? this.styleFg("muted", this.spec.y2Label, mutedFb) : "";
			if (rightLbl) {
				const gap = Math.max(1, safeWidth - visibleWidth(leftLbl) - visibleWidth(rightLbl) - 1);
				lines.push(truncateToWidth(`${leftLbl}${" ".repeat(gap)}${rightLbl}`, safeWidth));
			} else {
				lines.push(truncateToWidth(leftLbl, safeWidth));
			}
		}
		this.imageStartRow = lines.length;

		// 1. Transparent Kitty Graphics plot layer + native left Y-axis ticks
		if (caps.images && this.frame?.png_base64) {
			const res = renderImage(
				this.frame.png_base64,
				{ widthPx: this.frame.width_px, heightPx: this.frame.height_px },
				{
					maxWidthCells: maxCols,
					maxHeightCells: targetRows,
					imageId: this.imageId,
					moveCursor: false,
				},
			);
			if (res) {
				if (res.imageId) this.imageId = res.imageId;
				this.lastImageCols = res.columns;
				this.lastRenderedImageRows = res.rows;

				// Build native Y-axis prefix for each image row
				const yRowLabels = new Map<number, string>();
				if (useNativeAxes) {
					for (const tick of yTicks) {
						const rIdx = Math.max(0, Math.min(res.rows - 1, Math.round(tick.pos * (res.rows - 1))));
						if (!yRowLabels.has(rIdx)) {
							yRowLabels.set(rIdx, tick.label);
						}
					}
				}
				const makeYPrefix = (rowIdx: number): string => {
					if (!useNativeAxes) return "";
					const lbl = yRowLabels.get(rowIdx);
					if (lbl !== undefined) {
						const pad = " ".repeat(Math.max(0, maxYLblW - visibleWidth(lbl)));
						return ` ${this.styleFg("muted", `${pad}${lbl}`, mutedFb)} ${this.styleFg("borderMuted", "┤", borderFb)}`;
					}
					return `${" ".repeat(maxYLblW + 2)}${this.styleFg("borderMuted", "│", borderFb)}`;
				};

				if (caps.images === "kitty") {
					// Place chart behind non-default cell backgrounds & text (Kitty spec: z < -2^30)
					// so Pi overlays like "Jump to latest message" always render cleanly on top of bars/lines.
					const seq = res.sequence.replace("\x1b_G", "\x1b_Gz=-1073741825,");
					lines.push(`${makeYPrefix(0)}${seq}`);
					for (let i = 1; i < res.rows; i++) {
						lines.push(makeYPrefix(i));
					}
				} else {
					for (let i = 0; i < res.rows - 1; i++) {
						lines.push(makeYPrefix(i));
					}
					const up = res.rows > 1 ? `\x1b[${res.rows - 1}A` : "";
					lines.push(`${makeYPrefix(res.rows - 1)}${up}${res.sequence}`);
				}
			} else {
				this.lastRenderedImageRows = 1;
				lines.push(truncateToWidth(this.styleFg("muted", `[chart: ${this.spec.title}]`, "\x1b[2m"), safeWidth));
			}
		} else {
			this.lastRenderedImageRows = 1;
			lines.push(truncateToWidth(this.styleFg("muted", `[chart: ${this.spec.title}]`, "\x1b[2m"), safeWidth));
		}

		// 1b. Native terminal X-axis line, ticks, and X-axis label
		if (useNativeAxes) {
			lines.push(...this.renderNativeXAxis(safeWidth, leftAxisCols, this.lastImageCols));
		}

		// 2. Native TUI interactive control bar integrated into the card footer
		this.hitRegions = [];
		const controlLines = this.renderControlsLines(safeWidth, lines.length);
		lines.push(...controlLines);

		return lines;
	}

	private renderNativeXAxis(width: number, leftAxisCols: number, plotCols: number): string[] {
		const isLight = this.getTheme()?.appearance === "light";
		const borderFb = isLight ? "\x1b[38;2;180;190;204m" : "\x1b[38;2;72;82;102m";
		const mutedFb = isLight ? "\x1b[38;2;90;101;120m" : "\x1b[38;2;154;164;186m";
		const xTicks = this.frame?.x_ticks ?? [];
		const cols = Math.max(4, plotCols);

		// Build axis rule: "       └────┬────┬────┘"
		const ruleChars = Array.from({ length: cols }, () => "─");
		const tickCols: Array<{ col: number; label: string }> = [];
		for (const t of xTicks) {
			const c = Math.max(0, Math.min(cols - 1, Math.round(t.pos * (cols - 1))));
			ruleChars[c] = "┬";
			tickCols.push({ col: c, label: t.label });
		}
		const axisPrefix = " ".repeat(Math.max(0, leftAxisCols - 1));
		const axisLine = `${axisPrefix}${this.styleFg("borderMuted", `└${ruleChars.join("")}`, borderFb)}`;

		// Build X tick labels line without overlapping
		const buf = Array.from({ length: leftAxisCols + cols + 4 }, () => " ");
		let lastEnd = -1;
		for (const { col, label } of tickCols) {
			const lw = visibleWidth(label);
			let start = leftAxisCols + col - Math.floor(lw / 2);
			start = Math.max(leftAxisCols, Math.min(leftAxisCols + cols - lw, start));
			if (start <= lastEnd + 1) continue;
			let pos = start;
			for (const ch of label) {
				if (pos < buf.length) buf[pos] = ch;
				pos += Math.max(1, visibleWidth(ch));
			}
			lastEnd = start + lw;
		}
		const tickLine = this.styleFg("muted", buf.join("").trimEnd(), mutedFb);

		const out = [truncateToWidth(axisLine, width), truncateToWidth(tickLine, width)];
		if (this.spec.xLabel && this.spec.xLabel.trim().length > 0) {
			const lw = visibleWidth(this.spec.xLabel);
			const pad = Math.max(leftAxisCols, leftAxisCols + Math.floor((cols - lw) / 2));
			out.push(truncateToWidth(`${" ".repeat(pad)}${this.styleFg("muted", this.spec.xLabel, mutedFb)}`, width));
		}
		return out;
	}

	private renderCardHeader(width: number): string {
		const isLight = this.getTheme()?.appearance === "light";
		const borderFb = isLight ? "\x1b[38;2;180;190;204m" : "\x1b[38;2;72;82;102m";
		const mutedFb = isLight ? "\x1b[38;2;90;101;120m" : "\x1b[38;2;154;164;186m";
		const textFb = isLight ? "\x1b[38;2;28;36;51m" : "\x1b[38;2;232;237;247m";
		const accentFb = isLight ? "\x1b[38;2;15;118;110m" : "\x1b[38;2;139;213;202m";

		const titleStyled = `\x1b[1m${this.styleFg("text", this.spec.title, textFb)}\x1b[22m`;

		// Inline color dots legend (only when multiple series and room allows)
		let legendStyled = "";
		if (this.spec.series.length > 1 && width >= 64) {
			const parts = this.spec.series.slice(0, 4).map((s, idx) => {
				const hex = s.color || ["#0f766e", "#4F8CFF", "#c6a0f6", "#38a169"][idx % 4];
				const m = hex.replace("#", "");
				const r = parseInt(m.slice(0, 2), 16) || 15;
				const g = parseInt(m.slice(2, 4), 16) || 118;
				const b = parseInt(m.slice(4, 6), 16) || 110;
				const hidden = this.hiddenSeries.has(s.id);
				const dot = hidden ? "○" : "●";
				return `\x1b[38;2;${r};${g};${b}m${dot}\x1b[0m ${this.styleFg("muted", s.label, mutedFb)}`;
			});
			legendStyled = `  ${parts.join("  ")}`;
		}

		// Right-aligned live hover reading or subtle hint
		let rightStyled: string;
		const readings = this.frame?.hover_readings;
		if (readings && readings.length > 0) {
			const summary = readings
				.slice(0, 2)
				.map((r) => r.text || `${r.label}: ${r.x.toFixed(2)}, ${r.y.toFixed(3)}`)
				.join(" · ");
			rightStyled = `${this.styleFg("accent", "◉", accentFb)} ${this.styleFg("text", summary, textFb)}`;
		} else if (this.frame) {
			rightStyled = this.styleFg("muted", `${this.frame.render_ms.toFixed(1)}ms`, mutedFb);
		} else {
			rightStyled = this.styleFg("muted", "渲染中…", mutedFb);
		}

		const leftPart = `${this.styleFg("borderMuted", "╭─", borderFb)} ${titleStyled}${legendStyled} `;
		const rightPart = ` ${rightStyled} ${this.styleFg("borderMuted", "─╮", borderFb)}`;
		const leftW = visibleWidth(leftPart);
		const rightW = visibleWidth(rightPart);
		const fillLen = Math.max(1, width - leftW - rightW);
		const fill = this.styleFg("borderMuted", "─".repeat(fillLen), borderFb);
		return truncateToWidth(`${leftPart}${fill}${rightPart}`, width);
	}

	private renderControlsLines(width: number, startRowIdx: number): string[] {
		const isLight = this.getTheme()?.appearance === "light";
		const borderFb = isLight ? "\x1b[38;2;180;190;204m" : "\x1b[38;2;72;82;102m";
		const mutedFallback = isLight ? "\x1b[38;2;90;101;120m" : "\x1b[38;2;154;164;186m";
		const accentFallback = isLight ? "\x1b[38;2;15;118;110m" : "\x1b[38;2;139;213;202m";
		const textFallback = isLight ? "\x1b[38;2;28;36;51m" : "\x1b[38;2;232;237;247m";

		const trackLen = width < 60 ? 8 : width < 90 ? 12 : 16;
		const rows: string[] = [];
		let curRow = startRowIdx;
		const prefixLead = `${this.styleFg("borderMuted", "╰─", borderFb)} `;
		let col = visibleWidth(prefixLead);
		let out = prefixLead;

		const flushRow = () => {
			rows.push(truncateToWidth(out, width));
			curRow += 1;
			col = 3;
			out = "   ";
		};

		// Toggleable series buttons (grouped by label)
		const toggleGroups: Array<{ label: string; ids: string[] }> = [];
		const seen = new Map<string, string[]>();
		for (const s of this.spec.series) {
			if (!s.toggleable) continue;
			let arr = seen.get(s.label);
			if (!arr) {
				arr = [];
				seen.set(s.label, arr);
				toggleGroups.push({ label: s.label, ids: arr });
			}
			arr.push(s.id);
		}

		for (const grp of toggleGroups) {
			const on = grp.ids.every((id) => !this.hiddenSeries.has(id));
			const txt = on ? ` [✓ ${grp.label}] ` : ` [  ${grp.label}] `;
			const w = visibleWidth(txt);
			if (col > 1 && col + w > width - 1) flushRow();
			this.hitRegions.push({
				kind: "toggle",
				id: grp.ids.join(","),
				row: curRow,
				startCol: col,
				endCol: col + w - 1,
			});
			out += `${this.styleButton(txt, on)} `;
			col += w + 1;
		}

		// Interactive parameter sliders
		for (const ctrl of this.spec.controls ?? []) {
			const val = this.controlValues[ctrl.id] ?? ctrl.value;
			const ratio = Math.max(0, Math.min(1, (val - ctrl.min) / Math.max(1e-9, ctrl.max - ctrl.min)));
			const knob = Math.round(ratio * (trackLen - 1));
			const track = "━".repeat(knob) + "●" + "─".repeat(Math.max(0, trackLen - 1 - knob));
			const valStr = `${val.toFixed(1)}${ctrl.unit ?? ""}`;

			const prefix = `${ctrl.label} `;
			const prefixW = visibleWidth(prefix);
			const suffix = ` ${valStr}`;
			const totalW = prefixW + trackLen + visibleWidth(suffix);
			if (col > 1 && col + totalW > width - 1) flushRow();

			const trackStart = col + prefixW;
			const trackEnd = trackStart + trackLen - 1;

			this.hitRegions.push({
				kind: "slider",
				id: ctrl.id,
				row: curRow,
				startCol: col,
				endCol: col + totalW - 1,
				trackStartCol: trackStart,
				trackEndCol: trackEnd,
				control: ctrl,
			});

			out +=
				this.styleFg("muted", prefix, mutedFallback) +
				this.styleFg("accent", track, accentFallback) +
				this.styleFg("text", suffix, textFallback) +
				"  ";
			col += totalW + 2;
		}

		if (this.hitRegions.length === 0) {
			const hint = "悬停查看数值";
			out += this.styleFg("muted", hint, mutedFallback);
			col += visibleWidth(hint);
		}
		const tailW = 3;
		const fillN = Math.max(0, width - col - tailW);
		if (fillN > 0) {
			out += ` ${this.styleFg("borderMuted", "─".repeat(Math.max(0, fillN - 1)) + "╯", borderFb)}`;
		}
		rows.push(truncateToWidth(out, width));
		return rows;
	}

	private renderStatusLine(width: number): string {
		const isLight = this.getTheme()?.appearance === "light";
		const mutedFallback = isLight ? "\x1b[38;2;90;101;120m" : "\x1b[38;2;154;164;186m";
		const accentFallback = isLight ? "\x1b[38;2;15;118;110m" : "\x1b[38;2;139;213;202m";
		const textFallback = isLight ? "\x1b[38;2;28;36;51m" : "\x1b[38;2;232;237;247m";

		if (!this.frame) {
			return truncateToWidth(` ${this.styleFg("muted", `正在渲染 "${this.spec.title}"…`, mutedFallback)}`, width);
		}
		const readings = this.frame.hover_readings;
		let text: string;
		if (readings && readings.length > 0) {
			const summary = readings
				.slice(0, 3)
				.map((r) => r.text || `${r.label}: x=${r.x.toFixed(2)} y=${r.y.toFixed(3)}`)
				.join("  ·  ");
			text = ` ${this.styleFg("accent", "◉", accentFallback)} ${this.styleFg("text", summary, textFallback)}  ${this.styleFg("muted", `(${this.frame.render_ms.toFixed(1)}ms)`, mutedFallback)}`;
		} else {
			text = ` ${this.styleFg("muted", `Rust tiny-skia · ${this.frame.render_ms.toFixed(1)}ms · 悬停图面看数值 · 滚轮缩放`, mutedFallback)}`;
		}
		return truncateToWidth(text, width);
	}

	private columnToDataX(col: number): number | null {
		if (!this.frame) return null;
		const pb: PlotBoxFrac = this.frame.plot_box;
		const totalCols = Math.max(1, this.lastImageCols);
		const relCol = col - this.plotStartCol;
		if (relCol < -1 || relCol > totalCols + 1) return null;
		const frac = (relCol + 0.5) / totalCols;
		if (frac < pb.left - 0.02 || frac > pb.right + 0.02) {
			return null;
		}
		const clamped = Math.max(0, Math.min(1, (frac - pb.left) / Math.max(1e-6, pb.right - pb.left)));
		const [xMin, xMax] = this.frame.x_domain;
		return xMin + clamped * (xMax - xMin);
	}

	private updateSliderFromCol(region: HitRegion, col: number): boolean {
		const ctrl = region.control;
		if (!this.frame || !ctrl || region.trackStartCol === undefined || region.trackEndCol === undefined) return false;
		const span = Math.max(1, region.trackEndCol - region.trackStartCol);
		const ratio = Math.max(0, Math.min(1, (col - region.trackStartCol) / span));
		const raw = ctrl.min + ratio * (ctrl.max - ctrl.min);
		const step = ctrl.step > 0 ? ctrl.step : 0.1;
		const snapped = Math.round(raw / step) * step;
		const clamped = Math.max(ctrl.min, Math.min(ctrl.max, Number(snapped.toFixed(6))));
		if (this.controlValues[ctrl.id] === clamped) return false;
		this.controlValues[ctrl.id] = clamped;
		this.scheduleRender(this.lastTargetW || this.frame.width_px, this.lastTargetH || this.frame.height_px, undefined, "slider");
		return true;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.frame) return undefined;
		this.mouseEventCount += 1;

		// Active slider drag capture
		if (this.activeSliderId) {
			const region = this.hitRegions.find((r) => r.kind === "slider" && r.id === this.activeSliderId);
			if (event.type === "release") {
				this.activeSliderId = null;
				return { handled: true, render: true };
			}
			if (region && (event.type === "drag" || event.type === "move")) {
				const changed = this.updateSliderFromCol(region, event.x);
				return { handled: true, capture: true, render: changed };
			}
		}

		// Control bar interactions
		for (const region of this.hitRegions) {
			if (event.y === region.row && event.x >= region.startCol && event.x <= region.endCol) {
				if (region.kind === "toggle") {
					if (event.type === "press") {
						const ids = region.id.split(",");
						const allVisible = ids.every((id) => !this.hiddenSeries.has(id));
						for (const id of ids) {
							if (allVisible) this.hiddenSeries.add(id);
							else this.hiddenSeries.delete(id);
						}
						this.scheduleRender(this.lastTargetW || this.frame.width_px, this.lastTargetH || this.frame.height_px);
						return { handled: true, focus: true, render: true };
					}
					if (event.type === "click" || event.type === "release") {
						return { handled: true, render: false };
					}
				}
				if (region.kind === "slider" && event.type === "press") {
					this.activeSliderId = region.id;
					this.updateSliderFromCol(region, event.x);
					return { handled: true, capture: true, focus: true, render: true };
				}
			}
		}

		// Plot area hover only (wheel and clicks pass straight through to Pi so scrolling/selection is never interrupted)
		if (event.y >= this.imageStartRow && event.y < this.imageStartRow + this.lastRenderedImageRows) {
			const relY = event.y - this.imageStartRow;
			const relX = event.x - this.plotStartCol;
			if (relX >= 0 && relX < this.lastImageCols && event.type === "move") {
				const is2DHover = !this.frame.native_axes_used;
				if (!is2DHover) {
					// Cartesian chart: only redraw when mouse moves to a different X column (ignore vertical jitter!)
					if (this.lastHoverCol === relX) {
						return { handled: true, render: false };
					}
					this.lastHoverCol = relX;
					this.hoverX = this.columnToDataX(event.x);
					this.scheduleRender(this.lastTargetW || this.frame.width_px, this.lastTargetH || this.frame.height_px, undefined, "hover");
					return { handled: true, render: false };
				}
				const normX = Math.max(0, Math.min(1, (relX + 0.5) / Math.max(1, this.lastImageCols)));
				const normY = Math.max(0, Math.min(1, (relY + 0.5) / Math.max(1, this.lastRenderedImageRows)));
				const normChanged =
					this.hoverNormX === null ||
					this.hoverNormY === null ||
					Math.abs(this.hoverNormX - normX) > 0.015 ||
					Math.abs(this.hoverNormY - normY) > 0.025;
				if (normChanged) {
					this.hoverNormX = normX;
					this.hoverNormY = normY;
					this.hoverX = this.columnToDataX(event.x);
					this.scheduleRender(this.lastTargetW || this.frame.width_px, this.lastTargetH || this.frame.height_px, undefined, "hover");
					return { handled: true, render: false };
				}
			}
		}

		return undefined;
	}

	handleInput(data: string): void {
		if (!this.frame) return;
		const [xMin, xMax] = this.frame.x_domain;
		const stepX = (xMax - xMin) / 40;
		if (data === "\x1b[D") {
			this.hoverX = Math.max(xMin, (this.hoverX ?? (xMin + xMax) / 2) - stepX);
			this.scheduleRender(this.lastTargetW || this.frame.width_px, this.lastTargetH || this.frame.height_px, undefined, "hover");
		} else if (data === "\x1b[C") {
			this.hoverX = Math.min(xMax, (this.hoverX ?? (xMin + xMax) / 2) + stepX);
			this.scheduleRender(this.lastTargetW || this.frame.width_px, this.lastTargetH || this.frame.height_px, undefined, "hover");
		} else if (data === "\x1b") {
			this.hoverX = null;
			this.lastHoverCol = null;
			this.scheduleRender(this.lastTargetW || this.frame.width_px, this.lastTargetH || this.frame.height_px, undefined, "hover");
		}
	}
}
