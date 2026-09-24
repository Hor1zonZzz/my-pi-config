import { getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type SettingItem, SettingsList, truncateToWidth } from "@earendil-works/pi-tui";

/** Item ids of the switches; tool names cannot contain a colon. */
export const CODE_MODE_ITEM = ":code-mode";
export const SANDBOX_ITEM = ":sandbox";
export const LANGUAGE_ITEM = ":language";
const MAX_VISIBLE = 16;

export interface ToolEntry {
	name: string;
	/** One-line summary. */
	description: string;
	builtin: boolean;
	enabled: boolean;
}

export interface ToolsPanelModel {
	codeMode(): boolean;
	sandbox(): boolean;
	/** Every registered tool except execute_code, built-ins first. */
	tools(): ToolEntry[];
	setCodeMode(enabled: boolean): void;
	setSandbox(enabled: boolean): void;
	language(): "javascript" | "python";
	setLanguage(language: "javascript" | "python"): void;
	setTool(name: string, enabled: boolean): void;
}

export function buildItems(model: ToolsPanelModel): SettingItem[] {
	const codeMode = model.codeMode();
	const items: SettingItem[] = [
		{
			id: CODE_MODE_ITEM,
			label: "Code mode",
			currentValue: codeMode ? "on" : "off",
			values: ["on", "off"],
			description: codeMode
				? "Enabled built-in tools run only inside execute_code programs (JavaScript or Python)"
				: "Built-in tools are called directly; turn on to move the enabled ones into execute_code",
		},
		{
			id: SANDBOX_ITEM,
			label: "Sandbox",
			currentValue: model.sandbox() ? "on" : "off",
			values: ["on", "off"],
			description: model.sandbox()
				? "execute_code programs cannot touch files, network, or processes themselves; only tools.* (macOS)"
				: "execute_code programs run with your full permissions",
		},
		{
			id: LANGUAGE_ITEM,
			label: "Language",
			currentValue: model.language(),
			values: ["javascript", "python"],
			description: "The only language execute_code accepts; the model cannot use the other one",
		},
	];
	for (const tool of model.tools()) {
		const inCode = codeMode && tool.builtin;
		const on = inCode ? "code" : "on";
		items.push({
			id: tool.name,
			label: tool.name,
			currentValue: tool.enabled ? on : "off",
			values: [on, "off"],
			description: inCode ? `${tool.description} — available inside execute_code` : tool.description,
		});
	}
	return items;
}

function summary(model: ToolsPanelModel): string {
	const tools = model.tools();
	if (!model.codeMode()) return `${tools.filter((tool) => tool.enabled).length} of ${tools.length} tools on`;
	const inCode = tools.filter((tool) => tool.builtin && tool.enabled).map((tool) => tool.name);
	const direct = tools.filter((tool) => !tool.builtin && tool.enabled).length;
	const sandbox = model.sandbox() ? "sandboxed" : "unsandboxed";
	const language = model.language() === "python" ? "python" : "js";
	return `code mode (${language}, ${sandbox}) · execute_code: ${inCode.length ? inCode.join(", ") : "no tools"} · ${direct} other tools on`;
}

/** The /tools selector: code-mode, sandbox, and language settings followed by one switch per registered tool. */
export class ToolsPanel implements Component {
	private readonly model: ToolsPanelModel;
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private readonly done: () => void;
	private list: SettingsList;

	constructor(model: ToolsPanelModel, theme: Theme, requestRender: () => void, done: () => void) {
		this.model = model;
		this.theme = theme;
		this.requestRender = requestRender;
		this.done = done;
		this.list = this.createList();
	}

	private createList(select?: string): SettingsList {
		const items = buildItems(this.model);
		const list = new SettingsList(
			items,
			Math.min(items.length, MAX_VISIBLE),
			getSettingsListTheme(),
			(id, value) => this.change(id, value),
			() => this.done(),
			{ enableSearch: true },
		);
		if (select) list.selectItem(select);
		return list;
	}

	private change(id: string, value: string): void {
		if (id === CODE_MODE_ITEM) {
			this.model.setCodeMode(value === "on");
			// Built-in rows switch between "on" and "code"; rebuild them.
			this.list = this.createList(CODE_MODE_ITEM);
		} else if (id === LANGUAGE_ITEM) {
			this.model.setLanguage(value === "python" ? "python" : "javascript");
		} else if (id === SANDBOX_ITEM) {
			this.model.setSandbox(value === "on");
			this.list = this.createList(SANDBOX_ITEM);
		} else {
			this.model.setTool(id, value !== "off");
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const header = [this.theme.fg("accent", this.theme.bold("Tools")), this.theme.fg("dim", summary(this.model)), ""];
		// SettingsList can exceed very narrow widths (its indent); clamp every line.
		return [...header, ...this.list.render(width)].map((line) => truncateToWidth(line, Math.max(1, width)));
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
		this.requestRender();
	}

	invalidate(): void {
		this.list.invalidate();
	}
}
