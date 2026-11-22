/**
 * inline-chart: Inline interactive chart extension for Pi inside Rex (and Kitty-graphics terminals).
 * Works seamlessly in BOTH codemode and direct mode via CustomEntry + registerEntryRenderer.
 * Automatically adapts to terminal window width (HiDPI responsive resize) and host Pi/Rex theme colors.
 */
import type { ExtensionAPI, ToolDefinition, ToolNamespace } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { engineClient, type ChartSpec, type RenderResponse } from "./client.ts";
import { extractThemeSnapshot, InlineChartComponent, type HostThemeLike } from "./component.ts";

const ENTRY_TYPE = "inline-chart";

export const inlineChartInstructions = `Render an interactive native chart INLINE inside Pi's conversation stream (backed by a fast Rust tiny-skia engine).
Do NOT call image() after tools.inline_chart — the interactive chart widget is automatically inserted inline into the conversation and adapts to window width and terminal light/dark theme.

Supported chart styles (can be combined on cartesian axes):
- "solid" / "dashed": line & dashed curves (points or math formula)
- "area": filled area under curve
- "step": step-function line
- "band": confidence / error band (points with yLow/yHigh, or formulaLow + formulaHigh)
- "scatter": scatter / bubble plot (points with optional radius r)
- "errorbar": line + markers + symmetric yerr or asymmetric yLow/yHigh error bars with caps
- "bar": vertical grouped or stacked (stacked: true) bar chart; supports categories: ["Q1","Q2",...] with either points or shorthand values: [24,36,...]
- "barh": horizontal bar chart (points with label, or categories + values[])
- "hist": histogram from raw 1D values[] + bins (even controllable via a slider id: "bins")
- "boxplot": box-and-whisker plot from groups: [{ label, values? | min,q1,median,q3,max }]
- "heatmap": 2D matrix[][] with xLabels[], yLabels[], Viridis colorbar & cell hover
- "pie" / "donut": slices: [{ label, value, color? }] with hover highlight

Extra features:
- Multi-subplot grid: set grid: { rows, cols } + subplots: [{ title?, xLabel?, yLabel?, xDomain?, yDomain?, annotations?, series: [...] }]
- Dual Y-axis: set yAxis: "right" on a series + y2Label / y2Domain
- Time axis: set xType: "date" with Unix timestamps (sec or ms)
- Annotations: annotations: [
    { kind: "hline"|"vline", value, label?, color?, yAxis? },
    { kind: "vspan"|"hspan", from, to, label?, color?, opacity?, yAxis? },
    { kind: "arrow", x, y, textX?, textY?, label, color?, yAxis? }
  ]
- Interactive controls: controls: [{ id, label, min, max, step, value, unit? }] bound to formula variables or "bins"
- Math functions in formula: sin, cos, tan, asin, acos, atan, exp, ln, log, log10, log2, sqrt, abs, pow, min, max, clamp, floor, ceil, round, sign; constants: pi, e, tau; operators: +, -, *, /, ^, **`;

const inlineChartNamespace: ToolNamespace = {
	name: "inline_chart",
	instructions: inlineChartInstructions,
};

const annotationSchema = Type.Object({
	kind: Type.Union([
		Type.Literal("hline"),
		Type.Literal("vline"),
		Type.Literal("vspan"),
		Type.Literal("hspan"),
		Type.Literal("arrow"),
	]),
	value: Type.Optional(Type.Number()),
	from: Type.Optional(Type.Number()),
	to: Type.Optional(Type.Number()),
	x: Type.Optional(Type.Number()),
	y: Type.Optional(Type.Number()),
	textX: Type.Optional(Type.Number()),
	textY: Type.Optional(Type.Number()),
	opacity: Type.Optional(Type.Number()),
	label: Type.Optional(Type.String()),
	color: Type.Optional(Type.String()),
	yAxis: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right")])),
});

