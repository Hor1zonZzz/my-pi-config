/**
 * Subagent extension: delegate tasks to `pi` subprocesses with isolated context.
 *
 * - One tool, three modes (single, parallel, chain), each sync or `async: true`.
 * - Every run's child session is saved under <agent dir>/subagent-sessions/.
 * - Running subagents are listed below the editor; on an empty prompt, ↓ selects
 *   one, Enter shows its live transcript, x x stops it, Esc returns to the editor.
 * - /subagent-history lists this session's runs and opens their transcripts.
 * - /subagent configures a user agent's model and thinking level.
 */

import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { BackgroundJobs } from "./background.ts";
import { registerConfigCommand } from "./config.ts";
import { subagentsEnabled, toggleSubagents } from "./enabled.ts";
import { registerControlTool } from "./control.ts";
import { preview } from "./format.ts";
import { RunPanel } from "./panel.ts";
import { NOTICE_TYPE, type NoticeDetails, noticeComponent, watchRunNotices } from "./notices.ts";
import { completionComponent } from "./render.ts";
import { interrupted, RunRegistry } from "./runs.ts";
import { listRuns, parentSessionDir, readSessionMessages, sessionFileOf } from "./store.ts";
import { registerSubagentTool } from "./tool.ts";
import { type HistoryItem, HistoryView, type RunSource, RunView } from "./viewer.ts";

const PANEL_KEY = "subagent-runs";
const ANIMATION_MS = 120;

interface EditorLike {
	actionHandlers?: unknown;
	getText?: () => string;
	getLines?: () => string[];
	getCursor?: () => { line: number; col: number };
	isShowingAutocomplete?: () => boolean;
	// Private in pi-tui's Editor, read by duck typing: whether ↓ would browse history
	// or move within a wrapped line. Without them the logical last line is used.
	historyIndex?: unknown;
	isOnLastVisualLine?: () => boolean;
}

/**
 * True when ↓ has nothing left to do in the editor: its cursor is on the last
 * line, no completion menu is open, and the user is not browsing history. There
 * Pi's editor would only jump to the end of the line.
 */
export function editorAtBottom(editor: EditorLike | undefined): boolean {
	if (!editor) return false;
	if (editor.isShowingAutocomplete?.()) return false;
	if (typeof editor.historyIndex === "number" && editor.historyIndex > -1) return false;
	if (typeof editor.isOnLastVisualLine === "function") return editor.isOnLastVisualLine();
	const lines = editor.getLines?.();
	const cursor = editor.getCursor?.();
	if (lines && cursor) return cursor.line >= lines.length - 1;
	return (editor.getText?.() ?? "x").length === 0;
}

/**
 * Pi's main prompt editor extends CustomEditor, which carries `actionHandlers`.
 * `getFocusedComponent()` is on the concrete TUI (TuiBase), not the `TUI`
 * interface; without it the panel simply never takes the ↓ key.
 */
function focusedEditor(tui: TUI | undefined): EditorLike | undefined {
	const withFocus = tui as (TUI & { getFocusedComponent?: () => Component | null }) | undefined;
	if (typeof withFocus?.getFocusedComponent !== "function") return undefined;
	const focused = withFocus.getFocusedComponent() as EditorLike | null;
	return focused && focused.actionHandlers instanceof Map && typeof focused.getText === "function" ? focused : undefined;
}

/** Messages already in a session keep their look even while subagents are off; they do not reach the model differently. */
function registerRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("subagent-completion", (message, { expanded }, theme) =>
		completionComponent(theme, String(message.content), message.details, expanded),
	);
	pi.registerMessageRenderer(NOTICE_TYPE, (message, _options, theme) => noticeComponent(theme, message.details as NoticeDetails | undefined));
}

/** The workflow prompts (/scout, /implement, …) ship with the extension and exist only while it is on. */
const PROMPTS_DIR = fileURLToPath(new URL("./prompts", import.meta.url));

