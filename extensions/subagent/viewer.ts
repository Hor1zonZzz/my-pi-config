// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import {
	CustomEditor,
	getMarkdownTheme,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	type Component,
	type EditorComponent,
	type Focusable,
	isFocusable,
	type KeybindingsManager,
	Markdown,
	type OverlayHandle,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { getFinalOutput, isFailedResult } from "./runner.ts";
import type { SubagentTaskManager, SubagentTaskView } from "./task-manager.ts";
import type { StoredTaskStatus, SubagentTaskStatus } from "./task-storage.ts";
import type { ExecutionRequest, SingleResult } from "./types.ts";

const VIEWER_WIDGET_KEY = "subagent-viewer";
const MAX_WIDGET_TASKS = 5;
const MAX_DETAIL_CHARS = 50 * 1024;
const MAX_DETAIL_LINES = 2_000;

interface CursorPosition {
	line: number;
	col: number;
}

interface AppEditor extends EditorComponent {
	actionHandlers?: Map<unknown, () => void>;
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;
	getCursor?: () => CursorPosition;
	isShowingAutocomplete?: () => boolean;
	canObserveNavigationBoundary?: () => boolean;
}

type EditorFactory = NonNullable<
	ReturnType<ExtensionContext["ui"]["getEditorComponent"]>
>;

interface ViewerEditorFactory extends EditorFactory {
	isSubagentViewer?: true;
	baseFactory?: EditorFactory;
}

function oneLine(value: unknown, maxLength = 56): string {
	const text = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function requestFor(status: StoredTaskStatus): ExecutionRequest {
	return (status.request ?? {}) as ExecutionRequest;
}

function taskLabel(status: StoredTaskStatus): string {
	const request = requestFor(status);
	if (status.mode === "single") {
		return `${request.agent ?? "subagent"}: ${oneLine(request.task) || "(no task)"}`;
	}
	if (status.mode === "parallel") {
		const names =
			request.tasks?.map((task) => task.agent).join(", ") || "subagents";
		return `parallel: ${oneLine(names)}`;
	}
	const names =
		request.chain?.map((step) => step.agent).join(" → ") || "subagents";
	return `chain: ${oneLine(names)}`;
}

function statusIcon(status: SubagentTaskStatus): string {
	switch (status) {
		case "queued":
			return "○";
		case "running":
			return "◐";
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "cancelled":
			return "−";
		case "interrupted":
			return "!";
		default:
			return "?";
	}
}

function statusColor(status: SubagentTaskStatus): string {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "queued":
		case "running":
			return "warning";
		default:
			return "muted";
	}
}

function taskProgress(status: StoredTaskStatus): string {
	const { completed, total } = status.processes;
	return total > 1 ? `${completed}/${total}` : status.status;
}

function formatSummary(statuses: StoredTaskStatus[]): string {
	const active = statuses.filter(
		(status) => status.status === "queued" || status.status === "running",
	).length;
	const completed = statuses.filter(
		(status) => status.status === "completed",
	).length;
	const failed = statuses.filter(
		(status) => status.status === "failed" || status.status === "interrupted",
	).length;
	const parts = [`${statuses.length} task${statuses.length === 1 ? "" : "s"}`];
	if (active > 0) parts.push(`${active} active`);
	if (completed > 0) parts.push(`${completed} done`);
	if (failed > 0) parts.push(`${failed} failed`);
	return parts.join(" · ");
}

function configuredKey(
	keybindings: KeybindingsManager,
	action: string,
	fallback: string,
): string {
	const key = keybindings.getKeys?.(action)?.[0] ?? fallback;
	if (key === "down") return "↓";
	if (key === "up") return "↑";
	if (key === "enter" || key === "return") return "Enter";
	if (key === "escape" || key === "esc") return "Esc";
	return key;
}

