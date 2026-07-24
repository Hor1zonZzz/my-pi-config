// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import { basename } from "node:path";
import {
	formatSkillsForPrompt,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	type KeybindingsManager,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	isDirectFilePackage,
	resolveExtensions,
	saveExtensionChanges,
} from "./extensions";
import {
	cloneSessionState,
	loadGlobalSettings,
	loadProjectSettings,
	normalizeSessionState,
	saveGlobalSettings,
} from "./storage";
import {
	DEFAULT_SESSION_STATE,
	type ContextRecord,
	type ExtensionChange,
	type ManagerSnapshot,
	type ResourceSettings,
	type ResourceTab,
	type RuntimeLayer,
	type SessionResourceState,
	type SkillRecord,
} from "./types";

const SESSION_ENTRY = "pi-config-manager-state";
const TABS: ResourceTab[] = [
	"overview",
	"tools",
	"skills",
	"contexts",
	"extensions",
];
const LABELS: Record<ResourceTab, string> = {
	overview: "Overview",
	tools: "Tools",
	skills: "Skills",
	contexts: "Contexts",
	extensions: "Extensions",
};

interface ViewItem {
	id: string;
	label: string;
	enabled?: boolean;
	state: string;
	detail: string;
}

function unique(values: Iterable<string>): string[] {
	return Array.from(new Set(values)).sort();
}