const seriesSchema = Type.Object({
	id: Type.String(),
	label: Type.String(),
	color: Type.Optional(Type.String()),
	style: Type.Optional(
		Type.Union([
			Type.Literal("solid"),
			Type.Literal("dashed"),
			Type.Literal("area"),
			Type.Literal("step"),
			Type.Literal("scatter"),
			Type.Literal("errorbar"),
			Type.Literal("bar"),
			Type.Literal("barh"),
			Type.Literal("band"),
			Type.Literal("hist"),
			Type.Literal("boxplot"),
			Type.Literal("heatmap"),
			Type.Literal("pie"),
			Type.Literal("donut"),
		]),
	),
	lineWidth: Type.Optional(Type.Number()),
	opacity: Type.Optional(Type.Number()),
	toggleable: Type.Optional(Type.Boolean()),
	visible: Type.Optional(Type.Boolean()),
	yAxis: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right")])),
	stacked: Type.Optional(Type.Boolean()),
	formula: Type.Optional(Type.String()),
	formulaLow: Type.Optional(Type.String()),
	formulaHigh: Type.Optional(Type.String()),
	values: Type.Optional(Type.Array(Type.Number())),
	bins: Type.Optional(Type.Integer()),
	groups: Type.Optional(
		Type.Array(
			Type.Object({
				label: Type.String(),
				values: Type.Optional(Type.Array(Type.Number())),
				min: Type.Optional(Type.Number()),
				q1: Type.Optional(Type.Number()),
				median: Type.Optional(Type.Number()),
				q3: Type.Optional(Type.Number()),
				max: Type.Optional(Type.Number()),
				color: Type.Optional(Type.String()),
			}),
		),
	),
	matrix: Type.Optional(Type.Array(Type.Array(Type.Number()))),
	xLabels: Type.Optional(Type.Array(Type.String())),
	yLabels: Type.Optional(Type.Array(Type.String())),
	slices: Type.Optional(
		Type.Array(
			Type.Object({
				label: Type.String(),
				value: Type.Number(),
				color: Type.Optional(Type.String()),
			}),
		),
	),
	points: Type.Optional(
		Type.Array(
			Type.Object({
				x: Type.Number(),
				y: Type.Number(),
				yerr: Type.Optional(Type.Number()),
				yLow: Type.Optional(Type.Number()),
				yHigh: Type.Optional(Type.Number()),
				r: Type.Optional(Type.Number()),
				label: Type.Optional(Type.String()),
			}),
		),
	),
});

const inlineChartParameters = Type.Object({
	id: Type.Optional(Type.String()),
	kicker: Type.Optional(Type.String()),
	title: Type.String(),
	subtitle: Type.Optional(Type.String()),
	xLabel: Type.Optional(Type.String()),
	yLabel: Type.Optional(Type.String()),
	y2Label: Type.Optional(Type.String()),
	xType: Type.Optional(Type.Union([Type.Literal("number"), Type.Literal("date"), Type.Literal("category")])),
	categories: Type.Optional(Type.Array(Type.String())),
	xDomain: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })),
	yDomain: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })),
	y2Domain: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })),
	samples: Type.Optional(Type.Integer()),
	params: Type.Optional(Type.Record(Type.String(), Type.Number())),
	showLegend: Type.Optional(Type.Boolean()),
	annotations: Type.Optional(Type.Array(annotationSchema)),
	grid: Type.Optional(Type.Object({ rows: Type.Integer(), cols: Type.Integer() })),
	subplots: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.Optional(Type.String()),
				xLabel: Type.Optional(Type.String()),
				yLabel: Type.Optional(Type.String()),
				xType: Type.Optional(Type.Union([Type.Literal("number"), Type.Literal("date"), Type.Literal("category")])),
				categories: Type.Optional(Type.Array(Type.String())),
				xDomain: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })),
				yDomain: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })),
				annotations: Type.Optional(Type.Array(annotationSchema)),
				series: Type.Array(seriesSchema),
			}),
		),
	),
	series: Type.Optional(Type.Array(seriesSchema)),
	controls: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String(),
				label: Type.String(),
				min: Type.Number(),
				max: Type.Number(),
				step: Type.Number(),
				value: Type.Number(),
				unit: Type.Optional(Type.String()),
			}),
		),
	),
});

interface ChartEntryData {
	chartId: string;
	spec: ChartSpec;
}