function boundedText(
	text: string,
	maxChars = MAX_DETAIL_CHARS,
	maxLines = MAX_DETAIL_LINES,
): string {
	const marker = "… preview truncated …";
	let lines = text.split("\n");
	let truncated = false;
	if (lines.length > maxLines) {
		const headCount = Math.max(1, Math.floor(maxLines * 0.7));
		const tailCount = Math.max(1, maxLines - headCount - 1);
		lines = [...lines.slice(0, headCount), marker, ...lines.slice(-tailCount)];
		truncated = true;
	}
	let result = lines.join("\n");
	if (result.length > maxChars) {
		const markerWithSpacing = `\n\n${marker}\n\n`;
		const available = Math.max(2, maxChars - markerWithSpacing.length);
		const headLength = Math.max(1, Math.floor(available * 0.7));
		const tailLength = Math.max(1, available - headLength);
		result = `${result.slice(0, headLength).trimEnd()}${markerWithSpacing}${result.slice(-tailLength).trimStart()}`;
		truncated = true;
	}
	return truncated ? result : text;
}

function quoteMarkdown(text: string): string {
	return boundedText(text || "(empty)", 4_000, 100)
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

function formatUsage(result: SingleResult): string {
	const usage = result.usage;
	if (!usage) return "";
	const model = result.model ? ` · ${result.model}` : "";
	return `${usage.turns} turns · ↑${usage.input} ↓${usage.output} · $${usage.cost.toFixed(4)}${model}`;
}

function formatRecentToolCalls(result: SingleResult): string[] {
	const calls: string[] = [];
	for (const message of result.messages ?? []) {
		if (message.role !== "assistant" || !Array.isArray(message.content))
			continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			let args = "";
			try {
				args = oneLine(JSON.stringify(part.arguments ?? {}), 80);
			} catch {
				args = "{…}";
			}
			calls.push(`- → \`${part.name}\` ${args}`.trimEnd());
		}
	}
	return calls.slice(-4);
}

function formatRequest(status: StoredTaskStatus): string {
	const request = requestFor(status);
	if (status.mode === "single") {
		return `**${request.agent ?? "subagent"}**\n\n${quoteMarkdown(request.task ?? "")}`;
	}
	const entries =
		status.mode === "parallel" ? (request.tasks ?? []) : (request.chain ?? []);
	return entries
		.map(
			(entry, index) =>
				`${index + 1}. **${entry.agent}** — ${oneLine(entry.task, 240) || "(no task)"}`,
		)
		.join("\n");
}

function resultState(result: SingleResult): string {
	if (result.exitCode === -1) return "running";
	return isFailedResult(result) ? "failed" : "completed";
}

function buildTaskMarkdown(view: SubagentTaskView | undefined): string {
	if (!view) return "# Subagent Task\n\nTask data is unavailable.";
	const { status, results } = view;
	const lines = [
		"# Subagent Task",
		"",
		`- **ID:** \`${status.taskId}\``,
		`- **Status:** ${status.status}`,
		`- **Mode:** ${status.mode}/${status.execution}`,
		`- **Progress:** ${status.processes.completed}/${status.processes.total}`,
		"",
		"## Request",
		"",
		formatRequest(status) || "(no request)",
	];

	if (status.error) {
		lines.push("", "## Error", "", boundedText(status.error, 4_000, 100));
	}

	if (results.length === 0) {
		lines.push("", "## Output", "", "(waiting for subagent output)");
	}

	const perResultBudget = Math.max(
		2_000,
		Math.floor((MAX_DETAIL_CHARS - 10_000) / Math.max(1, results.length)),
	);
	for (let index = 0; index < results.length; index += 1) {
		const result = results[index];
		if (!result) continue;
		const heading =
			status.mode === "chain"
				? `## Step ${result.step ?? index + 1}: ${result.agent}`
				: `## ${result.agent}`;
		lines.push("", heading, "", `**State:** ${resultState(result)}`);
		const usage = formatUsage(result);
		if (usage) lines.push(`\n${usage}`);
		const calls = formatRecentToolCalls(result);
		if (calls.length > 0) lines.push("", "### Recent tool calls", "", ...calls);
		const failed = result.exitCode !== -1 && isFailedResult(result);
		if (failed && (result.errorMessage || result.stderr)) {
			lines.push(
				"",
				"### Error",
				"",
				boundedText(
					[result.errorMessage, result.stderr].filter(Boolean).join("\n\n"),
					Math.max(1_000, Math.floor(perResultBudget / 3)),
					200,
				),
			);
		}
		const output = getFinalOutput(result.messages ?? []) || "(no output yet)";
		lines.push(
			"",
			"### Output",
			"",
			boundedText(
				output,
				Math.max(1_000, Math.floor((perResultBudget * 2) / 3)),
				400,
			),
		);
	}

	lines.push(
		"",
		"---",
		"",
		`Complete result: \`${status.resultPath}\``,
		`Structured details: \`${status.detailsPath}\``,
	);
	return boundedText(lines.join("\n"));
}

