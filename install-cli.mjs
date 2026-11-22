#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const GROUPS = [
	{ id: "extensions", label: "本地扩展 (Extensions)" },
	{ id: "packages", label: "外部 Pi 包 (Packages)" },
	{ id: "prompts", label: "提示词模板 (Prompts)" },
];

export const COMPONENTS = [
	// Local extensions
	{
		id: "background-task",
		group: "extensions",
		extPath: "background-task",
		kind: "dir",
		summary: "后台任务、monitor 与 bash 自动转后台",
	},
	{
		id: "btw",
		group: "extensions",
		extPath: "btw",
		kind: "dir",
		summary: "/btw 侧边追问面板",
	},
	{
		id: "codex-statusline",
		group: "extensions",
		extPath: "codex-statusline",
		kind: "dir",
		summary: "Codex / ChatGPT 账号与周额度状态栏",
	},
	{
		id: "esc-clear",
		group: "extensions",
		extPath: "esc-clear",
		kind: "dir",
		summary: "双击 Esc 清空空闲输入框草稿",
	},
	{
		id: "herdr",
		group: "extensions",
		extPath: "herdr",
		kind: "dir",
		bundle: true,
		package: "npm:@ogulcancelik/pi-herdr",
		skills: ["herdr", "herdr-pi-reference"],
		summary: "Herdr 集成（扩展 + pi-herdr 包 + 2 个 skills）",
		details: "套装包含: extensions/herdr + npm:@ogulcancelik/pi-herdr + skills/herdr + skills/herdr-pi-reference",
	},
	{
		id: "inline-chart",
		group: "extensions",
		extPath: "inline-chart",
		kind: "dir",
		bundle: true,
		inlineChartEngine: true,
		summary: "终端内联图表（扩展 + Rust 渲染引擎）",
		details: "套装包含: extensions/inline-chart + inline-chart-engine (Rust 渲染二进制)",
	},
	{
		id: "memory",
		group: "extensions",
		extPath: "memory",
		kind: "dir",
		summary: "按项目持久化记忆与 Dream 整理",
	},
	{
		id: "notify",
		group: "extensions",
		extPath: "notify.ts",
		kind: "file",
		summary: "运行结束终端通知",
	},
	{
		id: "questionnaire",
		group: "extensions",
		extPath: "questionnaire.ts",
		kind: "file",
		summary: "交互式多问题工具",
	},
	{
		id: "tps",
		group: "extensions",
		extPath: "tps.ts",
		kind: "file",
		summary: "模型输出速度（TPS）通知",
	},
	// External Pi packages
	{
		id: "pi-annotate",
		group: "packages",
		package: "npm:pi-annotate",
		summary: "npm:pi-annotate 批注工具包",
	},
	{
		id: "pi-voice",
		group: "packages",
		package: "npm:@earendil-works/pi-voice",
		updateLatest: true,
		summary: "本地语音转文字（自动更新）",
	},
	{
		id: "pi-subagent",
		group: "packages",
		package: "git:github.com/badlogic/pi-subagent",
		updateLatest: true,
		bundle: true,
		subagentBin: true,
		summary: "tmux 子代理（包 + bin/subagent 软链，自动更新）",
		details: "套装包含: git:github.com/badlogic/pi-subagent + bin/subagent CLI 软链",
	},
	{
		id: "pi-cliproxyapi-provider",
		group: "packages",
		package: "npm:@router-for-me/pi-cliproxyapi-provider",
		updateLatest: true,
		summary: "CLIProxyAPI 模型提供方（自动更新）",
	},
	{
		id: "pi-emphasis",
		group: "packages",
		package: "git:github.com/johnlindquist/pi-emphasis",
		updateLatest: true,
		summary: "终端回复样式增强（自动更新）",
	},
	// Prompts
	{
		id: "understand",
		group: "prompts",
		promptFile: "understand.md",
		summary: "/understand 需求对齐提示词",
	},
	{
		id: "explore-understand",
		group: "prompts",
		promptFile: "explore-understand.md",
		summary: "/explore-understand 先探索仓库再需求对齐提示词",
	},
];

export const COMPONENT_MAP = new Map(COMPONENTS.map((c) => [c.id, c]));
export const ALL_COMPONENT_IDS = COMPONENTS.map((c) => c.id);
export const GROUP_IDS = new Set(GROUPS.map((g) => g.id));
export const MANAGED_PACKAGE_SOURCES = new Set(
	COMPONENTS.map((c) => c.package).filter(Boolean),
);
export const LATEST_PACKAGE_SOURCES = COMPONENTS.filter((c) => c.updateLatest).map(
	(c) => c.package,
);

