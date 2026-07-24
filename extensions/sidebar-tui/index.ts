// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import * as fs from "node:fs";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	parseFrontmatter,
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

type ResourceTab = "tools" | "skills" | "extensions" | "subagents" | "context";

interface ResourceItem {
	label: string;
	state?: string;
	detail: string;
	searchText?: string;
}

interface ResourceSnapshot {
	tools: ResourceItem[];
	skills: ResourceItem[];
	extensions: ResourceItem[];
	subagents: ResourceItem[];
	context: ResourceItem[];
	promptResourcesKnown: boolean;
}

const TABS: ResourceTab[] = [
	"tools",
	"skills",
	"extensions",
	"subagents",
	"context",
];
const TAB_LABELS: Record<ResourceTab, string> = {
	tools: "Tools",
	skills: "Skills",
	extensions: "Extensions",
	subagents: "Subagents",
	context: "Context",
};

function sourceSummary(sourceInfo: any): string {
	if (!sourceInfo) return "unknown source";
	const provenance =
		sourceInfo.origin === "package"
			? `${sourceInfo.scope}/package · ${sourceInfo.source}`
			: `${sourceInfo.scope ?? "unknown"} · ${sourceInfo.source ?? "unknown"}`;
	return `${provenance} · ${sourceInfo.path ?? "unknown path"}`;
}

function readJson(filePath: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
			string,
			unknown
		>;
	} catch {
		return undefined;
	}
}

function isExtensionFile(filePath: string): boolean {
	return [".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"].includes(
		path.extname(filePath),
	);
}

function addExtensionPath(result: Set<string>, candidate: string): void {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(candidate);
	} catch {
		return;
	}
	if (stat.isFile() && isExtensionFile(candidate)) {
		result.add(path.resolve(candidate));
		return;
	}
	if (!stat.isDirectory()) return;
	for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
		const entryPath = path.join(candidate, entry.name);
		if (entry.isFile() && isExtensionFile(entryPath))
			result.add(path.resolve(entryPath));
		if (entry.isDirectory()) {
			for (const indexName of [
				"index.ts",
				"index.js",
				"index.mts",
				"index.mjs",
				"index.cts",
				"index.cjs",
			]) {
				const indexPath = path.join(entryPath, indexName);
				if (fs.existsSync(indexPath)) {
					result.add(path.resolve(indexPath));
					break;
				}
			}
		}
	}
}

function collectConfiguredExtensions(
	cwd: string,
	projectTrusted: boolean,
): Set<string> {
	const result = new Set<string>();
	const agentDir = getAgentDir();
	addExtensionPath(result, path.join(agentDir, "extensions"));

	const settingsFiles = [path.join(agentDir, "settings.json")];
	if (projectTrusted) {
		addExtensionPath(result, path.join(cwd, CONFIG_DIR_NAME, "extensions"));
		settingsFiles.push(path.join(cwd, CONFIG_DIR_NAME, "settings.json"));
	}

	for (const settingsPath of settingsFiles) {
		const settings = readJson(settingsPath);
		if (!Array.isArray(settings?.extensions)) continue;
		for (const value of settings.extensions) {
			if (typeof value !== "string") continue;
			const configuredPath = value.replace(/^[!+-]/, "");
			const resolved = path.isAbsolute(configuredPath)
				? configuredPath
				: path.resolve(path.dirname(settingsPath), configuredPath);
			addExtensionPath(result, resolved);
		}
	}
	return result;
}