function frameLine(content: string, innerWidth: number, theme: Theme): string {
	const fitted = truncateToWidth(content, innerWidth, "");
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)));
	return `${theme.fg("border", "│")}${fitted}${padding}${theme.fg("border", "│")}`;
}

class TaskDetailComponent implements Component {
	private scrollOffset = 0;
	private bodyLength = 0;
	private visibleBodyLines = 1;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly taskManager: SubagentTaskManager,
		private readonly cwd: string,
		private readonly taskId: string,
		private readonly done: () => void,
	) {}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.scrollOffset = Math.min(
				Math.max(0, this.bodyLength - this.visibleBodyLines),
				this.scrollOffset + 1,
			);
		} else if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.scrollOffset = Math.max(
				0,
				this.scrollOffset - this.visibleBodyLines,
			);
		} else if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.scrollOffset = Math.min(
				Math.max(0, this.bodyLength - this.visibleBodyLines),
				this.scrollOffset + this.visibleBodyLines,
			);
		} else {
			return;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (safeWidth < 4) {
			return [
				truncateToWidth(
					this.theme.fg("warning", "Subagent detail: terminal too narrow"),
					safeWidth,
					"",
				),
			];
		}
		const innerWidth = safeWidth - 2;
		const markdown = new Markdown(
			buildTaskMarkdown(this.taskManager.getTaskView(this.cwd, this.taskId)),
			0,
			0,
			getMarkdownTheme(),
		);
		const body = markdown.render(innerWidth);
		this.bodyLength = body.length;
		const availableBodyLines = Math.max(1, (this.tui.terminal.rows ?? 24) - 8);
		this.visibleBodyLines = Math.min(body.length || 1, availableBodyLines);
		this.scrollOffset = Math.min(
			this.scrollOffset,
			Math.max(0, body.length - this.visibleBodyLines),
		);
		const visible = body.slice(
			this.scrollOffset,
			this.scrollOffset + this.visibleBodyLines,
		);
		const top = this.theme.fg("borderAccent", `╭${"─".repeat(innerWidth)}╮`);
		const bottom = this.theme.fg("borderAccent", `╰${"─".repeat(innerWidth)}╯`);
		const position =
			body.length > this.visibleBodyLines
				? ` · ${this.scrollOffset + 1}-${Math.min(body.length, this.scrollOffset + this.visibleBodyLines)}/${body.length}`
				: "";
		const help = this.theme.fg(
			"dim",
			` ↑/↓ scroll · PgUp/PgDn page · Esc back${position}`,
		);
		return [
			top,
			...visible.map((line) => frameLine(line, innerWidth, this.theme)),
			frameLine(help, innerWidth, this.theme),
			bottom,
		];
	}

	invalidate(): void {}
}

class SubagentViewerWidget implements Component {
	constructor(
		private readonly controller: SubagentViewerController,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
	) {}