export default function subagentExtension(pi: ExtensionAPI) {
	registerRenderers(pi);
	if (!subagentsEnabled()) {
		// Off: no tools, prompts, panel, notices, or other commands; only the way back.
		pi.registerCommand("subagent", {
			description: "Subagents are off; /subagent on turns them on",
			handler: async (args, ctx) => {
				if (args.trim() === "on") return toggleSubagents(true, ctx);
				ctx.ui.notify("Subagents are off. /subagent on turns them on.", "info");
			},
		});
		return;
	}
	pi.on("resources_discover", () => ({ promptPaths: [PROMPTS_DIR] }));

	const registry = new RunRegistry();
	const background = new BackgroundJobs(pi);
	let ctxRef: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let animation: ReturnType<typeof setInterval> | undefined;
	let stopListening: (() => void) | undefined;
	let stopInput: (() => void) | undefined;

	const requestRender = () => tui?.requestRender();

	const stopRun = (runId: string) => {
		const run = registry.get(runId);
		if (run?.stop()) ctxRef?.ui.notify(`Stopping ${run.snapshot.agent}: ${preview(run.snapshot.task, 60)}`, "info");
	};

	const sourceFor = (item: HistoryItem): (() => RunSource) => {
		if (item.live) {
			const live = item.live;
			return () => ({ snapshot: live.snapshot, messages: live.messages, streaming: live.streaming });
		}
		const file = sessionFileOf(item.snapshot);
		const messages = file ? readSessionMessages(file) : [];
		return () => ({ snapshot: item.snapshot, messages });
	};

	const historyItems = (): HistoryItem[] => {
		const ctx = ctxRef;
		if (!ctx) return [];
		const items = new Map<string, HistoryItem>();
		for (const snapshot of listRuns(parentSessionDir(ctx.sessionManager.getSessionId()))) {
			items.set(snapshot.id, { snapshot: interrupted(snapshot) });
		}
		for (const live of registry.list()) items.set(live.id, { snapshot: live.snapshot, live });
		return [...items.values()].sort((a, b) => b.snapshot.startedAt - a.snapshot.startedAt);
	};

	/** Full-screen overlay that redraws on run updates and releases its subscription on close. */
	const showOverlay = (build: (tui: TUI, theme: Theme, close: () => void) => Component) => {
		const ctx = ctxRef;
		if (!ctx || ctx.mode !== "tui") return;
		void ctx.ui.custom<void>(
			(overlayTui, theme, _keybindings, done) => {
				const component = build(overlayTui, theme, () => done(undefined));
				const unsubscribe = registry.subscribe(() => overlayTui.requestRender());
				return Object.assign(component, { dispose: unsubscribe });
			},
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } },
		);
	};

	const openRun = (runId: string) => {
		const item = historyItems().find((candidate) => candidate.snapshot.id === runId);
		if (!item) return;
		showOverlay((overlayTui, theme, close) => new RunView({ theme, tui: overlayTui, source: sourceFor(item), onClose: close, onStop: stopRun }));
	};

	const openHistory = () => {
		showOverlay((overlayTui, theme, close) => new HistoryView({ theme, tui: overlayTui, load: historyItems, open: sourceFor, onClose: close, onStop: stopRun }));
	};

	const panel = new RunPanel(registry, {
		isEditorFocused: () => focusedEditor(tui) !== undefined,
		isEditorAtBottom: () => editorAtBottom(focusedEditor(tui)),
		requestRender,
		open: openRun,
		stop: stopRun,
	});

	// Keep spinners and elapsed times moving while the main agent is idle.
	const syncAnimation = () => {
		const running = registry.running().length > 0;
		if (running && !animation) animation = setInterval(requestRender, ANIMATION_MS);
		if (!running && animation) {
			clearInterval(animation);
			animation = undefined;
		}
		requestRender();
	};

	const teardown = () => {
		if (animation) clearInterval(animation);
		animation = undefined;
		stopListening?.();
		stopListening = undefined;
		stopInput?.();
		stopInput = undefined;
		panel.deactivate();
	};

	pi.on("session_start", (_event, ctx) => {
		teardown();
		registry.reset();
		ctxRef = ctx;
		stopListening = registry.subscribe(syncAnimation);
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(
			PANEL_KEY,
			(widgetTui, theme) => {
				tui = widgetTui;
				return { render: (width: number) => panel.lines(theme, width), invalidate() {} };
			},
			{ placement: "belowEditor" },
		);
		stopInput = ctx.ui.onTerminalInput((data) => panel.handleInput(data));
	});

	pi.on("session_shutdown", async () => {
		teardown();
		await background.shutdown();
		registry.reset();
		ctxRef = undefined;
		tui = undefined;
	});

	pi.on("session_tree", () => background.shutdown(false));

	registerConfigCommand(pi, () => registry.running().length);
	registerSubagentTool(pi, registry, background);
	registerControlTool(pi, { registry, background });

	pi.registerCommand("subagent-history", {
		description: "Browse this session's subagent runs and their transcripts",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/subagent-history requires TUI mode", "error");
				return;
			}
			ctxRef = ctx;
			openHistory();
		},
	});

	pi.registerCommand("subagent-jobs", {
		description: "List background subagents, or cancel <id|all>",
		handler: async (args, ctx) => {
			const [action, id, extra] = args.trim().split(/\s+/);
			if (action === "cancel" && id && !extra) {
				const count = background.cancel(id);
				ctx.ui.notify(count ? `Cancelling ${count} background job(s).` : `Unknown job: ${id}`, count ? "info" : "warning");
			} else if (!action && ctx.mode === "tui") {
				ctxRef = ctx;
				openHistory();
			} else {
				ctx.ui.notify(action ? "Usage: /subagent-jobs [cancel <id|all>]" : background.list(), "info");
			}
		},
	});

	watchRunNotices(pi, registry, { sessionId: () => ctxRef?.sessionManager.getSessionId() });
}