function findProjectAgentsDir(cwd: string): string | undefined {
	let current = cwd;
	while (true) {
		const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function readAgents(dir: string, source: "user" | "project"): ResourceItem[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.flatMap((entry) => {
		if (
			!entry.name.endsWith(".md") ||
			(!entry.isFile() && !entry.isSymbolicLink())
		)
			return [];
		const filePath = path.join(dir, entry.name);
		try {
			const { frontmatter } = parseFrontmatter<Record<string, unknown>>(
				fs.readFileSync(filePath, "utf8"),
			);
			if (
				typeof frontmatter.name !== "string" ||
				typeof frontmatter.description !== "string"
			)
				return [];
			const model =
				typeof frontmatter.model === "string" ? ` · ${frontmatter.model}` : "";
			return [
				{
					label: frontmatter.name,
					state: source,
					detail: `${frontmatter.description}${model}\n${filePath}`,
				},
			];
		} catch {
			return [];
		}
	});
}

function displayExtensionName(filePath: string): string {
	const parent = path.basename(path.dirname(filePath));
	const base = path.basename(filePath);
	return base.startsWith("index.") ? parent : base.replace(/\.[^.]+$/, "");
}

class ResourceDashboard implements Component, Focusable {
	private readonly search = new Input();
	private activeTab: ResourceTab = "tools";
	private selectedIndex = 0;
	private _focused = false;

	constructor(
		private readonly snapshot: ResourceSnapshot,
		private readonly theme: any,
		private readonly keybindings: KeybindingsManager,
		private readonly maxVisible: number,
		private readonly onClose: () => void,
	) {}

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
			this.onClose();
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
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(
				Math.max(0, items.length - 1),
				this.selectedIndex + 1,
			);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(
				Math.max(0, items.length - 1),
				this.selectedIndex + this.maxVisible,
			);
			return;
		}
		const previous = this.search.getValue();
		this.search.handleInput(data);
		if (previous !== this.search.getValue()) this.selectedIndex = 0;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const items = this.filteredItems();
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, items.length - 1),
		);
		const start = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisible / 2),
				items.length - this.maxVisible,
			),
		);
		const end = Math.min(items.length, start + this.maxVisible);
		const tabs = TABS.map((tab) => {
			const label = `${TAB_LABELS[tab]} ${this.snapshot[tab].length}`;
			return tab === this.activeTab
				? this.theme.fg("accent", this.theme.bold(`[${label}]`))
				: this.theme.fg("muted", label);
		}).join("  ");
		const lines = [
			truncateToWidth(
				this.theme.fg("accent", this.theme.bold("Session Resources")),
				safeWidth,
			),
			truncateToWidth(tabs, safeWidth),
			truncateToWidth(`> ${this.search.getValue()}`, safeWidth, ""),
			"",
		];

		if (items.length === 0) {
			lines.push(this.theme.fg("muted", "  No matching resources"));
		} else {
			for (let index = start; index < end; index += 1) {
				const item = items[index]!;
				const selected = index === this.selectedIndex;
				const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
				const state = item.state
					? this.theme.fg(
							item.state === "active" ||
								item.state === "loaded" ||
								item.state === "observed" ||
								item.state === "available"
								? "success"
								: "dim",
							` ${item.state}`,
						)
					: "";
				lines.push(
					truncateToWidth(
						`${prefix}${selected ? this.theme.bold(item.label) : item.label}${state}`,
						safeWidth,
					),
				);
			}
			if (start > 0 || end < items.length)
				lines.push(
					this.theme.fg("dim", `  (${this.selectedIndex + 1}/${items.length})`),
				);
			const selected = items[this.selectedIndex];
			if (selected) {
				lines.push("");
				for (const detailLine of selected.detail.split("\n")) {
					for (const wrapped of wrapTextWithAnsi(
						detailLine,
						Math.max(1, safeWidth - 4),
					)) {
						lines.push(
							truncateToWidth(this.theme.fg("dim", `  ${wrapped}`), safeWidth),
						);
					}
				}
			}
		}
		lines.push(
			"",
			truncateToWidth(
				this.theme.fg(
					"dim",
					"Type to search · ←/→/Tab tabs · ↑/↓ navigate · Esc close",
				),
				safeWidth,
			),
		);
		return lines;
	}

	private filteredItems(): ResourceItem[] {
		const query = this.search.getValue().trim().toLowerCase();
		const items = this.snapshot[this.activeTab];
		if (!query) return items;
		return items.filter((item) =>
			`${item.label} ${item.state ?? ""} ${item.detail} ${item.searchText ?? ""}`
				.toLowerCase()
				.includes(query),
		);
	}

	private changeTab(offset: number): void {
		const index = TABS.indexOf(this.activeTab);
		this.activeTab =
			TABS[(index + offset + TABS.length) % TABS.length] ?? "tools";
		this.selectedIndex = 0;
	}
}

