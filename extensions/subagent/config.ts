import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	getAgentDir,
	getSelectListTheme,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, type Focusable, Input, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { discoverAgents, updateAgentModelSettings } from "./agents.ts";
import { toggleSubagents } from "./enabled.ts";

// `/subagent`: choose a user agent, an available model, and a supported thinking level,
// then write them to the agent's frontmatter. Unchanged from the previous extension.

const THINKING_LEVELS: ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const THINKING_LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning",
	low: "Light reasoning",
	medium: "Moderate reasoning",
	high: "Deep reasoning",
	xhigh: "Extra-high reasoning",
	max: "Maximum reasoning",
};

class SearchableSelector extends Container implements Focusable {
	private readonly searchInput = new Input();
	private selectList: SelectList;
	private readonly selectListChildIndex: number;
	private readonly allItems: SelectItem[];
	private readonly keybindings: KeybindingsManager;
	private readonly requestRender: () => void;
	private readonly onSelect: (value: string) => void;
	private readonly onCancel: () => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		title: string,
		items: SelectItem[],
		selectedValue: string | undefined,
		keybindings: KeybindingsManager,
		requestRender: () => void,
		onSelect: (value: string) => void,
		onCancel: () => void,
	) {
		super();
		this.allItems = items;
		this.keybindings = keybindings;
		this.requestRender = requestRender;
		this.onSelect = onSelect;
		this.onCancel = onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(title, 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.selectList = this.createSelectList(items, selectedValue);
		this.selectListChildIndex = this.children.length;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text("Type to filter · ↑↓ navigate · Enter select · Esc cancel", 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	private createSelectList(items: SelectItem[], selectedValue?: string): SelectList {
		const baseTheme = getSelectListTheme();
		const list = new SelectList(
			items,
			Math.min(Math.max(items.length, 1), 12),
			{
				...baseTheme,
				noMatch: () => baseTheme.noMatch("  No matching options"),
			},
			{ minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 48 },
		);
		const selectedIndex = selectedValue
			? items.findIndex((item) => item.value === selectedValue)
			: -1;
		if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
		list.onSelect = (item) => this.onSelect(item.value);
		list.onCancel = this.onCancel;
		return list;
	}

	private applyFilter(): void {
		const selectedValue = this.selectList.getSelectedItem()?.value;
		const query = this.searchInput.getValue();
		const filteredItems = query
			? fuzzyFilter(
					this.allItems,
					query,
					(item) => `${item.label} ${item.value} ${item.description ?? ""}`,
				)
			: this.allItems;
		this.selectList = this.createSelectList(filteredItems, selectedValue);
		this.children[this.selectListChildIndex] = this.selectList;
	}

	handleInput(data: string): void {
		if (
			this.keybindings.matches(data, "tui.select.up") ||
			this.keybindings.matches(data, "tui.select.down") ||
			this.keybindings.matches(data, "tui.select.confirm") ||
			this.keybindings.matches(data, "tui.select.cancel")
		) {
			this.selectList.handleInput(data);
		} else {
			this.searchInput.handleInput(data);
			this.applyFilter();
		}
		this.requestRender();
	}
}

async function selectOption(
	ctx: ExtensionCommandContext,
	title: string,
	items: SelectItem[],
	selectedValue?: string,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) =>
		new SearchableSelector(
			title,
			items,
			selectedValue,
			keybindings,
			() => tui.requestRender(),
			done,
			() => done(undefined),
		),
	);
}