function getPackageSource(entry) {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object" && typeof entry.source === "string") {
		return entry.source;
	}
	return null;
}

function pathExistsOrSymlink(targetPath) {
	try {
		lstatSync(targetPath);
		return true;
	} catch {
		return false;
	}
}

export function readInstalledSettings(agentDir) {
	const settingsPath = join(agentDir, "settings.json");
	if (!existsSync(settingsPath)) return null;
	try {
		const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

export function detectInstalled(agentDir) {
	const installed = new Set();
	const settings = readInstalledSettings(agentDir);
	const pkgSources = new Set(
		Array.isArray(settings?.packages)
			? settings.packages.map(getPackageSource).filter(Boolean)
			: [],
	);

	for (const comp of COMPONENTS) {
		let found = false;
		if (comp.extPath && pathExistsOrSymlink(join(agentDir, "extensions", comp.extPath))) {
			found = true;
		}
		if (comp.package && pkgSources.has(comp.package)) {
			found = true;
		}
		if (comp.promptFile && pathExistsOrSymlink(join(agentDir, "prompts", comp.promptFile))) {
			found = true;
		}
		if (comp.subagentBin && pathExistsOrSymlink(join(agentDir, "bin", "subagent"))) {
			found = true;
		}
		if (
			comp.skills &&
			comp.skills.some((skill) => pathExistsOrSymlink(join(agentDir, "skills", skill)))
		) {
			found = true;
		}
		if (found) installed.add(comp.id);
	}
	return installed;
}

function expandTokens(rawValues) {
	const result = [];
	const seen = new Set();
	const invalid = [];

	for (const raw of rawValues) {
		const parts = raw
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		if (parts.length === 0) {
			invalid.push("(empty)");
			continue;
		}
		for (const token of parts) {
			if (token === "all") {
				for (const id of ALL_COMPONENT_IDS) {
					if (!seen.has(id)) {
						seen.add(id);
						result.push(id);
					}
				}
			} else if (GROUP_IDS.has(token)) {
				for (const comp of COMPONENTS) {
					if (comp.group === token && !seen.has(comp.id)) {
						seen.add(comp.id);
						result.push(comp.id);
					}
				}
			} else if (COMPONENT_MAP.has(token)) {
				if (!seen.has(token)) {
					seen.add(token);
					result.push(token);
				}
			} else {
				invalid.push(token);
			}
		}
	}

	if (invalid.length > 0) {
		throw new Error(
			`未知组件或分组: ${invalid.join(", ")}\n可用分组: all, ${GROUPS.map((g) => g.id).join(", ")}\n运行 ./install.sh --list 查看所有组件 ID。`,
		);
	}
	return result;
}

export function parseCliArgs(argv) {
	const parsed = {
		command: "install",
		all: false,
		only: [],
		add: [],
		remove: [],
		exclude: [],
		yes: false,
	};

	const takeValue = (flag, index, inlineValue) => {
		if (inlineValue !== undefined) {
			if (inlineValue.length === 0) {
				throw new Error(`选项 ${flag} 需要指定至少一个组件 ID`);
			}
			return { value: inlineValue, nextIndex: index };
		}
		const next = argv[index + 1];
		if (next === undefined || next.startsWith("-")) {
			throw new Error(`选项 ${flag} 缺少参数值`);
		}
		return { value: next, nextIndex: index + 1 };
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const eqIdx = arg.indexOf("=");
		const flag = eqIdx > 0 && arg.startsWith("--") ? arg.slice(0, eqIdx) : arg;
		const inlineValue = eqIdx > 0 && arg.startsWith("--") ? arg.slice(eqIdx + 1) : undefined;

		switch (flag) {
			case "-h":
			case "--help":
				parsed.command = "help";
				return parsed;
			case "-l":
			case "--list":
				parsed.command = "list";
				return parsed;
			case "-a":
			case "--all":
				parsed.all = true;
				break;
			case "-y":
			case "--yes":
				parsed.yes = true;
				break;
			case "-o":
			case "--only":
			case "--select":
			case "--components": {
				const { value, nextIndex } = takeValue(flag, i, inlineValue);
				parsed.only.push(value);
				i = nextIndex;
				break;
			}
			case "--add": {
				const { value, nextIndex } = takeValue(flag, i, inlineValue);
				parsed.add.push(value);
				i = nextIndex;
				break;
			}
			case "--remove":
			case "--uninstall": {
				const { value, nextIndex } = takeValue(flag, i, inlineValue);
				parsed.remove.push(value);
				i = nextIndex;
				break;
			}
			case "-x":
			case "--exclude": {
				const { value, nextIndex } = takeValue(flag, i, inlineValue);
				parsed.exclude.push(value);
				i = nextIndex;
				break;
			}
			default:
				throw new Error(`未知参数: ${arg}\n运行 ./install.sh --help 查看用法。`);
		}
	}

	const hasOnly = parsed.only.length > 0;
	const hasAdd = parsed.add.length > 0;
	const hasRemove = parsed.remove.length > 0;
	const hasExclude = parsed.exclude.length > 0;

	if (hasAdd && (parsed.all || hasOnly || hasRemove || hasExclude)) {
		throw new Error("--add 不能与 --all / --only / --remove / --exclude 同时使用");
	}
	if (hasRemove && (parsed.all || hasOnly || hasAdd || hasExclude)) {
		throw new Error("--remove 不能与 --all / --only / --add / --exclude 同时使用");
	}
	if (parsed.all && hasOnly) {
		throw new Error("--all 不能与 --only 同时使用");
	}

	return {
		...parsed,
		onlyIds: hasOnly ? expandTokens(parsed.only) : [],
		addIds: hasAdd ? expandTokens(parsed.add) : [],
		removeIds: hasRemove ? expandTokens(parsed.remove) : [],
		excludeIds: hasExclude ? expandTokens(parsed.exclude) : [],
	};
}

export function buildPlan(mode, installIds, removeIds, installedIds) {
	const installSet = new Set(installIds);
	const removeSet = new Set(removeIds);
	const orderedInstall = ALL_COMPONENT_IDS.filter((id) => installSet.has(id));
	const orderedRemove = ALL_COMPONENT_IDS.filter((id) => removeSet.has(id));
	const removingInstalled = orderedRemove.filter((id) => installedIds.has(id));
	const updatePackages = orderedInstall
		.map((id) => COMPONENT_MAP.get(id))
		.filter((c) => c?.updateLatest && c.package)
		.map((c) => c.package);

	return {
		action: "apply",
		mode,
		install: orderedInstall,
		remove: orderedRemove,
		removingInstalled,
		updatePackages,
	};
}

export function resolveNonInteractivePlan(parsed, { isTTY, installedIds }) {
	const hasSelectionFlags =
		parsed.all ||
		parsed.onlyIds.length > 0 ||
		parsed.addIds.length > 0 ||
		parsed.removeIds.length > 0 ||
		parsed.excludeIds.length > 0;

	if (!hasSelectionFlags) {
		if (isTTY) return null; // Caller should launch interactive selector.
		return buildPlan("sync", ALL_COMPONENT_IDS, [], installedIds);
	}

	if (parsed.addIds.length > 0) {
		return buildPlan("add", parsed.addIds, [], installedIds);
	}

	if (parsed.removeIds.length > 0) {
		return buildPlan("remove", [], parsed.removeIds, installedIds);
	}

	const base = parsed.onlyIds.length > 0 ? parsed.onlyIds : ALL_COMPONENT_IDS;
	const excludeSet = new Set(parsed.excludeIds);
	const selected = base.filter((id) => !excludeSet.has(id));
	const selectedSet = new Set(selected);
	const unselected = ALL_COMPONENT_IDS.filter((id) => !selectedSet.has(id));
	return buildPlan("sync", selected, unselected, installedIds);
}

export function mergeSettings(sourceSettings, currentSettings, plan) {
	const mode = plan.mode || "sync";
	const nextSettings = structuredClone(sourceSettings);

	if (currentSettings && typeof currentSettings === "object") {
		if (typeof currentSettings.lastChangelogVersion === "string") {
			nextSettings.lastChangelogVersion = currentSettings.lastChangelogVersion;
		}
		// Pi's ChatGPT login uses a stable installation identity; never track it here.
		if (typeof currentSettings.deviceId === "string") {
			nextSettings.deviceId = currentSettings.deviceId;
		}
		// The default model is the user's local choice; this repository does not set one.
		for (const key of ["defaultProvider", "defaultModel"]) {
			if (nextSettings[key] === undefined && typeof currentSettings[key] === "string") {
				nextSettings[key] = currentSettings[key];
			}
		}
		if (mode === "add" || mode === "remove") {
			for (const key of ["defaultThinkingLevel", "theme"]) {
				if (typeof currentSettings[key] === "string") {
					nextSettings[key] = currentSettings[key];
				}
			}
		}
	}

	const currentPackages = Array.isArray(currentSettings?.packages)
		? currentSettings.packages
		: [];
	const installPkgSources = plan.install
		.map((id) => COMPONENT_MAP.get(id)?.package)
		.filter(Boolean);
	const removePkgSources = new Set(
		plan.remove.map((id) => COMPONENT_MAP.get(id)?.package).filter(Boolean),
	);

	// Preserve any repo-defined package object shape if sourceSettings uses one; default to string.
	const sourceEntryByName = new Map();
	if (Array.isArray(sourceSettings.packages)) {
		for (const entry of sourceSettings.packages) {
			const src = getPackageSource(entry);
			if (src) sourceEntryByName.set(src, entry);
		}
	}

	let nextPackages;
	if (mode === "sync") {
		const seen = new Set();
		nextPackages = [];
		for (const src of installPkgSources) {
			if (!seen.has(src)) {
				seen.add(src);
				nextPackages.push(sourceEntryByName.get(src) ?? src);
			}
		}
		// Preserve any user-installed third-party packages not managed by this repository.
		for (const entry of currentPackages) {
			const src = getPackageSource(entry);
			if (!src || (!MANAGED_PACKAGE_SOURCES.has(src) && !seen.has(src))) {
				if (src) seen.add(src);
				nextPackages.push(entry);
			}
		}
	} else if (mode === "add") {
		const seen = new Set();
		nextPackages = [];
		for (const entry of currentPackages) {
			const src = getPackageSource(entry);
			if (src) seen.add(src);
			nextPackages.push(entry);
		}
		for (const src of installPkgSources) {
			if (!seen.has(src)) {
				seen.add(src);
				nextPackages.push(sourceEntryByName.get(src) ?? src);
			}
		}
	} else {
		// remove mode
		nextPackages = currentPackages.filter((entry) => {
			const src = getPackageSource(entry);
			return !src || !removePkgSources.has(src);
		});
	}

	nextSettings.packages = nextPackages;
	return nextSettings;
}

export function formatHelp() {
	return `用法: ./install.sh [选项]

交互模式（终端直接运行且不带选择参数）:
  ./install.sh                     打开空格多选界面（初始全不选，同步模式）

命令行选项:
  -a, --all                        安装全部组件（同步模式；非 TTY 环境默认行为）
  -o, --only <列表>                仅保留指定组件，移除未选中的本仓库组件（同步模式）
      --add <列表>                 增量安装/更新指定组件，保留其他已安装项
      --remove <列表>              仅移除指定本仓库组件（先备份），保留其他项
  -x, --exclude <列表>             从 --all 或 --only 中排除指定组件
  -l, --list                       列出所有可选组件、套装内容及当前安装状态
  -y, --yes                        跳过交互式移除确认
  -h, --help                       显示此帮助信息

<列表> 支持逗号分隔或重复传入，可使用组件 ID 或分组别名:
  分组别名: all, extensions, packages, prompts

示例:
  ./install.sh                                   # 交互式空格多选
  ./install.sh --only memory,btw,esc-clear       # 仅安装这 3 个扩展（同步模式）
  ./install.sh --add inline-chart,pi-subagent    # 增量追加套装，不动其他已装插件
  ./install.sh --all --exclude herdr,pi-voice    # 全装但排除 herdr 和 pi-voice
  ./install.sh --remove pi-emphasis              # 仅移除 pi-emphasis
`;
}

export function formatList(installedIds) {
	const lines = [];
	const maxIdLen = Math.max(...COMPONENTS.map((c) => c.id.length));
	for (const group of GROUPS) {
		lines.push(`\n${group.label}:`);
		for (const comp of COMPONENTS.filter((c) => c.group === group.id)) {
			const tag = comp.bundle ? "[套装]" : "      ";
			const status = installedIds.has(comp.id) ? " [已安装]" : "";
			lines.push(`  ${comp.id.padEnd(maxIdLen)}  ${tag}  ${comp.summary}${status}`);
			if (comp.details) {
				lines.push(`  ${" ".repeat(maxIdLen)}          ${comp.details}`);
			}
		}
	}
	lines.push("");
	return lines.join("\n").replace(/^\n/, "");
}

// --- Terminal width helpers (ANSI-aware, CJK wide char aware) ---

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

function isWideCodePoint(cp) {
	return (
		cp >= 0x1100 &&
		(cp <= 0x115f ||
			cp === 0x2329 ||
			cp === 0x232a ||
			(cp >= 0x2e80 && cp <= 0x3247 && cp !== 0x303f) ||
			(cp >= 0x3250 && cp <= 0x4dbf) ||
			(cp >= 0x4e00 && cp <= 0xa4c6) ||
			(cp >= 0xa960 && cp <= 0xa97c) ||
			(cp >= 0xac00 && cp <= 0xd7a3) ||
			(cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0xfe10 && cp <= 0xfe19) ||
			(cp >= 0xfe30 && cp <= 0xfe6b) ||
			(cp >= 0xff01 && cp <= 0xff60) ||
			(cp >= 0xffe0 && cp <= 0xffe6) ||
			(cp >= 0x1f300 && cp <= 0x1f9ff) ||
			(cp >= 0x20000 && cp <= 0x3fffd))
	);
}

export function displayWidth(str) {
	const plain = str.replace(ANSI_REGEX, "");
	let width = 0;
	for (const ch of plain) {
		const cp = ch.codePointAt(0);
		width += isWideCodePoint(cp) ? 2 : 1;
	}
	return width;
}

export function truncateWidth(str, maxWidth) {
	if (maxWidth <= 0) return "";
	if (displayWidth(str) <= maxWidth) return str;
	const target = Math.max(1, maxWidth - 1);
	let out = "";
	let width = 0;
	let i = 0;
	let hasAnsi = false;
	while (i < str.length) {
		if (str[i] === "\x1b" && str[i + 1] === "[") {
			const end = str.indexOf("m", i);
			if (end !== -1) {
				out += str.slice(i, end + 1);
				hasAnsi = true;
				i = end + 1;
				continue;
			}
		}
		const cp = str.codePointAt(i);
		const ch = String.fromCodePoint(cp);
		const w = isWideCodePoint(cp) ? 2 : 1;
		if (width + w > target) break;
		out += ch;
		width += w;
		i += ch.length;
	}
	return `${out}…${hasAnsi ? "\x1b[0m" : ""}`;
}

// --- Interactive space-to-toggle TUI ---

const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	magenta: "\x1b[35m",
	inverse: "\x1b[7m",
	altOn: "\x1b[?1049h",
	altOff: "\x1b[?1049l",
	hideCursor: "\x1b[?25l",
	showCursor: "\x1b[?25h",
	clearHome: "\x1b[H\x1b[2J",
};

function tokenizeInput(chunk) {
	const keys = [];
	let i = 0;
	while (i < chunk.length) {
		if (chunk[i] === "\x1b") {
			if (chunk[i + 1] === "[" || chunk[i + 1] === "O") {
				let j = i + 2;
				while (j < chunk.length && /[0-9;]/.test(chunk[j])) j++;
				if (j < chunk.length) {
					keys.push(chunk.slice(i, j + 1));
					i = j + 1;
					continue;
				}
			}
			keys.push("\x1b");
			i += 1;
			continue;
		}
		keys.push(chunk[i]);
		i += 1;
	}
	return keys;
}

async function runInteractiveSelector({ agentDir, installedIds, skipConfirm }) {
	// Build flat display rows with group headers and selectable items.
	const rows = [];
	const selectableRowIndices = [];
	for (const group of GROUPS) {
		rows.push({ type: "header", label: group.label });
		for (const comp of COMPONENTS.filter((c) => c.group === group.id)) {
			selectableRowIndices.push(rows.length);
			rows.push({ type: "item", comp });
		}
	}

	const maxIdLen = Math.max(...COMPONENTS.map((c) => c.id.length));
	// Default: all unchecked (per user requirement).
	const selected = new Set();
	let cursorIdx = 0; // Index into selectableRowIndices
	let scrollTop = 0;
	let view = "select"; // "select" | "confirm"
	let pendingPlan = null;
	let statusNotice = "";

	const renderSelect = (cols, termRows) => {
		const divider = `${ANSI.dim}${"─".repeat(Math.max(10, cols))}${ANSI.reset}`;
		const activeComp = rows[selectableRowIndices[cursorIdx]].comp;
		const headerLines = [
			truncateWidth(
				`${ANSI.bold}${ANSI.cyan}Pi 配置选择安装${ANSI.reset} ${ANSI.dim}(同步模式 · 目标: ${agentDir})${ANSI.reset}`,
				cols,
			),
			truncateWidth(
				`已选 ${ANSI.bold}${ANSI.green}${selected.size}${ANSI.reset} / ${COMPONENTS.length} 项` +
					(installedIds.size > 0
						? `  ${ANSI.dim}(当前已安装 ${installedIds.size} 项)${ANSI.reset}`
						: `  ${ANSI.dim}(全新安装)${ANSI.reset}`) +
					(statusNotice ? `  ${ANSI.yellow}${statusNotice}${ANSI.reset}` : ""),
				cols,
			),
			divider,
		];

		const detailText = activeComp.details
			? `${ANSI.magenta}${activeComp.details}${ANSI.reset}`
			: `${ANSI.dim}${activeComp.id}: ${activeComp.summary}${ANSI.reset}`;
		const footerLines = [
			divider,
			truncateWidth(detailText, cols),
			truncateWidth(
				`${ANSI.dim}↑↓/jk 移动 · Space 勾选 · a 全选/清空 · i 载入已安装 · Enter 确认 · q/Esc 退出${ANSI.reset}`,
				cols,
			),
		];

		const viewportHeight = Math.max(4, termRows - headerLines.length - footerLines.length);
		const activeRowIndex = selectableRowIndices[cursorIdx];

		// Keep active row (and its group header if just above) visible in viewport.
		const preferredTop =
			activeRowIndex > 0 && rows[activeRowIndex - 1].type === "header"
				? activeRowIndex - 1
				: activeRowIndex;
		if (preferredTop < scrollTop) scrollTop = preferredTop;
		if (activeRowIndex >= scrollTop + viewportHeight) {
			scrollTop = activeRowIndex - viewportHeight + 1;
		}
		scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, rows.length - viewportHeight)));

		const bodyLines = [];
		const visibleRows = rows.slice(scrollTop, scrollTop + viewportHeight);
		for (let idx = 0; idx < visibleRows.length; idx++) {
			const rowIdx = scrollTop + idx;
			const row = visibleRows[idx];
			if (row.type === "header") {
				bodyLines.push(truncateWidth(`${ANSI.bold}${ANSI.yellow}${row.label}${ANSI.reset}`, cols));
				continue;
			}
			const { comp } = row;
			const isCursor = rowIdx === activeRowIndex;
			const isChecked = selected.has(comp.id);
			const isInstalled = installedIds.has(comp.id);
			const pointer = isCursor ? `${ANSI.cyan}❯${ANSI.reset}` : " ";
			const checkbox = isChecked
				? `${ANSI.green}[✓]${ANSI.reset}`
				: `${ANSI.dim}[ ]${ANSI.reset}`;
			const idLabel = isCursor
				? `${ANSI.bold}${ANSI.cyan}${comp.id.padEnd(maxIdLen)}${ANSI.reset}`
				: comp.id.padEnd(maxIdLen);
			const bundleBadge = comp.bundle ? ` ${ANSI.magenta}[套装]${ANSI.reset}` : "";
			const installedBadge = isInstalled ? ` ${ANSI.green}[已安装]${ANSI.reset}` : "";
			const desc = `${ANSI.dim}${comp.summary}${ANSI.reset}`;
			bodyLines.push(
				truncateWidth(`${pointer} ${checkbox} ${idLabel}${bundleBadge}${installedBadge}  ${desc}`, cols),
			);
		}
		while (bodyLines.length < viewportHeight) bodyLines.push("");

		return [...headerLines, ...bodyLines, ...footerLines].join("\r\n");
	};

	const renderConfirm = (cols) => {
		const divider = `${ANSI.dim}${"─".repeat(Math.max(10, cols))}${ANSI.reset}`;
		const lines = [
			truncateWidth(`${ANSI.bold}${ANSI.yellow}确认同步安装计划${ANSI.reset}`, cols),
			divider,
			"",
		];
		if (pendingPlan.install.length > 0) {
			lines.push(
				truncateWidth(
					`${ANSI.green}${ANSI.bold}将安装 / 更新 (${pendingPlan.install.length}):${ANSI.reset}`,
					cols,
				),
			);
			lines.push(truncateWidth(`  + ${pendingPlan.install.join(", ")}`, cols));
			lines.push("");
		}
		if (pendingPlan.removingInstalled.length > 0) {
			lines.push(
				truncateWidth(
					`${ANSI.red}${ANSI.bold}将移除（移除前会自动备份） (${pendingPlan.removingInstalled.length}):${ANSI.reset}`,
					cols,
				),
			);
			lines.push(truncateWidth(`  - ${pendingPlan.removingInstalled.join(", ")}`, cols));
			lines.push("");
		}
		if (pendingPlan.install.length > 0 && pendingPlan.removingInstalled.length > 0) {
			lines.push(
				truncateWidth(
					`${ANSI.dim}提示: 如只想增量安装而不移除其他已装项，可退出后运行:${ANSI.reset}`,
					cols,
				),
			);
			lines.push(
				truncateWidth(
					`${ANSI.cyan}  ./install.sh --add ${pendingPlan.install.join(",")}${ANSI.reset}`,
					cols,
				),
			);
			lines.push("");
		}
		lines.push(divider);
		lines.push(
			truncateWidth(
				`${ANSI.bold}按 y 确认执行${ANSI.reset} · ${ANSI.dim}按 b 返回修改 · 按 n/Esc 取消${ANSI.reset}`,
				cols,
			),
		);
		return lines.join("\r\n");
	};

	const render = () => {
		const cols = process.stdout.columns || 80;
		const termRows = process.stdout.rows || 24;
		const screen = view === "confirm" ? renderConfirm(cols) : renderSelect(cols, termRows);
		process.stdout.write(`${ANSI.clearHome}${screen}`);
	};

	return await new Promise((resolve) => {
		const wasRaw = process.stdin.isRaw;
		let finished = false;

		const cleanup = (result) => {
			if (finished) return;
			finished = true;
			process.stdout.off("resize", render);
			process.stdin.off("data", onData);
			process.off("SIGINT", onSigInt);
			if (process.stdin.isTTY) {
				try {
					process.stdin.setRawMode(Boolean(wasRaw));
				} catch {
					// Ignore if TTY already closed.
				}
			}
			process.stdin.pause();
			process.stdout.write(`${ANSI.showCursor}${ANSI.altOff}`);
			resolve(result);
		};

		const onSigInt = () => cleanup({ action: "cancel", reason: "已取消安装。" });

		const onData = (buf) => {
			const keys = tokenizeInput(buf.toString("utf8"));
			for (const key of keys) {
				if (key === "\x03") {
					cleanup({ action: "cancel", reason: "已取消安装。" });
					return;
				}
				if (view === "confirm") {
					if (key === "y" || key === "Y") {
						cleanup(pendingPlan);
						return;
					}
					if (key === "b" || key === "B" || key === "\x7f" || key === "\b") {
						view = "select";
						pendingPlan = null;
						render();
						continue;
					}
					if (key === "n" || key === "N" || key === "q" || key === "Q" || key === "\x1b") {
						cleanup({ action: "cancel", reason: "已取消安装。" });
						return;
					}
					continue;
				}

				statusNotice = "";
				if (key === "\x1b[A" || key === "\x1bOA" || key === "k") {
					cursorIdx = (cursorIdx - 1 + selectableRowIndices.length) % selectableRowIndices.length;
				} else if (key === "\x1b[B" || key === "\x1bOB" || key === "j") {
					cursorIdx = (cursorIdx + 1) % selectableRowIndices.length;
				} else if (key === "\x1b[5~") {
					cursorIdx = Math.max(0, cursorIdx - 5);
				} else if (key === "\x1b[6~") {
					cursorIdx = Math.min(selectableRowIndices.length - 1, cursorIdx + 5);
				} else if (key === "\x1b[H" || key === "\x1b[1~") {
					cursorIdx = 0;
				} else if (key === "\x1b[F" || key === "\x1b[4~") {
					cursorIdx = selectableRowIndices.length - 1;
				} else if (key === " ") {
					const id = rows[selectableRowIndices[cursorIdx]].comp.id;
					if (selected.has(id)) selected.delete(id);
					else selected.add(id);
				} else if (key === "a" || key === "A") {
					if (selected.size === COMPONENTS.length) {
						selected.clear();
					} else {
						for (const id of ALL_COMPONENT_IDS) selected.add(id);
					}
				} else if (key === "i" || key === "I") {
					if (installedIds.size === 0) {
						statusNotice = "当前目录尚未检测到已安装项";
					} else {
						selected.clear();
						for (const id of installedIds) selected.add(id);
						statusNotice = `已载入 ${installedIds.size} 个已安装项`;
					}
				} else if (key === "q" || key === "Q" || key === "\x1b") {
					cleanup({ action: "cancel", reason: "已取消安装。" });
					return;
				} else if (key === "\r" || key === "\n") {
					if (selected.size === 0 && installedIds.size === 0) {
						cleanup({ action: "cancel", reason: "未选择任何组件，已取消安装。" });
						return;
					}
					const unselected = ALL_COMPONENT_IDS.filter((id) => !selected.has(id));
					const plan = buildPlan("sync", [...selected], unselected, installedIds);
					if (plan.removingInstalled.length > 0 && !skipConfirm) {
						pendingPlan = plan;
						view = "confirm";
						render();
						return;
					}
					cleanup(plan);
					return;
				}
			}
			render();
		};

		process.stdout.write(`${ANSI.altOn}${ANSI.hideCursor}`);
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", onData);
		process.stdout.on("resize", render);
		process.on("SIGINT", onSigInt);
		render();
	});
}

