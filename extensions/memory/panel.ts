/**
 * /memory panel: a SettingsList like /settings, with list and text views as submenus.
 */
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type SettingItem, SettingsList, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type CallRecord, formatCost, summarizeCalls } from "./call-log.ts";
import type { MemoryConfig, NoteInfo } from "./store.ts";

const LIST_ROWS = 12;
const TEXT_ROWS = 24;
const ON = "开启";
const OFF = "关闭";

export interface PanelData {
	project: string;
	dir: string;
	config: MemoryConfig;
	notes: NoteInfo[];
	calls: CallRecord[];
	newSessions: number;
	dreamRunning: boolean;
	log: string[];
}

export interface PanelActions {
	setEnabled(value: boolean): Promise<void>;
	setDreamAuto(value: boolean): Promise<void>;
	deleteNote(note: NoteInfo): Promise<void>;
	/** Starts the detached dream worker; its result is reported when a later session starts. */
	runDream(): void;
	/** Stops the running dream worker. */
	stopDream(): void;
}

export function ago(ms: number | undefined, now = Date.now()): string {
	if (!ms) return "从未";
	const minutes = Math.floor((now - ms) / 60_000);
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	return `${Math.floor(hours / 24)} 天前`;
}

interface Row {
	label: string;
	value?: string;
	/** Enter: returns a child view to show, or nothing. */
	open?: () => Component | undefined;
	/** `d`: asks once, then runs on the second `d`. */
	remove?: { prompt: string; run: () => Promise<void> };
}

/** A scrollable list. Esc closes it; Enter opens a row's child view. */
class ListView implements Component {
	closed = false;
	private selected = 0;
	private child?: Component & { closed?: boolean };
	private confirming = false;

	constructor(
		private readonly title: string,
		private rows: Row[],
		private readonly hint: string,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly tui: TUI,
		private readonly close: () => void,
	) {}

	invalidate(): void {
		this.child?.invalidate();
	}

	handleInput(data: string): void {
		if (this.child) {
			this.child.handleInput?.(data);
			if (this.child.closed) this.child = undefined;
			this.tui.requestRender();
			return;
		}
		const row = this.rows[this.selected];
		if (this.confirming) {
			this.confirming = false;
			if (matchesKey(data, "d") && row?.remove) {
				const removed = this.selected;
				void row.remove.run().then(() => {
					this.rows = this.rows.filter((_, i) => i !== removed);
					this.selected = Math.min(this.selected, Math.max(0, this.rows.length - 1));
					this.tui.requestRender();
				});
			}
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.closed = true;
			this.close();
		} else if (this.keybindings.matches(data, "tui.select.up")) {
			if (this.rows.length) this.selected = (this.selected - 1 + this.rows.length) % this.rows.length;
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			if (this.rows.length) this.selected = (this.selected + 1) % this.rows.length;
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			const child = row?.open?.();
			if (child) this.child = child;
		} else if (matchesKey(data, "d") && row?.remove) {
			this.confirming = true;
		} else {
			return;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.child) return this.child.render(width);
		const t = this.theme;
		const lines = [` ${t.fg("accent", t.bold(this.title))}`];
		if (this.rows.length === 0) lines.push(` ${t.fg("muted", "（空）")}`);
		const start = Math.max(0, Math.min(this.selected - Math.floor(LIST_ROWS / 2), this.rows.length - LIST_ROWS));
		const end = Math.min(this.rows.length, start + LIST_ROWS);
		if (start > 0) lines.push(t.fg("dim", `   ↑ ${start} more`));
		const labelWidth = Math.min(48, Math.max(8, ...this.rows.map((row) => visibleWidth(row.label))));
		for (let i = start; i < end; i++) {
			const row = this.rows[i];
			const on = i === this.selected;
			const label = row.value ? truncateToWidth(row.label, labelWidth, "…", true) : row.label;
			const value = row.value ? `  ${t.fg(on ? "accent" : "muted", row.value)}` : "";
			lines.push(truncateToWidth(`${on ? t.fg("accent", " › ") : "   "}${t.fg(on ? "accent" : "text", label)}${value}`, width));
		}
		if (end < this.rows.length) lines.push(t.fg("dim", `   ↓ ${this.rows.length - end} more`));
		const hint = this.confirming ? t.fg("warning", ` 再按 d 确认：${this.rows[this.selected]?.remove?.prompt ?? ""}`) : t.fg("dim", ` ${this.hint}`);
		lines.push("", truncateToWidth(hint, width));
		return lines;
	}
}

/** Scrollable text. Esc goes back. */
class TextView implements Component {
	closed = false;
	private top = 0;

	constructor(
		private readonly title: string,
		private readonly text: string,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
	) {}

	invalidate(): void {}

	handleInput(data: string): void {
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.cancel")) this.closed = true;
		else if (kb.matches(data, "tui.select.up")) this.top = Math.max(0, this.top - 1);
		else if (kb.matches(data, "tui.select.down")) this.top += 1;
		else if (kb.matches(data, "tui.select.pageUp")) this.top = Math.max(0, this.top - TEXT_ROWS);
		else if (kb.matches(data, "tui.select.pageDown")) this.top += TEXT_ROWS;
	}

	render(width: number): string[] {
		const t = this.theme;
		const body = this.text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(10, width - 2)) : [""]));
		this.top = Math.min(this.top, Math.max(0, body.length - TEXT_ROWS));
		const lines = [` ${t.fg("accent", t.bold(this.title))}`];
		for (const line of body.slice(this.top, this.top + TEXT_ROWS)) lines.push(truncateToWidth(` ${line}`, width));
		const more = body.length > TEXT_ROWS ? ` · ${this.top + 1}-${Math.min(body.length, this.top + TEXT_ROWS)}/${body.length}` : "";
		lines.push("", t.fg("dim", ` ↑↓ 滚动 · PgUp/PgDn 翻页 · Esc 返回${more}`));
		return lines;
	}
}

