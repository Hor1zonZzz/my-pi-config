import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Skill,
	SourceInfo,
} from "@earendil-works/pi-coding-agent";
import {
	formatSkillsForPrompt,
	getAgentDir,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	fuzzyFilter,
	Input,
	type KeybindingsManager,
	type SettingsListTheme,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const SETTINGS_FILE = "skill-settings.json";
const SESSION_ENTRY_TYPE = "skills-manager-state";

type SkillSetting = "enabled" | "disabled";

interface GlobalSkillsState {
	version: 1;
	disabledSkills: string[];
}

interface SessionSkillsOverride {
	version: 1;
	mode: "override";
	enabledSkills: string[];
	disabledSkills: string[];
}

interface ClearedSessionSkillsOverride {
	version: 1;
	mode: "reset";
}

type PersistedSessionSkillsState =
	| SessionSkillsOverride
	| ClearedSessionSkillsOverride;

interface PresetSkillsChangedEvent {
	skills?: unknown;
	resetSessionOverride?: unknown;
}

interface KnownSkill {
	name: string;
	sourceInfo: SourceInfo;
}

interface SkillSelectorItem {
	id: string;
	label: string;
	description: string;
	currentValue: SkillSetting;
}

interface GroupedSkillsListTheme extends SettingsListTheme {
	title: (text: string) => string;
	enabledSection: (text: string) => string;
	disabledSection: (text: string) => string;
	emptySection: (text: string) => string;
}

class GroupedSkillsList implements Component, Focusable {
	private readonly searchInput = new Input();
	private selectedId: string | undefined;

	constructor(
		private readonly title: string,
		private readonly items: SkillSelectorItem[],
		private readonly maxVisible: number,
		private readonly theme: GroupedSkillsListTheme,
		private readonly keybindings: KeybindingsManager,
		private readonly onChange: (id: string, value: SkillSetting) => void,
		private readonly onCancel: () => void,
	) {}

	get focused(): boolean {
		return this.searchInput.focused;
	}

	set focused(value: boolean) {
		this.searchInput.focused = value;
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	handleInput(data: string): void {
		const visibleItems = this.getVisibleItems();

		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(visibleItems, -1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(visibleItems, 1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.moveSelection(visibleItems, -this.maxVisible);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.moveSelection(visibleItems, this.maxVisible);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm") || data === " ") {
			this.toggleSelected(visibleItems);
			return;
		}

		const query = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		if (this.searchInput.getValue() !== query) {
			this.ensureSelection(this.getVisibleItems());
		}
	}

	render(width: number): string[] {
		const availableWidth = Math.max(1, width);
		const groups = this.getGroups();
		const visibleItems = [...groups.enabled, ...groups.disabled];
		this.ensureSelection(visibleItems);

		const lines = [
			truncateToWidth(this.theme.title(this.title), availableWidth),
			"",
			...this.searchInput.render(availableWidth),
			"",
		];

		if (visibleItems.length === 0) {
			lines.push(
				truncateToWidth(
					this.theme.hint("  No matching skills"),
					availableWidth,
				),
			);
			this.addHint(lines, availableWidth);
			return lines;
		}

		const selectedIndex = Math.max(
			0,
			visibleItems.findIndex((item) => item.id === this.selectedId),
		);
		const startIndex = Math.max(
			0,
			Math.min(
				selectedIndex - Math.floor(this.maxVisible / 2),
				visibleItems.length - this.maxVisible,
			),
		);
		const endIndex = Math.min(
			startIndex + this.maxVisible,
			visibleItems.length,
		);
		const maxLabelWidth = Math.min(
			30,
			Math.max(...visibleItems.map((item) => visibleWidth(item.label))),
		);

		this.renderGroup(
			lines,
			"Enabled",
			groups.enabled,
			0,
			startIndex,
			endIndex,
			maxLabelWidth,
			availableWidth,
		);
		this.renderGroup(
			lines,
			"Disabled",
			groups.disabled,
			groups.enabled.length,
			startIndex,
			endIndex,
			maxLabelWidth,
			availableWidth,
		);

		if (startIndex > 0 || endIndex < visibleItems.length) {
			lines.push(
				truncateToWidth(
					this.theme.hint(`  (${selectedIndex + 1}/${visibleItems.length})`),
					availableWidth,
				),
			);
		}

		const selectedItem = visibleItems[selectedIndex];
		if (selectedItem) {
			lines.push("");
			for (const line of wrapTextWithAnsi(
				selectedItem.description,
				Math.max(1, availableWidth - 4),
			)) {
				lines.push(
					truncateToWidth(this.theme.description(`  ${line}`), availableWidth),
				);
			}
		}

		this.addHint(lines, availableWidth);
		return lines;
	}

	private getGroups(): {
		enabled: SkillSelectorItem[];
		disabled: SkillSelectorItem[];
	} {
		const query = this.searchInput.getValue();
		const matchingItems = query
			? fuzzyFilter(this.items, query, (item) => item.label)
			: this.items;
		return {
			enabled: matchingItems.filter((item) => item.currentValue === "enabled"),
			disabled: matchingItems.filter(
				(item) => item.currentValue === "disabled",
			),
		};
	}

	private getVisibleItems(): SkillSelectorItem[] {
		const groups = this.getGroups();
		return [...groups.enabled, ...groups.disabled];
	}

	private ensureSelection(items: SkillSelectorItem[]): void {
		if (items.length === 0) {
			this.selectedId = undefined;
			return;
		}
		if (!items.some((item) => item.id === this.selectedId)) {
			this.selectedId = items[0]?.id;
		}
	}

	private moveSelection(items: SkillSelectorItem[], offset: number): void {
		if (items.length === 0) return;
		this.ensureSelection(items);
		const currentIndex = Math.max(
			0,
			items.findIndex((item) => item.id === this.selectedId),
		);
		this.selectedId =
			items[(currentIndex + offset + items.length) % items.length]?.id;
	}

	private toggleSelected(items: SkillSelectorItem[]): void {
		this.ensureSelection(items);
		const selectedItem = items.find((item) => item.id === this.selectedId);
		if (!selectedItem) return;

		const nextValue: SkillSetting =
			selectedItem.currentValue === "enabled" ? "disabled" : "enabled";
		selectedItem.currentValue = nextValue;
		this.onChange(selectedItem.id, nextValue);
	}

	private renderGroup(
		lines: string[],
		label: "Enabled" | "Disabled",
		items: SkillSelectorItem[],
		offset: number,
		startIndex: number,
		endIndex: number,
		maxLabelWidth: number,
		width: number,
	): void {
		const sectionTheme =
			label === "Enabled"
				? this.theme.enabledSection
				: this.theme.disabledSection;
		lines.push(
			truncateToWidth(sectionTheme(`${label} (${items.length})`), width),
		);

		if (items.length === 0) {
			lines.push(truncateToWidth(this.theme.emptySection("  (none)"), width));
			return;
		}

		for (const [index, item] of items.entries()) {
			const absoluteIndex = offset + index;
			if (absoluteIndex < startIndex || absoluteIndex >= endIndex) continue;

			const isSelected = item.id === this.selectedId;
			const prefix = isSelected ? this.theme.cursor : "  ";
			const labelPadded =
				item.label +
				" ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
			const separator = "  ";
			const valueWidth = Math.max(
				1,
				width -
					visibleWidth(prefix) -
					maxLabelWidth -
					visibleWidth(separator) -
					2,
			);
			const value = this.theme.value(
				truncateToWidth(item.currentValue, valueWidth, ""),
				isSelected,
			);
			lines.push(
				truncateToWidth(
					prefix +
						this.theme.label(labelPadded, isSelected) +
						separator +
						value,
					width,
				),
			);
		}
	}

	private addHint(lines: string[], width: number): void {
		lines.push("");
		lines.push(
			truncateToWidth(
				this.theme.hint(
					"  Type to search · Enter/Space to change · Esc to cancel",
				),
				width,
			),
		);
	}
}

function uniqueStrings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return Array.from(
		new Set(value.filter((item): item is string => typeof item === "string")),
	);
}

function readGlobalState(): GlobalSkillsState {
	const path = join(getAgentDir(), SETTINGS_FILE);
	if (!existsSync(path)) {
		return { version: 1, disabledSkills: [] };
	}

	try {
		const parsed = JSON.parse(
			readFileSync(path, "utf8"),
		) as Partial<GlobalSkillsState>;
		return {
			version: 1,
			disabledSkills: uniqueStrings(parsed.disabledSkills),
		};
	} catch (error) {
		console.error(`Failed to load ${path}: ${error}`);
		return { version: 1, disabledSkills: [] };
	}
}

function writeGlobalState(state: GlobalSkillsState): void {
	const path = join(getAgentDir(), SETTINGS_FILE);
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(
		temporaryPath,
		`${JSON.stringify(
			{
				version: 1,
				disabledSkills: Array.from(new Set(state.disabledSkills)).sort(),
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	renameSync(temporaryPath, path);
}

function parseSessionState(value: unknown): SessionSkillsOverride | undefined {
	if (!value || typeof value !== "object") return undefined;
	const state = value as Partial<SessionSkillsOverride>;
	if (state.version !== 1 || state.mode !== "override") return undefined;
	return {
		version: 1,
		mode: "override",
		enabledSkills: uniqueStrings(state.enabledSkills),
		disabledSkills: uniqueStrings(state.disabledSkills),
	};
}

export default function skillsManagerExtension(pi: ExtensionAPI) {
	let globalState = readGlobalState();
	let sessionOverride: SessionSkillsOverride | undefined;
	let presetSkills: Set<string> | undefined;
	let activeContext: ExtensionContext | undefined;

	function getKnownSkills(): KnownSkill[] {
		return pi.getCommands().flatMap((command) =>
			command.source === "skill"
				? [
						{
							name: command.name.slice("skill:".length),
							sourceInfo: command.sourceInfo,
						},
					]
				: [],
		);
	}

	function formatSkillSource(skill: KnownSkill): string {
		const { origin, path, scope, source } = skill.sourceInfo;
		const provenance =
			origin === "package" ? `${scope}/package · ${source}` : scope;
		return `${provenance} · ${path}`;
	}

	function isEnabledByBaseState(name: string): boolean {
		if (presetSkills) return presetSkills.has(name);
		return !globalState.disabledSkills.includes(name);
	}

	function isSkillEnabled(name: string): boolean {
		if (sessionOverride?.enabledSkills.includes(name)) return true;
		if (sessionOverride?.disabledSkills.includes(name)) return false;
		return isEnabledByBaseState(name);
	}

	function getEffectiveSkillNames(names: Iterable<string>): Set<string> {
		return new Set(Array.from(names).filter((name) => isSkillEnabled(name)));
	}

	function persistSessionOverride(): void {
		if (
			!sessionOverride ||
			(sessionOverride.enabledSkills.length === 0 &&
				sessionOverride.disabledSkills.length === 0)
		) {
			sessionOverride = undefined;
			pi.appendEntry<PersistedSessionSkillsState>(SESSION_ENTRY_TYPE, {
				version: 1,
				mode: "reset",
			});
			return;
		}

		pi.appendEntry<SessionSkillsOverride>(SESSION_ENTRY_TYPE, sessionOverride);
	}

	function clearSessionOverride(): void {
		sessionOverride = undefined;
		persistSessionOverride();
	}

	function setSessionSkill(name: string, setting: SkillSetting): void {
		const enabled = new Set(sessionOverride?.enabledSkills ?? []);
		const disabled = new Set(sessionOverride?.disabledSkills ?? []);
		const enabledByBaseState = isEnabledByBaseState(name);

		if (setting === "enabled") {
			disabled.delete(name);
			if (enabledByBaseState) {
				enabled.delete(name);
			} else {
				enabled.add(name);
			}
		} else {
			enabled.delete(name);
			if (enabledByBaseState) {
				disabled.add(name);
			} else {
				disabled.delete(name);
			}
		}

		sessionOverride = {
			version: 1,
			mode: "override",
			enabledSkills: Array.from(enabled).sort(),
			disabledSkills: Array.from(disabled).sort(),
		};
		persistSessionOverride();
	}

	function setGlobalSkill(name: string, setting: SkillSetting): void {
		const disabled = new Set(globalState.disabledSkills);
		if (setting === "enabled") {
			disabled.delete(name);
		} else {
			disabled.add(name);
		}
		globalState = { version: 1, disabledSkills: Array.from(disabled).sort() };
		writeGlobalState(globalState);
	}

	function restoreSessionOverride(ctx: ExtensionContext): void {
		sessionOverride = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== SESSION_ENTRY_TYPE) {
				continue;
			}

			const data = entry.data as
				| Partial<PersistedSessionSkillsState>
				| undefined;
			if (data?.version !== 1) continue;
			if (data.mode === "reset") {
				sessionOverride = undefined;
				continue;
			}

			const restored = parseSessionState(data);
			if (restored) sessionOverride = restored;
		}
	}

	function getStateLabel(): string {
		if (sessionOverride) return "session";
		if (presetSkills) return "preset";
		return "global";
	}

	function updateStatus(ctx: ExtensionContext): void {
		const color = sessionOverride || presetSkills ? "accent" : "dim";
		ctx.ui.setStatus(
			"skills-manager",
			ctx.ui.theme.fg(color, `skills: ${getStateLabel()}`),
		);
	}

	function listSkills(ctx: ExtensionContext): void {
		const skills = getKnownSkills().sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		if (skills.length === 0) {
			ctx.ui.notify("No skills are currently loaded", "warning");
			return;
		}

		const enabled = getEffectiveSkillNames(skills.map((skill) => skill.name));
		const lines = skills.map(
			(skill) =>
				`${enabled.has(skill.name) ? "enabled" : "disabled"}: ${skill.name} [${formatSkillSource(skill)}]`,
		);
		ctx.ui.notify(`Skills (${getStateLabel()}): ${lines.join("; ")}`, "info");
	}

	async function showSelector(
		ctx: ExtensionCommandContext,
		scope: "session" | "global",
	): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				`/skills ${scope === "global" ? "global " : ""}requires TUI mode`,
				"error",
			);
			return;
		}

		const skills = getKnownSkills().sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		if (skills.length === 0) {
			ctx.ui.notify("No skills are currently loaded", "warning");
			return;
		}

		const names = skills.map((skill) => skill.name);
		const selected =
			scope === "session"
				? getEffectiveSkillNames(names)
				: new Set(
						names.filter((name) => !globalState.disabledSkills.includes(name)),
					);
		const items: SkillSelectorItem[] = skills.map((skill) => ({
			id: skill.name,
			label: skill.name,
			description: formatSkillSource(skill),
			currentValue: selected.has(skill.name) ? "enabled" : "disabled",
		}));

		await ctx.ui.custom((tui, theme, keybindings, done) => {
			const selectorTheme: GroupedSkillsListTheme = {
				...getSettingsListTheme(),
				title: (text) => theme.fg("accent", theme.bold(text)),
				enabledSection: (text) => theme.fg("success", theme.bold(text)),
				disabledSection: (text) => theme.fg("muted", theme.bold(text)),
				emptySection: (text) => theme.fg("dim", text),
			};
			const title =
				scope === "session" ? "Skills (session)" : "Skills (global default)";
			const selector = new GroupedSkillsList(
				title,
				items,
				Math.min(items.length + 2, 15),
				selectorTheme,
				keybindings,
				(id, setting) => {
					if (scope === "session") {
						setSessionSkill(id, setting);
					} else {
						setGlobalSkill(id, setting);
					}
					if (setting === "enabled") {
						selected.add(id);
					} else {
						selected.delete(id);
					}
					if (activeContext) updateStatus(activeContext);
				},
				() => done(undefined),
			);

			return {
				get focused() {
					return selector.focused;
				},
				set focused(value: boolean) {
					selector.focused = value;
				},
				render(width: number) {
					return selector.render(width);
				},
				invalidate() {
					selector.invalidate();
				},
				handleInput(data: string) {
					selector.handleInput(data);
					tui.requestRender();
				},
			};
		});
	}

	function getArgumentCompletions(prefix: string) {
		const normalized = prefix.trim();
		const names = getKnownSkills().map((skill) => skill.name);
		if (!normalized) {
			return ["list", "enable", "disable", "reset", "global"].map((value) => ({
				value,
				label: value,
			}));
		}

		const [scope, action, ...remaining] = normalized.split(/\s+/);
		const skillPrefix =
			remaining.length > 0
				? (remaining[remaining.length - 1] ?? "")
				: (action ?? "");
		const expectsSkill =
			scope === "enable" ||
			scope === "disable" ||
			(scope === "global" && (action === "enable" || action === "disable"));
		if (!expectsSkill) return null;
		return names
			.filter((name) => name.startsWith(skillPrefix))
			.map((name) => ({ value: name, label: name }));
	}

	async function handleCommand(
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const tokens = args.trim().split(/\s+/).filter(Boolean);
		if (tokens.length === 0) {
			await showSelector(ctx, "session");
			return;
		}

		if (tokens[0] === "list") {
			listSkills(ctx);
			return;
		}

		if (tokens[0] === "reset") {
			clearSessionOverride();
			updateStatus(ctx);
			ctx.ui.notify("Session skill override cleared", "info");
			return;
		}

		const isGlobal = tokens[0] === "global";
		const [action, name] = isGlobal ? tokens.slice(1) : tokens;
		if (isGlobal && !action) {
			await showSelector(ctx, "global");
			return;
		}

		if (isGlobal && action === "list") {
			const disabled = globalState.disabledSkills.join(", ") || "(none)";
			ctx.ui.notify(`Global disabled skills: ${disabled}`, "info");
			return;
		}

		if ((action !== "enable" && action !== "disable") || !name) {
			ctx.ui.notify(
				"Usage: /skills [list|enable <name>|disable <name>|reset|global [list|enable <name>|disable <name>]]",
				"error",
			);
			return;
		}

		if (!getKnownSkills().some((skill) => skill.name === name)) {
			ctx.ui.notify(`Unknown skill: ${name}`, "error");
			return;
		}

		const setting = action as SkillSetting;
		if (isGlobal) {
			setGlobalSkill(name, setting);
			ctx.ui.notify(`Global skill default updated: ${name} ${setting}`, "info");
		} else {
			setSessionSkill(name, setting);
			ctx.ui.notify(
				`Session skill override updated: ${name} ${setting}`,
				"info",
			);
		}
		updateStatus(ctx);
	}

	pi.events.on("preset:skills-changed", (event) => {
		const data = event as PresetSkillsChangedEvent;
		presetSkills = Array.isArray(data.skills)
			? new Set(uniqueStrings(data.skills))
			: undefined;
		if (data.resetSessionOverride === true) {
			clearSessionOverride();
		}
		if (activeContext) updateStatus(activeContext);
	});

	pi.registerCommand("skills", {
		description: "Manage which skills are available to the model",
		getArgumentCompletions,
		handler: handleCommand,
	});

	pi.on("input", (event, ctx) => {
		const match = event.text.match(/^\/skill:([^\s]+)/);
		if (!match) return;

		const name = match[1];
		if (
			!getKnownSkills().some((skill) => skill.name === name) ||
			isSkillEnabled(name)
		) {
			return;
		}
		ctx.ui.notify(
			`Skill "${name}" is disabled. Use /skills enable ${name} first.`,
			"warning",
		);
		return { action: "handled" };
	});

	pi.on("before_agent_start", (event) => {
		const skills = event.systemPromptOptions.skills ?? [];
		const originalSection = formatSkillsForPrompt(skills);
		if (!originalSection) return;

		const enabledSkills = skills.filter((skill: Skill) =>
			isSkillEnabled(skill.name),
		);
		const filteredSection = formatSkillsForPrompt(enabledSkills);
		if (filteredSection === originalSection) return;

		const systemPrompt = event.systemPrompt.replace(
			originalSection,
			filteredSection,
		);
		if (systemPrompt === event.systemPrompt) return;
		return { systemPrompt };
	});

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		globalState = readGlobalState();
		restoreSessionOverride(ctx);
		updateStatus(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		activeContext = ctx;
		restoreSessionOverride(ctx);
		updateStatus(ctx);
	});
}
