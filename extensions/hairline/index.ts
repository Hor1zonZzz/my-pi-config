import { homedir } from "node:os";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	keyText,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { displayPath, messageSpeed, parseWeekly, sanitizeStatus } from "./format.ts";
import { renderBottomBorder, renderFooter, renderHeader, renderHud, renderTopBorder, type WorkingModel } from "./layout.ts";
import { C, frameAt } from "./style.ts";
import { registerHairlineTools } from "./tools.ts";

const HUD_KEY = "hairline-hud";
/** Status key and wording owned by extensions/codex-statusline. */
const CODEX_QUOTA_STATUS = "codex-quota";
const MAX_SPEEDS = 64;

type Indicator = Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];

interface FooterData {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	onBranchChange(callback: () => void): () => void;
}

interface EditorBorders {
	top(width: number, hiddenAbove: number, indicator: Indicator, text: string): string;
	bottom(width: number, hiddenBelow: number, text: string): string;
}

/**
 * Pi's editor draws only a top and bottom rule; Hairline restyles those two
 * rules. `embedWorkingStatus` makes Pi hand working, retry, and compaction
 * indicators to this editor, whose timer also drives the border animation.
 */
class HairlineEditor extends CustomEditor {
	private indicator: Indicator;
	private readonly borders: EditorBorders;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, borders: EditorBorders) {
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.borders = borders;
	}

	override setWorkingStatusIndicator(indicator: Indicator): void {
		this.indicator = indicator;
		super.setWorkingStatusIndicator(indicator);
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		return this.borders.top(width, hiddenLineCount, this.indicator, this.getText());
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		return this.borders.bottom(width, hiddenLineCount, this.getText());
	}
}

interface RunState {
	startedAt?: number;
	errors: number;
	activity: "thinking" | "writing";
	tools: Map<string, string>;
}

function safeKey(binding: string, fallback: string): string {
	try {
		return keyText(binding as Parameters<typeof keyText>[0]) || fallback;
	} catch {
		return fallback;
	}
}