	render(width: number): string[] {
		const statuses = this.controller.getStatuses();
		if (statuses.length === 0) return [];
		const safeWidth = Math.max(1, width);
		const summary = formatSummary(statuses);
		if (!this.controller.isPickerActive()) {
			const down = configuredKey(
				this.keybindings,
				"tui.editor.cursorDown",
				"down",
			);
			return [
				truncateToWidth(
					this.theme.fg("dim", ` ${down} Subagents · ${summary}`),
					safeWidth,
				),
			];
		}

		const selectedIndex = this.controller.getSelectedIndex();
		const visibleCount = Math.min(MAX_WIDGET_TASKS, statuses.length);
		const start = Math.max(
			0,
			Math.min(
				selectedIndex - Math.floor(visibleCount / 2),
				statuses.length - visibleCount,
			),
		);
		const lines = [
			truncateToWidth(
				this.theme.fg("accent", this.theme.bold(` Subagents · ${summary}`)),
				safeWidth,
			),
		];
		for (let index = start; index < start + visibleCount; index += 1) {
			const status = statuses[index];
			if (!status) continue;
			const selected = index === selectedIndex;
			const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
			const icon = this.theme.fg(
				statusColor(status.status),
				statusIcon(status.status),
			);
			const label = selected
				? this.theme.fg("accent", taskLabel(status))
				: taskLabel(status);
			const progress = this.theme.fg("dim", ` · ${taskProgress(status)}`);
			lines.push(
				truncateToWidth(` ${prefix}${icon} ${label}${progress}`, safeWidth),
			);
		}
		lines.push(
			truncateToWidth(
				this.theme.fg("dim", " ↑/↓ select · Enter open · Esc return to editor"),
				safeWidth,
			),
		);
		return lines;
	}

	invalidate(): void {}
}

class SubagentViewerEditor implements EditorComponent, Focusable {
	private changeVersion = 0;
	private changeHandler: ((text: string) => void) | undefined;

	constructor(
		private readonly editor: EditorComponent,
		private readonly keybindings: KeybindingsManager,
		private readonly controller: SubagentViewerController,
	) {}

	get focused(): boolean {
		return isFocusable(this.editor) ? this.editor.focused : false;
	}

	set focused(value: boolean) {
		if (isFocusable(this.editor)) this.editor.focused = value;
	}

	get wantsKeyRelease(): boolean | undefined {
		return this.editor.wantsKeyRelease;
	}

	set wantsKeyRelease(value: boolean | undefined) {
		this.editor.wantsKeyRelease = value;
	}

	get onSubmit(): ((text: string) => void) | undefined {
		return this.editor.onSubmit;
	}

	set onSubmit(handler: ((text: string) => void) | undefined) {
		this.editor.onSubmit = handler;
	}

	get onChange(): ((text: string) => void) | undefined {
		return this.changeHandler;
	}

	set onChange(handler: ((text: string) => void) | undefined) {
		this.changeHandler = handler;
		this.editor.onChange = (text) => {
			this.changeVersion += 1;
			handler?.(text);
		};
	}

	get borderColor(): ((text: string) => string) | undefined {
		return this.editor.borderColor;
	}

	set borderColor(color: ((text: string) => string) | undefined) {
		this.editor.borderColor = color;
	}

	get actionHandlers(): Map<unknown, () => void> {
		const editor = this.editor as AppEditor;
		editor.actionHandlers ??= new Map();
		return editor.actionHandlers;
	}

	get onEscape(): (() => void) | undefined {
		return (this.editor as AppEditor).onEscape;
	}

	set onEscape(handler: (() => void) | undefined) {
		(this.editor as AppEditor).onEscape = handler;
	}

	get onCtrlD(): (() => void) | undefined {
		return (this.editor as AppEditor).onCtrlD;
	}

	set onCtrlD(handler: (() => void) | undefined) {
		(this.editor as AppEditor).onCtrlD = handler;
	}

	get onPasteImage(): (() => void) | undefined {
		return (this.editor as AppEditor).onPasteImage;
	}

	set onPasteImage(handler: (() => void) | undefined) {
		(this.editor as AppEditor).onPasteImage = handler;
	}

	get onExtensionShortcut(): ((data: string) => boolean) | undefined {
		return (this.editor as AppEditor).onExtensionShortcut;
	}

	set onExtensionShortcut(handler: ((data: string) => boolean) | undefined) {
		(this.editor as AppEditor).onExtensionShortcut = handler;
	}