// --- Subcommands invoked by install.sh ---

function parseSubcommandFlags(args) {
	const flags = {};
	const rest = [];
	let afterDoubleDash = false;
	for (let i = 0; i < args.length; i++) {
		if (afterDoubleDash) {
			rest.push(args[i]);
			continue;
		}
		if (args[i] === "--") {
			afterDoubleDash = true;
			continue;
		}
		if (args[i].startsWith("--")) {
			flags[args[i].slice(2)] = args[i + 1];
			i++;
		}
	}
	return { flags, rest };
}

async function cmdPlan(args) {
	const { flags, rest } = parseSubcommandFlags(args);
	const agentDir = flags["agent-dir"];
	const planOut = flags["plan-out"];

	let parsed;
	try {
		parsed = parseCliArgs(rest);
	} catch (error) {
		process.stderr.write(`Error: ${error.message}\n`);
		process.exitCode = 1;
		return;
	}

	const installedIds = detectInstalled(agentDir);

	if (parsed.command === "help") {
		process.stdout.write(formatHelp());
		writeFileSync(planOut, JSON.stringify({ action: "exit" }), "utf8");
		return;
	}
	if (parsed.command === "list") {
		process.stdout.write(formatList(installedIds));
		writeFileSync(planOut, JSON.stringify({ action: "exit" }), "utf8");
		return;
	}

	const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	let plan = resolveNonInteractivePlan(parsed, { isTTY, installedIds });

	if (!plan) {
		plan = await runInteractiveSelector({
			agentDir,
			installedIds,
			skipConfirm: parsed.yes,
		});
		if (plan.action === "cancel") {
			if (plan.reason) process.stdout.write(`${plan.reason}\n`);
			writeFileSync(planOut, JSON.stringify({ action: "cancel" }), "utf8");
			return;
		}
	}

	writeFileSync(planOut, JSON.stringify(plan, null, 2), "utf8");
}