export default function hairline(pi: ExtensionAPI) {
	let enabled = true;
	let hudEnabled = true;
	let tui: TUI | undefined;
	let footerData: FooterData | undefined;
	let editorFactory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => HairlineEditor) | undefined;
	let messageStartedAt: number | undefined;
	let speeds: number[] = [];
	let totals = { input: 0, output: 0, cost: 0 };
	const run: RunState = { errors: 0, activity: "thinking", tools: new Map() };

	const tools = registerHairlineTools(pi, { isEnabled: () => enabled });

	const requestRender = () => tui?.requestRender();

	function refreshTotals(ctx: ExtensionContext): void {
		const next = { input: 0, output: 0, cost: 0 };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			next.input += entry.message.usage?.input ?? 0;
			next.output += entry.message.usage?.output ?? 0;
			next.cost += entry.message.usage?.cost?.total ?? 0;
		}
		totals = next;
	}

	function workingModel(now: number): WorkingModel {
		const running = [...run.tools.values()];
		const label =
			running.length === 1
				? `Running ${running[0]}`
				: running.length > 1
					? `Running ${running.length} tools`
					: run.activity === "writing"
						? "Writing"
						: "Thinking";
		return {
			label,
			elapsedMs: run.startedAt !== undefined ? now - run.startedAt : 0,
			errors: run.errors,
			frame: frameAt(now, 90),
		};
	}

	function borders(ctx: ExtensionContext): EditorBorders {
		const lineColor = (text: string) => (text.trimStart().startsWith("!") ? C.mint : C.rule);
		return {
			top(width, hiddenAbove, indicator, text) {
				const kind = (indicator as { kind?: string } | undefined)?.kind;
				if (indicator && kind === "working") {
					return renderTopBorder({ lineColor: lineColor(text), hiddenAbove, working: workingModel(Date.now()) }, width);
				}
				// Retry, compaction, and branch-summary indicators keep Pi's own wording.
				const status = indicator ? (indicator as { renderInBorder?(w: number): string }).renderInBorder?.(Math.max(1, width - 12)) : undefined;
				return renderTopBorder({ lineColor: lineColor(text), hiddenAbove, status }, width);
			},
			bottom(width, hiddenBelow, text) {
				return renderBottomBorder(
					{
						lineColor: lineColor(text),
						model: ctx.model?.id,
						thinking: pi.getThinkingLevel(),
						contextPercent: ctx.getContextUsage()?.percent,
						hiddenBelow,
					},
					width,
				);
			},
		};
	}

	function applyHud(ctx: ExtensionContext): void {
		if (!enabled || !hudEnabled) {
			ctx.ui.setWidget(HUD_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(HUD_KEY, (widgetTui) => {
			tui = widgetTui;
			return {
				render: (width: number) =>
					renderHud(
						{
							speeds,
							weekly: parseWeekly(footerData?.getExtensionStatuses().get(CODEX_QUOTA_STATUS)),
						},
						width,
					),
				invalidate() {},
			};
		});
	}

	function install(ctx: ExtensionContext): void {
		const cwd = displayPath(ctx.cwd, "", homedir());
		ctx.ui.setHeader(() => ({
			render: (width: number) =>
				renderHeader(
					{
						version: VERSION,
						model: ctx.model?.id,
						thinking: pi.getThinkingLevel(),
						cwd,
						branch: footerData?.getGitBranch(),
						hints: [
							[safeKey("app.interrupt", "esc"), "interrupt"],
							["/", "commands"],
							["!", "bash"],
							[safeKey("app.tools.expand", "ctrl+o"), "more"],
						],
					},
					width,
				),
			invalidate() {},
		}));
		ctx.ui.setFooter((footerTui, _theme, data) => {
			tui = footerTui;
			footerData = data;
			const unsubscribe = data.onBranchChange(() => footerTui.requestRender());
			return {
				render(width: number) {
					let subscription = false;
					try {
						subscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
					} catch {}
					const statuses = [...data.getExtensionStatuses().entries()]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => sanitizeStatus(text))
						.filter(Boolean);
					return renderFooter({ cwd, branch: data.getGitBranch(), ...totals, subscription, statuses }, width);
				},
				invalidate() {},
				dispose: unsubscribe,
			};
		});
		const editorBorders = borders(ctx);
		editorFactory = (editorTui, theme, keybindings) => {
			tui = editorTui;
			return new HairlineEditor(editorTui, theme, keybindings, editorBorders);
		};
		ctx.ui.setEditorComponent(editorFactory);
		applyHud(ctx);
	}

	function uninstall(ctx: ExtensionContext): void {
		ctx.ui.setHeader(undefined);
		ctx.ui.setFooter(undefined);
		if (editorFactory && ctx.ui.getEditorComponent() === editorFactory) ctx.ui.setEditorComponent(undefined);
		editorFactory = undefined;
		ctx.ui.setWidget(HUD_KEY, undefined);
		footerData = undefined;
	}

	pi.on("session_start", (_event, ctx) => {
		tools.clearCache();
		speeds = [];
		messageStartedAt = undefined;
		Object.assign(run, { startedAt: undefined, errors: 0, activity: "thinking" });
		run.tools.clear();
		refreshTotals(ctx);
		if (ctx.mode === "tui" && enabled) install(ctx);
	});

	pi.on("session_shutdown", () => {
		tui = undefined;
		footerData = undefined;
		editorFactory = undefined;
	});

	pi.on("agent_start", () => {
		Object.assign(run, { startedAt: Date.now(), errors: 0, activity: "thinking" });
		run.tools.clear();
	});

	pi.on("turn_start", () => {
		run.activity = "thinking";
	});

	pi.on("message_start", (event) => {
		if ((event.message as { role?: string }).role === "assistant") messageStartedAt = Date.now();
	});

	pi.on("message_update", (event) => {
		const type = event.assistantMessageEvent.type;
		if (type.startsWith("thinking")) run.activity = "thinking";
		else if (type.startsWith("text")) run.activity = "writing";
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message as { role?: string; stopReason?: string; usage?: { output?: number } };
		if (message.role !== "assistant") return;
		const startedAt = messageStartedAt;
		messageStartedAt = undefined;
		if (startedAt !== undefined && message.stopReason !== "aborted" && message.stopReason !== "error") {
			const speed = messageSpeed(message.usage?.output ?? 0, startedAt, Date.now());
			if (speed !== undefined) speeds = [...speeds, speed].slice(-MAX_SPEEDS);
		}
		refreshTotals(ctx);
		requestRender();
	});

	pi.on("tool_execution_start", (event) => {
		run.tools.set(event.toolCallId, event.toolName);
	});

	pi.on("tool_execution_end", (event) => {
		run.tools.delete(event.toolCallId);
		if (event.isError) run.errors++;
	});

	pi.on("agent_end", () => {
		run.startedAt = undefined;
		run.tools.clear();
		requestRender();
	});

	pi.on("session_tree", (_event, ctx) => {
		refreshTotals(ctx);
		requestRender();
	});

	pi.on("session_compact", (_event, ctx) => {
		refreshTotals(ctx);
		requestRender();
	});

	pi.registerCommand("hairline", {
		description: "Hairline skin: on, off, or hud on|off",
		getArgumentCompletions(prefix) {
			const items = [
				{ value: "on", label: "on", description: "Use the Hairline skin" },
				{ value: "off", label: "off", description: "Restore Pi's default interface" },
				{ value: "hud on", label: "hud on", description: "Show the speed line above the editor" },
				{ value: "hud off", label: "hud off", description: "Hide the speed line" },
			].filter((item) => item.value.startsWith(prefix.trimStart().toLowerCase()));
			return items.length > 0 ? items : null;
		},
		async handler(args, ctx) {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Hairline only changes the interactive terminal UI", "warning");
				return;
			}
			const [action, value] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			if (!action) {
				ctx.ui.notify(`Hairline ${enabled ? "on" : "off"} · HUD ${hudEnabled ? "on" : "off"}`, "info");
				return;
			}
			if (action === "on" || action === "off") {
				enabled = action === "on";
				if (enabled) install(ctx);
				else uninstall(ctx);
				ctx.ui.notify(enabled ? "Hairline on" : "Hairline off · earlier tool rows update when they redraw", "info");
				return;
			}
			if (action === "hud" && (value === undefined || value === "on" || value === "off")) {
				hudEnabled = value === undefined ? !hudEnabled : value === "on";
				applyHud(ctx);
				ctx.ui.notify(`Hairline HUD ${hudEnabled ? "on" : "off"}${enabled ? "" : " (applies when Hairline is on)"}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /hairline [on|off|hud on|hud off]", "warning");
		},
	});
}