function formatContextSection(files: ContextRecord[]): string {
	if (files.length === 0) return "";
	let result =
		"\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
	for (const file of files) {
		result += `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
	}
	return `${result}</project_context>\n`;
}

function sourceDetail(sourceInfo: any): string {
	if (!sourceInfo) return "unknown source";
	return `${sourceInfo.scope ?? "unknown"} · ${sourceInfo.source ?? "unknown"} · ${sourceInfo.path ?? "unknown path"}`;
}

class ConfigManagerView implements Component, Focusable {
	private readonly search = new Input();
	private tab: ResourceTab;
	private selected = 0;
	private _focused = false;

	constructor(
		initialTab: ResourceTab,
		private readonly getSnapshot: () => ManagerSnapshot,
		private readonly stagedExtensions: Map<string, ExtensionChange>,
		private readonly theme: any,
		private readonly keybindings: KeybindingsManager,
		private readonly onToggle: (tab: ResourceTab, id: string) => void,
		private readonly onDone: (action: "close" | "save") => void,
	) {
		this.tab = initialTab;
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.search.focused = value;
	}

	invalidate(): void {
		this.search.invalidate();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onDone("close");
			return;
		}
		if (
			this.keybindings.matches(data, "tui.input.tab") ||
			this.keybindings.matches(data, "tui.editor.cursorRight")
		) {
			this.changeTab(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.cursorLeft")) {
			this.changeTab(-1);
			return;
		}
		const items = this.filteredItems();
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selected = Math.max(0, this.selected - 1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.selected = Math.min(
				Math.max(0, items.length - 1),
				this.selected + 1,
			);
			return;
		}
		if (data === " " || this.keybindings.matches(data, "tui.select.confirm")) {
			const item = items[this.selected];
			if (item?.enabled !== undefined) this.onToggle(this.tab, item.id);
			return;
		}
		if (data === "S" && this.tab === "extensions") {
			this.onDone("save");
			return;
		}
		const before = this.search.getValue();
		this.search.handleInput(data);
		if (before !== this.search.getValue()) this.selected = 0;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const snapshot = this.getSnapshot();
		const items = this.filteredItems();
		this.selected = Math.min(this.selected, Math.max(0, items.length - 1));
		const maxVisible = Math.max(
			5,
			Math.min(14, (process.stdout.rows ?? 24) - 12),
		);
		const start = Math.max(
			0,
			Math.min(
				this.selected - Math.floor(maxVisible / 2),
				items.length - maxVisible,
			),
		);
		const end = Math.min(items.length, start + maxVisible);
		const tabs = TABS.map((tab) => {
			const label = LABELS[tab];
			return tab === this.tab
				? this.theme.fg("accent", this.theme.bold(`[${label}]`))
				: this.theme.fg("muted", label);
		}).join("  ");
		const lines = [
			truncateToWidth(
				this.theme.fg("accent", this.theme.bold("Pi Config Manager")),
				safeWidth,
			),
			truncateToWidth(
				snapshot.ready
					? tabs
					: `${tabs}  ${this.theme.fg("warning", "loading resources…")}`,
				safeWidth,
			),
			truncateToWidth(`> ${this.search.getValue()}`, safeWidth, ""),
			"",
		];
		if (items.length === 0) {
			lines.push(this.theme.fg("muted", "  No matching resources"));
		} else {
			for (let index = start; index < end; index += 1) {
				const item = items[index]!;
				const cursor =
					index === this.selected ? this.theme.fg("accent", "> ") : "  ";
				const check =
					item.enabled === undefined
						? "  "
						: item.enabled
							? this.theme.fg("success", "● ")
							: this.theme.fg("dim", "○ ");
				const pending =
					this.tab === "extensions" && this.stagedExtensions.has(item.id)
						? this.theme.fg("warning", " staged")
						: "";
				lines.push(
					truncateToWidth(
						`${cursor}${check}${item.label}${this.theme.fg("dim", `  ${item.state}`)}${pending}`,
						safeWidth,
					),
				);
			}
			const item = items[this.selected];
			if (item) {
				lines.push("");
				for (const rawLine of item.detail.split("\n")) {
					for (const wrapped of wrapTextWithAnsi(
						rawLine,
						Math.max(1, safeWidth - 4),
					)) {
						lines.push(
							truncateToWidth(this.theme.fg("dim", `  ${wrapped}`), safeWidth),
						);
					}
				}
			}
		}
		const saveHint = this.tab === "extensions" ? " · S save + reload" : "";
		lines.push(
			"",
			truncateToWidth(
				this.theme.fg(
					"dim",
					`Type search · ←/→/Tab tabs · ↑/↓ move · Space toggle${saveHint} · Esc close`,
				),
				safeWidth,
			),
		);
		return lines;
	}

	private allItems(): ViewItem[] {
		const snapshot = this.getSnapshot();
		if (this.tab === "overview") {
			return [
				{
					id: "tools",
					label: "Tools",
					state: `${snapshot.activeTools.size}/${snapshot.tools.length}`,
					detail: "Pi-discovered tools and their effective active state.",
				},
				{
					id: "skills",
					label: "Skills",
					state: `${snapshot.enabledSkills.size}/${snapshot.skills.length}`,
					detail: "Pi-loaded skills exposed to the model.",
				},
				{
					id: "contexts",
					label: "Contexts",
					state: snapshot.contextsKnown
						? `${snapshot.enabledContexts.size}/${snapshot.contexts.length}`
						: "loading",
					detail: "Pi-loaded context files exposed to the model.",
				},
				{
					id: "extensions",
					label: "Extensions",
					state: snapshot.extensionsKnown
						? `${snapshot.extensions.filter((item) => item.enabled).length}/${snapshot.extensions.length}`
						: "loading",
					detail: "Pi-resolved extension resources. Changes require reload.",
				},
			];
		}
		if (this.tab === "tools")
			return snapshot.tools.map((tool) => ({
				id: tool.name,
				label: tool.name,
				enabled: snapshot.activeTools.has(tool.name),
				state: snapshot.activeTools.has(tool.name) ? "active" : "inactive",
				detail: `${tool.description}\n${sourceDetail(tool.sourceInfo)}`,
			}));
		if (this.tab === "skills")
			return snapshot.skills.map((skill) => ({
				id: skill.name,
				label: skill.name,
				enabled: snapshot.enabledSkills.has(skill.name),
				state: snapshot.enabledSkills.has(skill.name) ? "enabled" : "disabled",
				detail: `${skill.description}\n${skill.path}`,
			}));
		if (this.tab === "contexts")
			return snapshot.contexts.map((context) => ({
				id: context.path,
				label: basename(context.path),
				enabled: snapshot.enabledContexts.has(context.path),
				state: snapshot.enabledContexts.has(context.path)
					? "enabled"
					: "disabled",
				detail: context.path,
			}));
		return snapshot.extensions.map((extension) => {
			const staged = this.stagedExtensions.get(extension.path);
			const enabled = staged?.enabled ?? extension.enabled;
			return {
				id: extension.path,
				label: basename(extension.path),
				enabled,
				state: enabled ? "enabled" : "disabled",
				detail: `${extension.metadata.scope}/${extension.metadata.origin} · ${extension.metadata.source}\n${extension.path}`,
			};
		});
	}

	private filteredItems(): ViewItem[] {
		const query = this.search.getValue().trim().toLowerCase();
		const items = this.allItems();
		return query
			? items.filter((item) =>
					`${item.label} ${item.state} ${item.detail}`
						.toLowerCase()
						.includes(query),
				)
			: items;
	}

	private changeTab(offset: number): void {
		const index = TABS.indexOf(this.tab);
		this.tab = TABS[(index + offset + TABS.length) % TABS.length] ?? "overview";
		this.selected = 0;
	}
}

export default function piConfigManager(pi: ExtensionAPI) {
	let globalSettings: ResourceSettings = loadGlobalSettings();
	let projectSettings: ResourceSettings = loadProjectSettings(
		process.cwd(),
		false,
	);
	let sessionState: SessionResourceState = cloneSessionState(
		DEFAULT_SESSION_STATE,
	);
	let presetTools: string[] | undefined;
	let presetSkills: Set<string> | undefined;
	let defaultTools = new Set<string>();
	let externalTools = new Set<string>();
	let lastAppliedTools = new Set<string>();
	let hasAppliedTools = false;
	const runtimeLayers = new Map<string, RuntimeLayer>();
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let requestHudRender: (() => void) | undefined;
	const promptWarnings = new Set<"skills" | "contexts">();
	let snapshot: ManagerSnapshot = {
		ready: false,
		contextsKnown: false,
		extensionsKnown: false,
		tools: [],
		activeTools: new Set(),
		skills: [],
		enabledSkills: new Set(),
		contexts: [],
		enabledContexts: new Set(),
		extensions: [],
	};

	function persistSession(): void {
		pi.appendEntry(SESSION_ENTRY, cloneSessionState(sessionState));
	}

	function restoreSession(ctx: ExtensionContext): void {
		sessionState = cloneSessionState(DEFAULT_SESSION_STATE);
		const branch = ctx.sessionManager.getBranch();
		const hasUnifiedState = branch.some(
			(entry) => entry.type === "custom" && entry.customType === SESSION_ENTRY,
		);
		for (const entry of branch) {
			if (entry.type !== "custom") continue;
			if (entry.customType === SESSION_ENTRY) {
				const restored = normalizeSessionState(entry.data);
				if (restored) sessionState = restored;
			}
			if (!hasUnifiedState && entry.customType === "tools-config") {
				const tools = (entry.data as { enabledTools?: unknown } | undefined)
					?.enabledTools;
				if (Array.isArray(tools))
					sessionState.tools = unique(
						tools.filter((item): item is string => typeof item === "string"),
					);
			}
			if (!hasUnifiedState && entry.customType === "skills-manager-state") {
				const data = entry.data as any;
				if (data?.mode === "reset") {
					sessionState.enabledSkills = [];
					sessionState.disabledSkills = [];
				} else if (data?.mode === "override") {
					sessionState.enabledSkills = unique(data.enabledSkills ?? []);
					sessionState.disabledSkills = unique(data.disabledSkills ?? []);
				}
			}
		}
	}

	function discoveredToolNames(): Set<string> {
		return new Set(snapshot.tools.map((tool) => tool.name));
	}

	function resolveBaseTools(): Set<string> {
		const discovered = discoveredToolNames();
		const globallyDisabled = new Set([
			...globalSettings.disabledTools,
			...projectSettings.disabledTools,
		]);
		return new Set(
			(
				sessionState.tools ??
				presetTools ??
				Array.from(defaultTools).filter((name) => !globallyDisabled.has(name))
			).filter((name) => discovered.has(name)),
		);
	}

	function reconcileTools(): void {
		const discovered = discoveredToolNames();
		let effective = resolveBaseTools();
		for (const name of externalTools)
			if (discovered.has(name)) effective.add(name);
		for (const layer of runtimeLayers.values()) {
			for (const name of layer.disableTools) effective.delete(name);
			for (const name of layer.requireTools)
				if (discovered.has(name)) effective.add(name);
		}
		effective = new Set(
			Array.from(effective).filter((name) => discovered.has(name)),
		);
		pi.setActiveTools(Array.from(effective));
		lastAppliedTools = new Set(pi.getActiveTools());
		hasAppliedTools = true;
		snapshot = { ...snapshot, activeTools: new Set(lastAppliedTools) };
		requestHudRender?.();
		pi.events.emit("config-manager:state-changed", publicSnapshot());
	}

	function resolveEnabledSkills(skills: SkillRecord[]): Set<string> {
		const globalDisabled = new Set([
			...globalSettings.disabledSkills,
			...projectSettings.disabledSkills,
		]);
		const enabled = new Set<string>();
		for (const skill of skills) {
			const base = presetSkills
				? presetSkills.has(skill.name)
				: !globalDisabled.has(skill.name);
			if (base) enabled.add(skill.name);
		}
		for (const name of sessionState.disabledSkills) enabled.delete(name);
		for (const name of sessionState.enabledSkills)
			if (skills.some((skill) => skill.name === name)) enabled.add(name);
		return enabled;
	}

	function resolveEnabledContexts(contexts: ContextRecord[]): Set<string> {
		const disabled = new Set([
			...globalSettings.disabledContexts,
			...projectSettings.disabledContexts,
		]);
		const enabled = new Set(
			contexts
				.map((context) => context.path)
				.filter((path) => !disabled.has(path)),
		);
		for (const path of sessionState.disabledContexts) enabled.delete(path);
		for (const path of sessionState.enabledContexts)
			if (contexts.some((context) => context.path === path)) enabled.add(path);
		return enabled;
	}

	function updateToolsInventory(): void {
		if (hasAppliedTools) {
			for (const name of pi.getActiveTools()) {
				if (!lastAppliedTools.has(name)) externalTools.add(name);
			}
		}
		snapshot = {
			...snapshot,
			tools: pi
				.getAllTools()
				.map((tool) => ({
					name: tool.name,
					description: tool.description,
					sourceInfo: tool.sourceInfo,
				}))
				.sort((a, b) => a.name.localeCompare(b.name)),
		};
		reconcileTools();
	}

	function updatePromptInventory(options: BuildSystemPromptOptions): void {
		const skills: SkillRecord[] = (options.skills ?? [])
			.map((skill: any) => ({
				name: skill.name,
				description: skill.description ?? "No description",
				path: skill.path ?? skill.filePath ?? "Path unavailable",
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
		const contexts: ContextRecord[] = (options.contextFiles ?? []).map(
			(file) => ({ path: file.path, content: file.content }),
		);
		snapshot = {
			...snapshot,
			ready: true,
			skills,
			enabledSkills: resolveEnabledSkills(skills),
			contextsKnown: true,
			contexts,
			enabledContexts: resolveEnabledContexts(contexts),
		};
		requestHudRender?.();
	}

	async function refreshExtensions(ctx: ExtensionContext): Promise<void> {
		try {
			const extensions = await resolveExtensions(
				ctx.cwd,
				ctx.isProjectTrusted(),
			);
			snapshot = { ...snapshot, extensionsKnown: true, extensions };
			requestHudRender?.();
		} catch (error) {
			ctx.ui.notify(
				`Could not resolve extensions: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}

	function refreshSkillsFromCommands(): void {
		const skills = pi
			.getCommands()
			.filter((command) => command.source === "skill")
			.map((command) => ({
				name: command.name.replace(/^skill:/, ""),
				description: command.description ?? "No description",
				path: command.sourceInfo.path,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
		snapshot = {
			...snapshot,
			ready: true,
			skills,
			enabledSkills: resolveEnabledSkills(skills),
		};
		requestHudRender?.();
	}

	function scheduleSettledRefresh(ctx: ExtensionContext): void {
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			settleTimer = undefined;
			updateToolsInventory();
			refreshSkillsFromCommands();
			void refreshExtensions(ctx);
		}, 500);
	}

	function publicSnapshot() {
		return {
			ready: snapshot.ready,
			baseTools: Array.from(resolveBaseTools()),
			tools: {
				active: snapshot.activeTools.size,
				total: snapshot.tools.length,
			},
			skills: {
				enabled: snapshot.enabledSkills.size,
				total: snapshot.skills.length,
			},
			contexts: {
				enabled: snapshot.enabledContexts.size,
				total: snapshot.contexts.length,
			},
			extensions: {
				enabled: snapshot.extensions.filter((item) => item.enabled).length,
				total: snapshot.extensions.length,
			},
		};
	}

	function toggleSessionResource(tab: ResourceTab, id: string): void {
		if (tab === "tools") {
			const wasEffective = snapshot.activeTools.has(id);
			externalTools.delete(id);
			const base = resolveBaseTools();
			if (wasEffective) base.delete(id);
			else base.add(id);
			sessionState.tools = unique(base);
			reconcileTools();
			persistSession();
			pi.events.emit("tools:changed", { tools: sessionState.tools });
			return;
		}
		if (tab === "skills") {
			const enabled = snapshot.enabledSkills.has(id);
			sessionState.enabledSkills = sessionState.enabledSkills.filter(
				(name) => name !== id,
			);
			sessionState.disabledSkills = sessionState.disabledSkills.filter(
				(name) => name !== id,
			);
			if (enabled) sessionState.disabledSkills.push(id);
			else sessionState.enabledSkills.push(id);
			sessionState.enabledSkills = unique(sessionState.enabledSkills);
			sessionState.disabledSkills = unique(sessionState.disabledSkills);
			snapshot = {
				...snapshot,
				enabledSkills: resolveEnabledSkills(snapshot.skills),
			};
			persistSession();
			requestHudRender?.();
			return;
		}
		if (tab === "contexts") {
			const enabled = snapshot.enabledContexts.has(id);
			sessionState.enabledContexts = sessionState.enabledContexts.filter(
				(path) => path !== id,
			);
			sessionState.disabledContexts = sessionState.disabledContexts.filter(
				(path) => path !== id,
			);
			if (enabled) sessionState.disabledContexts.push(id);
			else sessionState.enabledContexts.push(id);
			sessionState.enabledContexts = unique(sessionState.enabledContexts);
			sessionState.disabledContexts = unique(sessionState.disabledContexts);
			snapshot = {
				...snapshot,
				enabledContexts: resolveEnabledContexts(snapshot.contexts),
			};
			persistSession();
			requestHudRender?.();
		}
	}

	function setGlobalResource(
		kind: "tools" | "skills" | "contexts",
		name: string,
		enabled: boolean,
		ctx: ExtensionContext,
	): void {
		const key =
			kind === "tools"
				? "disabledTools"
				: kind === "skills"
					? "disabledSkills"
					: "disabledContexts";
		const values = new Set(globalSettings[key]);
		if (enabled) values.delete(name);
		else values.add(name);
		globalSettings = { ...globalSettings, [key]: unique(values) };
		saveGlobalSettings(globalSettings);
		updateToolsInventory();
		snapshot = {
			...snapshot,
			enabledSkills: resolveEnabledSkills(snapshot.skills),
			enabledContexts: resolveEnabledContexts(snapshot.contexts),
		};
		ctx.ui.notify(
			`Global ${kind} setting updated: ${name} ${enabled ? "enabled" : "disabled"}`,
			"info",
		);
		requestHudRender?.();
	}

	async function showManager(
		initialTab: ResourceTab,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Pi Config Manager requires TUI mode", "error");
			return;
		}
		updatePromptInventory(ctx.getSystemPromptOptions());
		updateToolsInventory();
		await refreshExtensions(ctx);
		const staged = new Map<string, ExtensionChange>();
		const action = await ctx.ui.custom<"close" | "save">(
			(tui, theme, keybindings, done) =>
				new ConfigManagerView(
					initialTab,
					() => snapshot,
					staged,
					theme,
					keybindings,
					(tab, id) => {
						if (tab === "extensions") {
							const resource = snapshot.extensions.find(
								(item) => item.path === id,
							);
							if (!resource) return;
							if (resource.path.includes("pi-config-manager")) {
								ctx.ui.notify(
									"Pi Config Manager cannot disable itself from the active manager.",
									"warning",
								);
								return;
							}
							if (isDirectFilePackage(resource, ctx.cwd)) {
								ctx.ui.notify(
									"Pi does not support per-extension filters for a package source that directly names one extension file.",
									"warning",
								);
								return;
							}
							const current = staged.get(id)?.enabled ?? resource.enabled;
							staged.set(id, { resource, enabled: !current });
						} else toggleSessionResource(tab, id);
						tui.requestRender();
					},
					done,
				),
		);
		if (action !== "save" || staged.size === 0) return;
		const confirmed = await ctx.ui.confirm(
			"Save extension changes?",
			"Extension changes require Pi to reload. Save and reload now?",
		);
		if (!confirmed) return;
		try {
			await saveExtensionChanges(
				ctx.cwd,
				ctx.isProjectTrusted(),
				Array.from(staged.values()),
			);
			await ctx.reload();
		} catch (error) {
			ctx.ui.notify(
				`Could not save extension settings: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}

	function installHud(ctx: ExtensionContext): void {
		ctx.ui.setWidget("pi-config-manager", (tui, theme) => {
			requestHudRender = () => tui.requestRender();
			return {
				render(width: number) {
					if (!snapshot.ready)
						return [
							truncateToWidth(
								theme.fg("dim", "Resources · loading…"),
								Math.max(1, width),
							),
						];
					const first = truncateToWidth(
						theme.fg("accent", theme.bold("Resources")),
						Math.max(1, width),
					);
					const contextCount = snapshot.contextsKnown
						? `${snapshot.enabledContexts.size}/${snapshot.contexts.length}`
						: "…";
					const extensionCount = snapshot.extensionsKnown
						? `${snapshot.extensions.filter((item) => item.enabled).length}/${snapshot.extensions.length}`
						: "…";
					const second = `  tools ${snapshot.activeTools.size}/${snapshot.tools.length} · skills ${snapshot.enabledSkills.size}/${snapshot.skills.length} · contexts ${contextCount}`;
					const third = `  extensions ${extensionCount}${snapshot.presetName ? ` · preset ${snapshot.presetName}` : ""}`;
					return [
						first,
						truncateToWidth(theme.fg("muted", second), width),
						truncateToWidth(theme.fg("dim", third), width),
					];
				},
				invalidate() {},
			};
		});
	}

	function registerResourceCommand(
		name: string,
		tab: ResourceTab,
		kind: "tools" | "skills" | "contexts",
	) {
		pi.registerCommand(name, {
			description: `Manage ${name} through Pi Config Manager`,
			handler: async (args, ctx) => {
				const parts = args.trim().split(/\s+/).filter(Boolean);
				if (
					parts[0] === "global" &&
					(parts[1] === "enable" || parts[1] === "disable") &&
					parts[2]
				) {
					setGlobalResource(
						kind,
						parts.slice(2).join(" "),
						parts[1] === "enable",
						ctx,
					);
					return;
				}
				await showManager(tab, ctx);
			},
		});
	}

	pi.registerCommand("config-manager", {
		description: "Manage Pi tools, skills, contexts, and extensions",
		handler: async (_args, ctx) => showManager("overview", ctx),
	});
	pi.registerCommand("sidebar", {
		description: "Open Pi resource overview",
		handler: async (_args, ctx) => showManager("overview", ctx),
	});
	registerResourceCommand("tools", "tools", "tools");
	registerResourceCommand("skills", "skills", "skills");
	registerResourceCommand("contexts", "contexts", "contexts");
	pi.registerCommand("extensions", {
		description: "Manage Pi extensions",
		handler: async (_args, ctx) => showManager("extensions", ctx),
	});

	pi.events.on("preset:tools-changed", (event) => {
		const data = event as {
			tools?: unknown;
			resetSessionOverride?: unknown;
			clearPreset?: unknown;
		};
		const tools = Array.isArray(data.tools)
			? unique(
					data.tools.filter((item): item is string => typeof item === "string"),
				)
			: undefined;
		if (data.clearPreset === true) {
			presetTools = undefined;
			sessionState.tools = tools;
		} else {
			presetTools = tools;
			if (data.resetSessionOverride === true) sessionState.tools = undefined;
		}
		updateToolsInventory();
		persistSession();
	});
	pi.events.on("preset:skills-changed", (event) => {
		const data = event as { skills?: unknown; resetSessionOverride?: unknown };
		presetSkills = Array.isArray(data.skills)
			? new Set(
					data.skills.filter(
						(item): item is string => typeof item === "string",
					),
				)
			: undefined;
		if (data.resetSessionOverride === true) {
			sessionState.enabledSkills = [];
			sessionState.disabledSkills = [];
		}
		snapshot = {
			...snapshot,
			enabledSkills: resolveEnabledSkills(snapshot.skills),
		};
		persistSession();
		requestHudRender?.();
	});
	pi.events.on("config-manager:preset-state", (event) => {
		const name = (event as { name?: unknown }).name;
		snapshot = {
			...snapshot,
			presetName: typeof name === "string" ? name : undefined,
		};
		requestHudRender?.();
	});
	pi.events.on("config-manager:layer-set", (event) => {
		const data = event as Partial<RuntimeLayer>;
		if (typeof data.id !== "string") return;
		runtimeLayers.set(data.id, {
			id: data.id,
			disableTools: unique(data.disableTools ?? []),
			requireTools: unique(data.requireTools ?? []),
		});
		reconcileTools();
	});
	pi.events.on("config-manager:layer-clear", (event) => {
		const id = (event as { id?: unknown }).id;
		if (typeof id !== "string") return;
		runtimeLayers.delete(id);
		reconcileTools();
	});
	pi.events.on("config-manager:request-snapshot", () => {
		pi.events.emit("config-manager:state-changed", publicSnapshot());
	});

	pi.on("input", (event, ctx) => {
		if (event.text.startsWith("/skill:")) refreshSkillsFromCommands();
		const match = event.text.match(/^\/skill:([^\s]+)/);
		const name = match?.[1];
		if (
			!name ||
			!snapshot.skills.some((skill) => skill.name === name) ||
			snapshot.enabledSkills.has(name)
		)
			return;
		ctx.ui.notify(
			`Skill "${name}" is disabled. Use /skills to enable it.`,
			"warning",
		);
		return { action: "handled" };
	});

	pi.on("before_agent_start", (event, ctx) => {
		updatePromptInventory(event.systemPromptOptions);
		updateToolsInventory();
		const originalSkills = formatSkillsForPrompt(
			event.systemPromptOptions.skills ?? [],
		);
		const filteredSkills = formatSkillsForPrompt(
			(event.systemPromptOptions.skills ?? []).filter((skill) =>
				snapshot.enabledSkills.has(skill.name),
			),
		);
		const originalContexts = formatContextSection(snapshot.contexts);
		const filteredContexts = formatContextSection(
			snapshot.contexts.filter((context) =>
				snapshot.enabledContexts.has(context.path),
			),
		);
		let systemPrompt = event.systemPrompt;
		const readAvailable =
			!event.systemPromptOptions.selectedTools ||
			event.systemPromptOptions.selectedTools.includes("read");
		if (originalSkills && systemPrompt.includes(originalSkills)) {
			systemPrompt = systemPrompt.replace(originalSkills, filteredSkills);
		} else if (
			readAvailable &&
			originalSkills &&
			filteredSkills !== originalSkills &&
			!promptWarnings.has("skills")
		) {
			promptWarnings.add("skills");
			ctx.ui.notify(
				"Disabled Skills could not be removed from this custom system prompt; leaving the prompt unchanged.",
				"warning",
			);
		}
		if (originalContexts && systemPrompt.includes(originalContexts)) {
			systemPrompt = systemPrompt.replace(originalContexts, filteredContexts);
		} else if (
			originalContexts &&
			filteredContexts !== originalContexts &&
			!promptWarnings.has("contexts")
		) {
			promptWarnings.add("contexts");
			ctx.ui.notify(
				"Disabled Context Files could not be removed from this custom system prompt; leaving the prompt unchanged.",
				"warning",
			);
		}
		return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
	});

	pi.on("turn_start", () => {
		updateToolsInventory();
	});

	pi.on("session_start", (_event, ctx) => {
		promptWarnings.clear();
		defaultTools = new Set(pi.getActiveTools());
		externalTools = new Set();
		lastAppliedTools = new Set();
		hasAppliedTools = false;
		globalSettings = loadGlobalSettings();
		projectSettings = loadProjectSettings(ctx.cwd, ctx.isProjectTrusted());
		restoreSession(ctx);
		snapshot = {
			...snapshot,
			ready: false,
			contextsKnown: false,
			extensionsKnown: false,
			skills: [],
			contexts: [],
			extensions: [],
		};
		updateToolsInventory();
		refreshSkillsFromCommands();
		installHud(ctx);
		scheduleSettledRefresh(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		externalTools = new Set();
		restoreSession(ctx);
		updateToolsInventory();
		snapshot = {
			...snapshot,
			enabledSkills: resolveEnabledSkills(snapshot.skills),
			enabledContexts: resolveEnabledContexts(snapshot.contexts),
		};
		requestHudRender?.();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = undefined;
		ctx.ui.setWidget("pi-config-manager", undefined);
		requestHudRender = undefined;
	});
}