function cmdDumpPlan(args) {
	const { flags } = parseSubcommandFlags(args);
	const plan = JSON.parse(readFileSync(flags.plan, "utf8"));
	const lines = [];
	lines.push(`action\t${plan.action ?? "exit"}`);
	if (plan.mode) lines.push(`mode\t${plan.mode}`);
	for (const id of plan.install ?? []) lines.push(`install\t${id}`);
	for (const id of plan.remove ?? []) lines.push(`remove\t${id}`);
	for (const id of plan.removingInstalled ?? []) lines.push(`removing_installed\t${id}`);
	for (const pkg of plan.updatePackages ?? []) lines.push(`update_pkg\t${pkg}`);
	process.stdout.write(`${lines.join("\n")}\n`);
}

function cmdApplySettings(args) {
	const { flags } = parseSubcommandFlags(args);
	const sourcePath = join(flags.root, "settings.json");
	const targetPath = join(flags["agent-dir"], "settings.json");
	const plan = JSON.parse(readFileSync(flags.plan, "utf8"));

	const sourceSettings = JSON.parse(readFileSync(sourcePath, "utf8"));
	let currentSettings = null;
	try {
		currentSettings = JSON.parse(readFileSync(targetPath, "utf8"));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}

	const nextSettings = mergeSettings(sourceSettings, currentSettings, plan);
	const temporaryPath = `${targetPath}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");
	renameSync(temporaryPath, targetPath);
}

async function main() {
	const [subcommand, ...args] = process.argv.slice(2);
	switch (subcommand) {
		case "plan":
			await cmdPlan(args);
			break;
		case "dump-plan":
			cmdDumpPlan(args);
			break;
		case "apply-settings":
			cmdApplySettings(args);
			break;
		default:
			process.stderr.write(`Unknown subcommand: ${subcommand ?? "(none)"}\n`);
			process.exitCode = 1;
	}
}

const entryPath = process.argv[1];
if (entryPath) {
	let isMain = false;
	try {
		isMain = realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		isMain = false;
	}
	if (isMain) {
		await main();
	}
}