function getModelRef(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function getSelectableModels(ctx: ExtensionCommandContext): Model<any>[] {
	const available = ctx.modelRegistry.getAvailable();
	if (ctx.scopedModels.length === 0) {
		return available.sort((a, b) => getModelRef(a).localeCompare(getModelRef(b)));
	}

	const scopedRefs = new Set(ctx.scopedModels.map(({ model }) => getModelRef(model)));
	return available
		.filter((model) => scopedRefs.has(getModelRef(model)))
		.sort((a, b) => getModelRef(a).localeCompare(getModelRef(b)));
}

function resolveConfiguredModel(
	configuredRef: string | undefined,
	models: Model<any>[],
): { model?: Model<any>; thinkingLevel?: ThinkingLevel } {
	if (!configuredRef) return {};
	const exact = models.find((model) => getModelRef(model) === configuredRef);
	if (exact) return { model: exact };

	const separator = configuredRef.lastIndexOf(":");
	if (separator === -1) return {};
	const suffix = configuredRef.slice(separator + 1) as ThinkingLevel;
	if (!THINKING_LEVELS.includes(suffix)) return {};
	const baseRef = configuredRef.slice(0, separator);
	const model = models.find((candidate) => getModelRef(candidate) === baseRef);
	return model ? { model, thinkingLevel: suffix } : {};
}

export function registerConfigCommand(pi: ExtensionAPI, running: () => number): void {
	pi.registerCommand("subagent", {
		description: "Configure a user subagent's model and thinking level, or turn subagents on|off",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "on" || action === "off") return toggleSubagents(action === "on", ctx, running());
			if (action) {
				ctx.ui.notify("Usage: /subagent [on|off]", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/subagent requires TUI mode", "error");
				return;
			}

			const agents = discoverAgents(ctx.cwd, "user").agents.sort((a, b) =>
				a.name.localeCompare(b.name),
			);
			if (agents.length === 0) {
				ctx.ui.notify(`No user agents found in ${path.join(getAgentDir(), "agents")}`, "warning");
				return;
			}

			const selectedAgentName = await selectOption(
				ctx,
				"Select Subagent",
				agents.map((agent) => ({
					value: agent.name,
					label: agent.name,
					description: `${agent.description} · ${agent.model ?? "inherits current model"} · thinking:${agent.thinkingLevel ?? "default"}`,
				})),
			);
			if (!selectedAgentName) return;
			const agent = agents.find((candidate) => candidate.name === selectedAgentName);
			if (!agent) return;

			const models = getSelectableModels(ctx);
			if (models.length === 0) {
				ctx.ui.notify("No models are currently available to this Pi session", "warning");
				return;
			}

			const configured = resolveConfiguredModel(agent.model, models);
			const selectedModelRef = await selectOption(
				ctx,
				`Select Model for ${agent.name}`,
				models.map((model) => ({
					value: getModelRef(model),
					label: getModelRef(model),
					description:
						model.name === model.id
							? ctx.modelRegistry.getProviderDisplayName(model.provider)
							: model.name,
				})),
				configured.model ? getModelRef(configured.model) : undefined,
			);
			if (!selectedModelRef) return;
			const selectedModel = models.find((model) => getModelRef(model) === selectedModelRef);
			if (!selectedModel) return;

			const supportedThinkingLevels = getSupportedThinkingLevels(
				selectedModel,
			) as ThinkingLevel[];
			const scopedThinkingLevel = ctx.scopedModels.find(
				({ model }) => getModelRef(model) === selectedModelRef,
			)?.thinkingLevel;
			const currentThinkingLevel = clampThinkingLevel(
				selectedModel,
				agent.thinkingLevel ??
					configured.thinkingLevel ??
					scopedThinkingLevel ??
					ctx.thinkingLevel ??
					"off",
			) as ThinkingLevel;
			const selectedThinkingLevel = await selectOption(
				ctx,
				`Select Thinking Level for ${agent.name}`,
				supportedThinkingLevels.map((level) => ({
					value: level,
					label: level,
					description: THINKING_LEVEL_DESCRIPTIONS[level],
				})),
				currentThinkingLevel,
			);
			if (!selectedThinkingLevel) return;

			try {
				await updateAgentModelSettings(
					agent,
					selectedModelRef,
					selectedThinkingLevel as ThinkingLevel,
				);
				ctx.ui.notify(
					`${agent.name}: ${selectedModelRef} · thinking:${selectedThinkingLevel}`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					`Failed to update ${agent.name}: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