const initialFrames = new Map<string, RenderResponse>();
const liveComponents = new Map<string, InlineChartComponent>();
let activeTui: TUI | null = null;
let activeTheme: HostThemeLike | undefined;

function captureHostRefs(ctx: { ui?: { setWidget?: Function } }): void {
	if (activeTui || !ctx.ui?.setWidget) return;
	try {
		ctx.ui.setWidget(
			"inline-chart-tui-hook",
			(tui: TUI, theme: HostThemeLike): Component => {
				activeTui = tui;
				activeTheme = theme;
				return {
					render: () => [],
					invalidate: () => {
						// Propagate terminal theme / appearance changes to all live inline charts
						for (const comp of liveComponents.values()) {
							comp.invalidate();
						}
					},
				};
			},
			{ placement: "belowEditor" },
		);
	} catch {
		// Non-interactive mode
	}
}

function requestHostRender(): void {
	activeTui?.requestRender();
}

function createInlineChartTool(pi: ExtensionAPI): ToolDefinition<TSchema, { chartId: string }> {
	return {
		name: "inline_chart",
		label: "Inline Chart",
		description:
			"Render an interactive chart inline inside the conversation stream (auto-adapts to pane width and light/dark theme; hover crosshair, clickable series toggles, draggable sliders).",
		parameters: inlineChartParameters as unknown as TSchema,
		exposure: "codemode",
		namespace: inlineChartNamespace,
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			captureHostRefs(ctx);
			const spec = params as unknown as ChartSpec;
			const chartId = spec.id || `chart-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			const controlValues: Record<string, number> = {};
			for (const c of spec.controls ?? []) {
				controlValues[c.id] = c.value;
			}
			const hiddenSeries = (spec.series ?? []).filter((s) => s.visible === false).map((s) => s.id);
			const snap = extractThemeSnapshot(activeTheme);

			try {
				const initialFrame = await engineClient.render({
					width_px: 1600,
					height_px: 640,
					dpr: 2.0,
					native_axes: true,
					spec,
					control_values: controlValues,
					hidden_series: hiddenSeries,
					hover_x: null,
					view_x_domain: null,
					theme: snap.mode,
					palette: snap.palette,
				});
				if (!initialFrame.ok) {
					throw new Error(initialFrame.error || "Rust engine render failed");
				}

				initialFrames.set(chartId, initialFrame);
				pi.appendEntry<ChartEntryData>(ENTRY_TYPE, { chartId, spec });
				requestHostRender();

				return {
					content: [
						{
							type: "text" as const,
							text: `Interactive chart "${spec.title}" rendered inline (${initialFrame.render_ms.toFixed(1)}ms, theme=${snap.mode}).`,
						},
					],
					details: { chartId },
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `inline_chart failed: ${msg}` }],
					details: { chartId },
					isError: true,
				};
			}
		},
	};
}

export default function piInlineChartExtension(pi: ExtensionAPI): void {
	const isRex = Boolean(process.env.REX_SESSION || process.env.TERM_PROGRAM?.toLowerCase() === "rex");
	const forceEnable = process.env.PI_INLINE_CHART_ALWAYS === "1";
	if (!isRex && !forceEnable) {
		return;
	}

	pi.on("session_start", (_event, ctx) => {
		captureHostRefs(ctx);
	});

	pi.on("session_shutdown", () => {
		engineClient.dispose();
	});

	pi.registerEntryRenderer<ChartEntryData>(ENTRY_TYPE, (entry, _options, theme) => {
		activeTheme = theme as unknown as HostThemeLike;
		const data = entry.data;
		if (!data?.spec) {
			return new Text("[inline-chart: missing chart spec]");
		}
		const key = entry.id || data.chartId;
		const existing = liveComponents.get(key);
		if (existing) {
			existing.invalidate();
			return existing;
		}

		const cachedFrame = initialFrames.get(data.chartId);
		const comp = new InlineChartComponent({
			spec: data.spec,
			initialFrame: cachedFrame,
			getTheme: () => activeTheme,
			onInvalidate: requestHostRender,
		});
		liveComponents.set(key, comp);
		return comp;
	});

	pi.registerTool(createInlineChartTool(pi));
}