	getText(): string {
		return this.editor.getText();
	}

	setText(text: string): void {
		this.editor.setText(text);
	}

	getCursor(): CursorPosition | undefined {
		return (this.editor as AppEditor).getCursor?.();
	}

	canObserveNavigationBoundary(): boolean {
		const editor = this.editor as AppEditor;
		if (typeof editor.canObserveNavigationBoundary === "function") {
			return editor.canObserveNavigationBoundary();
		}
		return (
			typeof editor.getCursor === "function" &&
			typeof editor.isShowingAutocomplete === "function"
		);
	}

	isShowingAutocomplete(): boolean {
		return (this.editor as AppEditor).isShowingAutocomplete?.() ?? false;
	}

	handleInput(data: string): void {
		if (this.controller.isPickerActive()) {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.controller.deactivatePicker();
				return;
			}
			if (this.keybindings.matches(data, "tui.select.up")) {
				if (!this.controller.moveSelection(-1)) {
					this.controller.deactivatePicker();
				}
				return;
			}
			if (this.keybindings.matches(data, "tui.select.down")) {
				this.controller.moveSelection(1);
				return;
			}
			if (this.keybindings.matches(data, "tui.select.pageUp")) {
				this.controller.moveSelection(-MAX_WIDGET_TASKS);
				return;
			}
			if (this.keybindings.matches(data, "tui.select.pageDown")) {
				this.controller.moveSelection(MAX_WIDGET_TASKS);
				return;
			}
			if (this.keybindings.matches(data, "tui.select.confirm")) {
				void this.controller.openSelectedTask();
				return;
			}
			this.controller.deactivatePicker();
			this.editor.handleInput(data);
			return;
		}

		if (
			!this.keybindings.matches(data, "tui.editor.cursorDown") ||
			!this.controller.hasTasks() ||
			!this.canObserveNavigationBoundary() ||
			this.isShowingAutocomplete()
		) {
			this.editor.handleInput(data);
			return;
		}

		const beforeCursor = this.getCursor();
		if (!beforeCursor) {
			this.editor.handleInput(data);
			return;
		}
		const beforeText = this.editor.getText();
		const beforeChangeVersion = this.changeVersion;
		this.editor.handleInput(data);
		const afterCursor = this.getCursor();
		const didNotMove =
			afterCursor !== undefined &&
			beforeCursor.line === afterCursor.line &&
			beforeCursor.col === afterCursor.col &&
			beforeText === this.editor.getText() &&
			beforeChangeVersion === this.changeVersion;
		if (didNotMove && !this.isShowingAutocomplete()) {
			this.controller.activatePicker();
		}
	}

	render(width: number): string[] {
		return this.editor.render(width);
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	addToHistory(text: string): void {
		this.editor.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.editor.insertTextAtCursor?.(text);
	}

	getExpandedText(): string {
		return this.editor.getExpandedText?.() ?? this.editor.getText();
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.editor.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding: number): void {
		this.editor.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.editor.setAutocompleteMaxVisible?.(maxVisible);
	}
}

export class SubagentViewerController {
	private context: ExtensionContext | undefined;
	private tui: TUI | undefined;
	private keybindings: KeybindingsManager | undefined;
	private unsubscribe: (() => void) | undefined;
	private statuses: StoredTaskStatus[] = [];
	private pickerActive = false;
	private selectedTaskId: string | undefined;
	private detailOpen = false;
	private detailHandle: OverlayHandle | undefined;

	constructor(private readonly taskManager: SubagentTaskManager) {}

	startSession(ctx: ExtensionContext): void {
		this.shutdown();
		if (ctx.mode !== "tui") return;
		this.context = ctx;
		this.refreshStatuses();
		this.unsubscribe = this.taskManager.subscribe(() => {
			this.refreshStatuses();
			this.tui?.requestRender();
		});
		this.installEditor(ctx);
		const keybindings = this.keybindings;
		if (!keybindings) return;
		ctx.ui.setWidget(
			VIEWER_WIDGET_KEY,
			(tui, theme) => {
				this.tui = tui;
				return new SubagentViewerWidget(this, theme, keybindings);
			},
			{ placement: "belowEditor" },
		);
	}