export default function sidebarTuiExtension(pi: ExtensionAPI) {
	let snapshot: ResourceSnapshot = {
		tools: [],
		skills: [],
		extensions: [],
		subagents: [],
		context: [],
		promptResourcesKnown: false,
	};
	let activeContext: ExtensionContext | undefined;
	let enabledSkillNames: Set<string> | undefined;
	let requestWidgetRender: (() => void) | undefined;

	function refresh(
		ctx: ExtensionContext,
		options?: BuildSystemPromptOptions,
	): void {
		const activeTools = new Set(pi.getActiveTools());
		const allTools = pi.getAllTools();
		const commands = pi.getCommands();
		const projectTrusted = ctx.isProjectTrusted();

		const tools = allTools
			.map((tool) => ({
				label: tool.name,
				state: activeTools.has(tool.name) ? "active" : "inactive",
				detail: `${tool.description}\n${sourceSummary(tool.sourceInfo)}`,
			}))
			.sort((a, b) => a.label.localeCompare(b.label));

		const observedExtensionPaths = new Set<string>();
		for (const command of commands) {
			if (
				command.source === "extension" &&
				command.sourceInfo?.path &&
				!command.sourceInfo.path.startsWith("<")
			) {
				observedExtensionPaths.add(path.resolve(command.sourceInfo.path));
			}
		}
		for (const tool of allTools) {
			if (
				tool.sourceInfo?.source !== "builtin" &&
				tool.sourceInfo?.source !== "sdk" &&
				tool.sourceInfo?.path &&
				!tool.sourceInfo.path.startsWith("<")
			) {
				observedExtensionPaths.add(path.resolve(tool.sourceInfo.path));
			}
		}
		const extensionPaths = collectConfiguredExtensions(ctx.cwd, projectTrusted);
		for (const observed of observedExtensionPaths) extensionPaths.add(observed);
		const extensions = Array.from(extensionPaths)
			.map((filePath) => ({
				label: displayExtensionName(filePath),
				state: observedExtensionPaths.has(filePath) ? "observed" : "configured",
				detail: `${observedExtensionPaths.has(filePath) ? "Registered a tool or command in this runtime." : "Found in an enabled extension location; Pi has no public API to confirm event-only extensions."}\n${filePath}`,
			}))
			.sort((a, b) => a.label.localeCompare(b.label));

		const subagentToolActive = activeTools.has("subagent");
		const subagents = [
			...readAgents(path.join(getAgentDir(), "agents"), "user"),
			...(projectTrusted
				? readAgents(findProjectAgentsDir(ctx.cwd) ?? "", "project")
				: []),
		]
			.map((agent) => ({
				...agent,
				state: subagentToolActive ? "available" : "tool inactive",
			}))
			.sort((a, b) => a.label.localeCompare(b.label));

		const skills = options
			? (options.skills ?? [])
					.map((skill: any) => ({
						label: skill.name,
						state: enabledSkillNames
							? enabledSkillNames.has(skill.name)
								? "active"
								: "inactive"
							: "loaded",
						detail: `${skill.description ?? "No description"}\n${skill.path ?? skill.filePath ?? "Path unavailable"}`,
					}))
					.sort((a, b) => a.label.localeCompare(b.label))
			: snapshot.skills.map((skill) => ({
					...skill,
					state: enabledSkillNames
						? enabledSkillNames.has(skill.label)
							? "active"
							: "inactive"
						: skill.state,
				}));
		const context = options
			? (options.contextFiles ?? [])
					.map((file: any) => ({
						label: path.basename(file.path),
						state: "loaded",
						detail: file.path,
					}))
					.sort((a, b) => a.detail.localeCompare(b.detail))
			: snapshot.context;

		snapshot = {
			tools,
			skills,
			extensions,
			subagents,
			context,
			promptResourcesKnown:
				options !== undefined || snapshot.promptResourcesKnown,
		};
		requestWidgetRender?.();
	}

	function installHud(ctx: ExtensionContext): void {
		ctx.ui.setWidget("sidebar-tui", (tui, theme) => {
			requestWidgetRender = () => tui.requestRender();
			return {
				render(width: number) {
					const safeWidth = Math.max(1, width);
					const activeTools = snapshot.tools.filter(
						(tool) => tool.state === "active",
					).length;
					const activeSkills = snapshot.skills.filter(
						(skill) => skill.state === "active" || skill.state === "loaded",
					).length;
					const title = theme.fg("accent", theme.bold("Resources"));
					const primary = `  tools ${activeTools}/${snapshot.tools.length} · skills ${activeSkills}/${snapshot.skills.length} · extensions ${snapshot.extensions.length}`;
					const secondary = `  subagents ${snapshot.subagents.length} · context ${snapshot.context.length}`;
					const pending = snapshot.promptResourcesKnown
						? ""
						: " · skills/context refresh on /sidebar or next turn";
					return [
						truncateToWidth(title, safeWidth),
						truncateToWidth(theme.fg("muted", primary), safeWidth),
						truncateToWidth(theme.fg("dim", secondary + pending), safeWidth),
					];
				},
				invalidate() {},
			};
		});
	}

	async function showDashboard(ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/sidebar requires TUI mode", "error");
			return;
		}
		refresh(ctx, ctx.getSystemPromptOptions());
		await ctx.ui.custom(
			(tui, theme, keybindings, done) =>
				new ResourceDashboard(
					snapshot,
					theme,
					keybindings,
					Math.max(5, Math.min(14, (process.stdout.rows ?? 24) - 12)),
					() => done(undefined),
				),
		);
	}

	pi.registerCommand("sidebar", {
		description:
			"Inspect tools, skills, extensions, subagents, and context available in this session",
		handler: async (_args, ctx) => showDashboard(ctx),
	});

	pi.events.on("tools:changed", () => {
		if (activeContext) refresh(activeContext);
	});
	pi.events.on("preset:tools-changed", () => {
		if (activeContext) refresh(activeContext);
	});
	pi.events.on("skills-manager:changed", (event) => {
		const data = event as { enabledSkills?: unknown };
		if (!Array.isArray(data.enabledSkills)) return;
		enabledSkillNames = new Set(
			data.enabledSkills.filter(
				(name): name is string => typeof name === "string",
			),
		);
		if (activeContext) refresh(activeContext);
	});

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		refresh(ctx);
		installHud(ctx);
	});
	pi.on("before_agent_start", (event, ctx) => {
		activeContext = ctx;
		refresh(ctx, event.systemPromptOptions);
	});
	pi.on("session_tree", (_event, ctx) => {
		activeContext = ctx;
		refresh(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setWidget("sidebar-tui", undefined);
		requestWidgetRender = undefined;
		activeContext = undefined;
	});
}
