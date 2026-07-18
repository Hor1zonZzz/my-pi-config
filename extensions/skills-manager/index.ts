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
} from "@earendil-works/pi-coding-agent";
import {
	formatSkillsForPrompt,
	getAgentDir,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SettingItem,
	SettingsList,
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

	function getKnownSkillNames(): string[] {
		return pi
			.getCommands()
			.filter((command) => command.source === "skill")
			.map((command) => command.name.slice("skill:".length));
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
		const names = getKnownSkillNames().sort();
		if (names.length === 0) {
			ctx.ui.notify("No skills are currently loaded", "warning");
			return;
		}

		const enabled = getEffectiveSkillNames(names);
		const lines = names.map(
			(name) => `${enabled.has(name) ? "enabled" : "disabled"}: ${name}`,
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

		const names = getKnownSkillNames().sort();
		if (names.length === 0) {
			ctx.ui.notify("No skills are currently loaded", "warning");
			return;
		}

		const selected =
			scope === "session"
				? getEffectiveSkillNames(names)
				: new Set(
						names.filter((name) => !globalState.disabledSkills.includes(name)),
					);
		const items: SettingItem[] = names.map((name) => ({
			id: name,
			label: name,
			currentValue: selected.has(name) ? "enabled" : "disabled",
			values: ["enabled", "disabled"],
		}));

		await ctx.ui.custom((tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(
				new (class {
					render(_width: number) {
						const title =
							scope === "session"
								? "Skills (session)"
								: "Skills (global default)";
						return [theme.fg("accent", theme.bold(title)), ""];
					}
					invalidate() {}
				})(),
			);

			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 2, 15),
				getSettingsListTheme(),
				(id, value) => {
					const setting = value as SkillSetting;
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
				{ enableSearch: true },
			);
			container.addChild(settingsList);

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		});
	}

	function getArgumentCompletions(prefix: string) {
		const normalized = prefix.trim();
		const names = getKnownSkillNames();
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

		if (!getKnownSkillNames().includes(name)) {
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
		if (!getKnownSkillNames().includes(name) || isSkillEnabled(name)) return;
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