	private installEditor(ctx: ExtensionContext): void {
		const currentFactory = ctx.ui.getEditorComponent() as
			| ViewerEditorFactory
			| undefined;
		const baseFactory = currentFactory?.isSubagentViewer
			? currentFactory.baseFactory
			: currentFactory;
		const factory: ViewerEditorFactory = (tui, theme, keybindings) => {
			this.tui = tui;
			this.keybindings = keybindings;
			const baseEditor =
				baseFactory?.(tui, theme, keybindings) ??
				new CustomEditor(tui, theme, keybindings);
			return new SubagentViewerEditor(baseEditor, keybindings, this);
		};
		factory.isSubagentViewer = true;
		factory.baseFactory = baseFactory;
		ctx.ui.setEditorComponent(factory);
	}

	private refreshStatuses(): void {
		if (!this.context) return;
		this.statuses = this.taskManager
			.listStatuses(this.context.cwd)
			.sort((left, right) => right.createdAt - left.createdAt);
		if (
			this.selectedTaskId === undefined ||
			!this.statuses.some((status) => status.taskId === this.selectedTaskId)
		) {
			this.selectedTaskId = this.statuses[0]?.taskId;
		}
		if (this.statuses.length === 0) this.pickerActive = false;
	}

	getStatuses(): StoredTaskStatus[] {
		return this.statuses;
	}

	hasTasks(): boolean {
		return this.statuses.length > 0;
	}

	isPickerActive(): boolean {
		return this.pickerActive;
	}

	getSelectedIndex(): number {
		const index = this.statuses.findIndex(
			(status) => status.taskId === this.selectedTaskId,
		);
		return Math.max(0, index);
	}

	activatePicker(): boolean {
		this.refreshStatuses();
		if (this.statuses.length === 0) return false;
		this.pickerActive = true;
		this.selectedTaskId ??= this.statuses[0]?.taskId;
		this.tui?.requestRender();
		return true;
	}

	deactivatePicker(): void {
		this.pickerActive = false;
		this.tui?.requestRender();
	}

	moveSelection(offset: number): boolean {
		if (this.statuses.length === 0) return false;
		const current = this.getSelectedIndex();
		const next = Math.max(
			0,
			Math.min(this.statuses.length - 1, current + offset),
		);
		if (next === current) return false;
		this.selectedTaskId = this.statuses[next]?.taskId;
		this.tui?.requestRender();
		return true;
	}

	openSelectedTask(): void {
		if (
			this.detailOpen ||
			!this.context ||
			!this.tui ||
			!this.keybindings ||
			!this.selectedTaskId
		) {
			return;
		}
		const ctx = this.context;
		const tui = this.tui;
		const taskId = this.selectedTaskId;
		this.detailOpen = true;
		try {
			const component = new TaskDetailComponent(
				tui,
				ctx.ui.theme,
				this.keybindings,
				this.taskManager,
				ctx.cwd,
				taskId,
				() => this.closeTaskDetail(),
			);
			this.detailHandle = tui.showOverlay(component, {
				anchor: "right-center",
				width: "75%",
				margin: 1,
			});
		} catch (error) {
			this.detailOpen = false;
			this.detailHandle = undefined;
			ctx.ui.notify(
				`Could not open subagent task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}

	private closeTaskDetail(): void {
		if (!this.detailOpen) return;
		this.detailOpen = false;
		const handle = this.detailHandle;
		this.detailHandle = undefined;
		handle?.hide();
		this.tui?.requestRender();
	}

	shutdown(): void {
		this.closeTaskDetail();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.context?.mode === "tui") {
			this.context.ui.setWidget(VIEWER_WIDGET_KEY, undefined);
		}
		this.context = undefined;
		this.tui = undefined;
		this.keybindings = undefined;
		this.statuses = [];
		this.pickerActive = false;
		this.selectedTaskId = undefined;
		this.detailOpen = false;
	}
}