function noteText(note: NoteInfo): string {
	const meta = Object.entries(note.meta)
		.map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
		.join("\n");
	return `${meta}\n\n${note.body}`;
}

function callRow(record: CallRecord): string {
	const time = record.ts.slice(5, 16).replace("T", " ");
	const cost = record.usage ? formatCost(record.usage.cost) : "-";
	return `${time}  ${record.role.padEnd(17)} ${record.outcome.padEnd(15)} ${String(record.latencyMs).padStart(6)}ms  ${cost}`;
}

/** Builds the /memory component for ctx.ui.custom(). */
export function createMemoryPanel(
	data: PanelData,
	actions: PanelActions,
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: () => void,
): Component {
	const view = (title: string, text: string) => new TextView(title, text, theme, keybindings);
	const list = (title: string, rows: Row[], hint: string, close: () => void) => new ListView(title, rows, hint, theme, keybindings, tui, close);
	let notes = [...data.notes];
	const summary = summarizeCalls(data.calls);

	const items: SettingItem[] = [
		{
			id: "enabled",
			label: "记忆",
			description: "关闭后不注入记忆、不提供 memory 工具。改动从下一轮开始生效。",
			currentValue: data.config.enabled ? ON : OFF,
			values: [ON, OFF],
		},
		{
			id: "notes",
			label: "笔记",
			description: "Enter 查看列表；在列表里 Enter 看全文，d 删除。",
			currentValue: `${notes.length} 条`,
			submenu: (_value, close) =>
				list(
					"笔记",
					notes.map((note) => ({
						label: note.name,
						value: `${typeof note.meta.type === "string" ? note.meta.type : "-"} · ${note.description}`,
						open: () => view(note.path, noteText(note)),
						remove: {
							prompt: `删除 ${note.name}`,
							run: async () => {
								await actions.deleteNote(note);
								notes = notes.filter((other) => other.path !== note.path);
							},
						},
					})),
					"↑↓ 移动 · Enter 全文 · d 删除 · Esc 返回",
					() => close(`${notes.length} 条`),
				),
		},
		{
			id: "dream",
			label: "Dream",
			description: "用会话记录核对笔记，合并、纠正并重建索引。",
			currentValue: data.dreamRunning ? "运行中" : ago(data.config.lastDreamAt),
			submenu: (value, close) => {
				let auto = data.config.dreamAuto;
				let started = false;
				const rows: Row[] = [
					data.dreamRunning
						? {
								label: "停止运行",
								value: "运行中",
								open: () => {
									actions.stopDream();
									rows[0].value = "已停止";
									return undefined;
								},
							}
						: {
								label: "立即运行",
								value: `${data.newSessions} 个新会话`,
								open: () => {
									if (!started) {
										started = true;
										actions.runDream();
										rows[0].value = "已在后台启动";
									}
									return undefined;
								},
							},
					{
						label: "每天自动",
						value: auto ? ON : OFF,
						open: () => {
							auto = !auto;
							rows[1].value = auto ? ON : OFF;
							void actions.setDreamAuto(auto);
							return undefined;
						},
					},
					{ label: "查看 log.md", value: `${data.log.length} 行`, open: () => view("log.md", data.log.join("\n") || "（空）") },
				];
				return list("Dream", rows, "↑↓ 移动 · Enter 执行 · Esc 返回", () => close(started ? "运行中" : value));
			},
		},
		{
			id: "calls",
			label: "调用历史",
			description: "calls.jsonl：每次 Dream agent 运行的输入输出、耗时和费用。",
			currentValue: `${summary.total} 次 · ${formatCost(summary.cost)}`,
			submenu: (value, close) => {
				const rows: Row[] = summary.roles.map((role) => ({
					label: role.role,
					value: `${role.calls} 次 · ${role.errors} 错误 · ${formatCost(role.cost)} · ${Object.entries(role.outcomes)
						.map(([outcome, count]) => `${outcome} ${count}`)
						.join(" · ")}`,
				}));
				const recent = data.calls.slice(-50).reverse();
				rows.push({
					label: `最近 ${recent.length} 次`,
					value: "›",
					open: () =>
						list(
							"最近调用",
							recent.map((record) => ({
								label: callRow(record),
								open: () => view(`${record.role} · ${record.ts}`, JSON.stringify(record, null, 2)),
							})),
							"↑↓ 移动 · Enter 详情 · Esc 返回",
							() => {},
						),
				});
				return list("调用历史", rows, "↑↓ 移动 · Enter 进入 · Esc 返回", () => close(value));
			},
		},
		{ id: "dir", label: "存放位置", description: data.dir, currentValue: data.dir.replace(/^.*\/memory\//, "memory/") },
	];

	const settings = new SettingsList(
		items,
		items.length + 2,
		getSettingsListTheme(),
		(id, value) => {
			if (id === "enabled") void actions.setEnabled(value === ON);
		},
		() => done(),
	);
	return {
		capturesViewportInput: settings.capturesViewportInput,
		render(width: number) {
			return [theme.fg("accent", "─".repeat(width)), ` ${theme.fg("accent", theme.bold(`记忆 · ${data.project}`))}`, "", ...settings.render(width)];
		},
		invalidate() {
			settings.invalidate();
		},
		handleInput(data: string) {
			settings.handleInput?.(data);
			tui.requestRender();
		},
	} as Component;
}
