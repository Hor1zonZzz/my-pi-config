import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export interface ChartPoint {
	x: number;
	y: number;
	yerr?: number;
	yLow?: number;
	yHigh?: number;
	r?: number;
	label?: string;
}

export interface BoxGroup {
	label: string;
	values?: number[];
	min?: number;
	q1?: number;
	median?: number;
	q3?: number;
	max?: number;
	color?: string;
}

export interface PieSlice {
	label: string;
	value: number;
	color?: string;
}

export interface ChartAnnotation {
	kind: "hline" | "vline" | "vspan" | "hspan" | "arrow";
	value?: number;
	from?: number;
	to?: number;
	x?: number;
	y?: number;
	textX?: number;
	textY?: number;
	opacity?: number;
	label?: string;
	color?: string;
	yAxis?: "left" | "right";
}

export interface GridSpec {
	rows: number;
	cols: number;
}

export interface SubplotSpec {
	title?: string;
	xLabel?: string;
	yLabel?: string;
	xType?: "number" | "date" | "category";
	categories?: string[];
	xDomain?: [number, number];
	yDomain?: [number, number];
	annotations?: ChartAnnotation[];
	series: ChartSeries[];
}

export interface ChartSeries {
	id: string;
	label: string;
	color?: string;
	style?:
		| "solid"
		| "dashed"
		| "area"
		| "step"
		| "scatter"
		| "errorbar"
		| "bar"
		| "barh"
		| "band"
		| "hist"
		| "boxplot"
		| "heatmap"
		| "pie"
		| "donut";
	lineWidth?: number;
	opacity?: number;
	toggleable?: boolean;
	visible?: boolean;
	yAxis?: "left" | "right";
	stacked?: boolean;
	points?: ChartPoint[];
	formula?: string;
	formulaLow?: string;
	formulaHigh?: string;
	values?: number[];
	bins?: number;
	groups?: BoxGroup[];
	matrix?: number[][];
	xLabels?: string[];
	yLabels?: string[];
	slices?: PieSlice[];
}

export interface ChartControl {
	id: string;
	label: string;
	min: number;
	max: number;
	step: number;
	value: number;
	unit?: string;
}

export interface ChartSpec {
	id?: string;
	kicker?: string;
	title: string;
	subtitle?: string;
	xLabel?: string;
	yLabel?: string;
	y2Label?: string;
	xType?: "number" | "date" | "category";
	categories?: string[];
	xDomain?: [number, number];
	yDomain?: [number, number];
	y2Domain?: [number, number];
	samples?: number;
	params?: Record<string, number>;
	annotations?: ChartAnnotation[];
	showLegend?: boolean;
	grid?: GridSpec;
	subplots?: SubplotSpec[];
	series?: ChartSeries[];
	controls?: ChartControl[];
}

export interface ThemePalette {
	bg?: string;
	plot_bg?: string;
	border?: string;
	grid?: string;
	text_primary?: string;
	text_muted?: string;
	accent?: string;
}

export interface AxisTick {
	pos: number;
	label: string;
}

export interface RenderRequestPayload {
	width_px: number;
	height_px: number;
	dpr?: number;
	native_axes?: boolean;
	spec: ChartSpec;
	control_values: Record<string, number>;
	hidden_series: string[];
	hover_x: number | null;
	hover_norm_x?: number | null;
	hover_norm_y?: number | null;
	view_x_domain: [number, number] | null;
	theme: "dark" | "light";
	palette?: ThemePalette;
}

export interface PlotBoxFrac {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

export interface HoverReading {
	label: string;
	color: string;
	x: number;
	y: number;
	text?: string;
}

export interface RenderResponse {
	req_id: number;
	ok: boolean;
	error?: string;
	png_base64?: string;
	width_px: number;
	height_px: number;
	x_domain: [number, number];
	y_domain: [number, number];
	plot_box: PlotBoxFrac;
	native_axes_used?: boolean;
	x_ticks?: AxisTick[];
	y_ticks?: AxisTick[];
	hover_readings?: HoverReading[];
	render_ms: number;
	draw_ms?: number;
	encode_ms?: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const CANDIDATE_BINS = [
	resolve(here, "bin/inline-chart-engine"),
	resolve(here, "engine/target/release/inline-chart-engine"),
];

interface PendingReq {
	resolve: (res: RenderResponse) => void;
	reject: (err: Error) => void;
}

class RustEngineClient {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private pending = new Map<number, PendingReq>();

	private getBinaryPath(): string {
		if (process.env.INLINE_CHART_ENGINE_BIN) return process.env.INLINE_CHART_ENGINE_BIN;
		for (const p of CANDIDATE_BINS) {
			if (existsSync(p)) return p;
		}
		return CANDIDATE_BINS[0];
	}

	private ensureStarted(): ChildProcessWithoutNullStreams {
		if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
			return this.proc;
		}
		const bin = this.getBinaryPath();
		if (!existsSync(bin)) {
			throw new Error(`Rust chart engine binary not found at ${bin}. Run: cd engine && cargo build --release`);
		}
		const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
		this.proc = child;

		const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
		rl.on("line", (line) => {
			if (!line.trim()) return;
			try {
				const resp = JSON.parse(line) as RenderResponse;
				const p = this.pending.get(resp.req_id);
				if (p) {
					this.pending.delete(resp.req_id);
					p.resolve(resp);
				}
			} catch {
				// Ignore malformed line
			}
		});

		const failAll = (reason: string) => {
			for (const [, p] of this.pending) {
				p.reject(new Error(reason));
			}
			this.pending.clear();
			if (this.proc === child) this.proc = null;
		};

		child.on("exit", (code, sig) => failAll(`inline-chart-engine exited (code=${code}, sig=${sig})`));
		child.on("error", (err) => failAll(`inline-chart-engine error: ${err.message}`));
		return child;
	}

	render(payload: RenderRequestPayload): Promise<RenderResponse> {
		const child = this.ensureStarted();
		const req_id = this.nextId++;
		return new Promise<RenderResponse>((resolve, reject) => {
			this.pending.set(req_id, { resolve, reject });
			const line = JSON.stringify({ req_id, ...payload }) + "\n";
			child.stdin.write(line, (err) => {
				if (err) {
					this.pending.delete(req_id);
					reject(err);
				}
			});
		});
	}

	dispose(): void {
		if (this.proc && !this.proc.killed) {
			this.proc.kill();
		}
		this.proc = null;
	}
}

export const engineClient = new RustEngineClient();
