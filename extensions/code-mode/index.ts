import {
	type ExtensionAPI,
	type ExtensionContext,
	formatSkillsForPrompt,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ToolEntry, ToolsPanel } from "./panel.ts";
import { type CodeDetails, renderCodeCall, renderCodeResult } from "./render.ts";
import { type Language, runProgram } from "./runtime.ts";
import {
	BUILTIN_TOOLS,
	type BuiltinTool,
	BuiltinToolCache,
	createBuiltinTools,
	DEFAULT_ACTIVE_BUILTINS,
	describeApi,
	isBuiltinTool,
	pickTools,
	ToolBridge,
} from "./tools.ts";

export const CODE_TOOL = "execute_code";
/** Session custom entry holding the tool selection. */
export const STATE_ENTRY_TYPE = "tools-state";
/** CLI flag and footer status key. */
export const CODE_MODE_FLAG = "code-mode";
/** Minimum interval between live updates while a program runs. */
const UPDATE_INTERVAL_MS = 150;

export interface ToolsState {
	codeMode: boolean;
	/** The only language execute_code accepts; the model cannot choose another. */
	language: Language;
	/** Run execute_code programs in the macOS sandbox (see sandbox.ts). */
	sandbox: boolean;
	/** Built-in tools that are on; inside execute_code while code mode is on. */
	builtins: string[];
	/**
	 * Other tools the user turned off. Any other tool keeps the activation Pi and
	 * its extension chose (for example MCP tools held inactive until searched).
	 */
	off: string[];
}

export interface ToolPlan {
	/** The active tool set for Pi. */
	active: string[];
	/** Built-in tools available inside execute_code (empty when code mode is off). */
	codeTools: BuiltinTool[];
}

/** The latest tools-state entry on the current branch, if any. */
export function readState(
	entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
): ToolsState | undefined {
	let state: ToolsState | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
		const data = entry.data as Partial<ToolsState> | undefined;
		if (typeof data?.codeMode !== "boolean" || !Array.isArray(data.builtins) || !Array.isArray(data.off)) continue;
		const strings = (names: unknown[]) => names.filter((name): name is string => typeof name === "string");
		// The sandbox defaults to on; only an explicit false turns it off.
		state = {
			codeMode: data.codeMode,
			language: data.language === "python" ? "python" : "javascript",
			sandbox: data.sandbox !== false,
			builtins: strings(data.builtins),
			off: strings(data.off),
		};
	}
	return state;
}

/**
 * The built-ins that are on according to Pi's current active tools, for a
 * branch without a saved selection. When code mode hid the built-ins before a
 * reload, Pi's default built-ins count as on.
 */
export function inferBuiltins(active: readonly string[]): string[] {
	const builtins = BUILTIN_TOOLS.filter((name) => active.includes(name));
	if (builtins.length === 0 && active.includes(CODE_TOOL)) return [...DEFAULT_ACTIVE_BUILTINS];
	return builtins;
}

/**
 * The next active tool set. Built-ins that are on are active while code mode
 * is off and move inside execute_code while it is on. Other tools keep their
 * current activation, except those the user turned off; `turnOn` activates
 * tools the user just turned on.
 */
export function planTools(
	active: readonly string[],
	all: readonly string[],
	state: ToolsState,
	turnOn: readonly string[] = [],
): ToolPlan {
	const registered = new Set(all);
	const off = new Set(state.off);
	const others = [...new Set([...active, ...turnOn])].filter(
		(name) => registered.has(name) && name !== CODE_TOOL && !isBuiltinTool(name) && !off.has(name),
	);
	const builtins = BUILTIN_TOOLS.filter((name) => state.builtins.includes(name) && registered.has(name));
	if (!state.codeMode) return { active: [...builtins, ...others], codeTools: [] };
	return { active: [...others, CODE_TOOL], codeTools: builtins };
}

function sameTools(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((name) => b.includes(name));
}

function summaryLine(description: string): string {
	const line = description.replace(/\s+/g, " ").trim();
	const sentence = line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line;
	return sentence.length > 100 ? `${sentence.slice(0, 99)}…` : sentence;
}

export const LANGUAGE_NAMES: Record<Language, string> = { javascript: "JavaScript", python: "Python" };

/** execute_code has no language parameter: the language is fixed by the /tools selection. */
function codeParameters(language: Language) {
	return Type.Object({
		code: Type.String({ description: `${LANGUAGE_NAMES[language]} program source code` }),
		timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	});
}
const parameters = codeParameters("javascript");

type AnyTool = ToolDefinition<any, any, any>;
type ExecuteArgs = Parameters<ToolDefinition<typeof parameters, CodeDetails>["execute"]>;

/** Runs one execute_code call with `tools` available inside the program. */
async function executeCode(
	tools: ReadonlyMap<string, AnyTool>,
	sandbox: boolean,
	language: Language,
	...[toolCallId, params, signal, onUpdate, ctx]: ExecuteArgs
) {
	const started = Date.now();
	let recent = "";
	let timer: ReturnType<typeof setTimeout> | undefined;

	const details = (running: boolean): CodeDetails => ({
		language,
		calls: bridge.calls.map((call) => ({ ...call })),
		callCount: bridge.callCount,
		running,
		durationMs: Date.now() - started,
	});
	const push = () => onUpdate?.({ content: [{ type: "text", text: recent }], details: details(true) });
	const schedule = () => {
		if (!onUpdate || timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			push();
		}, UPDATE_INTERVAL_MS);
	};
	const bridge = new ToolBridge(tools, ctx, toolCallId, schedule);

	let run: Awaited<ReturnType<typeof runProgram>>;
	try {
		run = await runProgram({
			language,
			code: params.code,
			cwd: ctx.cwd,
			toolNames: [...tools.keys()],
			call: (tool, args, callSignal) => bridge.call(tool, args, callSignal),
			timeoutSeconds: params.timeout,
			signal,
			sandbox,
			onOutput: (output) => {
				recent = output;
				schedule();
			},
		});
	} finally {
		if (timer) clearTimeout(timer);
	}

	const final: CodeDetails = { ...details(false), exitCode: run.exitCode, fullOutputPath: run.fullOutputPath };
	let text = run.output.replace(/\s+$/, "");
	if (run.truncationNote) text += `${text ? "\n\n" : ""}${run.truncationNote}`;
	if (bridge.droppedImages > 0) {
		text += `${text ? "\n\n" : ""}[${bridge.droppedImages} more image(s) were read but not attached]`;
	}

	let failure: string | undefined;
	if (run.aborted) failure = "Program aborted";
	else if (run.timedOut) failure = `Program timed out after ${params.timeout} seconds`;
	else if (run.exitCode === null) failure = "Program was killed";
	else if (run.exitCode !== 0) failure = `Program exited with code ${run.exitCode}`;

	if (failure) {
		// A thrown result has no details; hand the final call list to the renderer first.
		onUpdate?.({ content: [{ type: "text", text }], details: final });
		throw new Error(text ? `${text}\n\n${failure}` : failure);
	}
	return {
		content: [{ type: "text" as const, text: text || "(no output)" }, ...bridge.images],
		details: final,
	};
}

export default function codeMode(pi: ExtensionAPI) {
	let state: ToolsState = {
		codeMode: false,
		language: "javascript",
		sandbox: true,
		builtins: [...DEFAULT_ACTIVE_BUILTINS],
		off: [],
	};
	let codeTools: BuiltinTool[] = BUILTIN_TOOLS.filter((name) => DEFAULT_ACTIVE_BUILTINS.includes(name));
	let registeredFor: string | undefined;
	const cache = new BuiltinToolCache();
	// Descriptions and schemas do not depend on cwd or settings.
	const templates = createBuiltinTools(process.cwd());

	pi.registerFlag(CODE_MODE_FLAG, {
		description: "Start sessions in code mode unless the session already chose otherwise",
		type: "boolean",
	});

	/**
	 * (Re-)registers execute_code so its description, API reference, snippet,
	 * and guidelines cover exactly `tools` and the sandbox setting. Pi replaces a
	 * re-registered tool and appends the prompt change before the next request.
	 */
	function registerCodeTool(tools: readonly BuiltinTool[], sandbox: boolean, language: Language): void {
		const key = `${tools.join(",")}|${sandbox}|${language}`;
		if (key === registeredFor) return;
		registeredFor = key;
		const list = tools.length ? tools.join(", ") : "no built-in tools";
		pi.registerTool({
			name: CODE_TOOL,
			label: "Code",
			description: describeApi(pickTools(templates, tools), { sandbox, language }),
			promptSnippet: `Run a ${LANGUAGE_NAMES[language]} program that calls Pi's built-in tools (${list}) as functions on a global \`tools\` object`,
			promptGuidelines: [
				tools.length
					? `Code mode is on: ${list} exist only as functions inside ${CODE_TOOL} programs. Call them from code, not as tools.`
					: `Code mode is on, but no built-in tools are enabled inside ${CODE_TOOL}.`,
				`${CODE_TOOL} programs must be written in ${LANGUAGE_NAMES[language]}.`,
				`Do related work in one ${CODE_TOOL} program: loop, filter, and combine tool results in code and print only what you need to see.`,
			],
			parameters: codeParameters(language),
			// Calls recorded before the language parameter was removed keep their own language.
			renderCall: (args, theme, context) => renderCodeCall({ language, ...args }, theme, context),
			renderResult: (result, options, theme, context) => renderCodeResult(result, options, theme, context),
			execute: (toolCallId, params, signal, onUpdate, ctx) =>
				executeCode(pickTools(cache.get(ctx), tools), sandbox, language, toolCallId, params, signal, onUpdate, ctx),
		});
	}

	function allToolNames(): string[] {
		return pi.getAllTools().map((tool) => tool.name);
	}

	function updateStatus(ctx: ExtensionContext): void {
		const language = state.language === "python" ? "python" : "js";
		const label = `code mode · ${language}${state.sandbox ? "" : " · unsandboxed"}`;
		ctx.ui.setStatus(CODE_MODE_FLAG, state.codeMode ? ctx.ui.theme.fg(state.sandbox ? "accent" : "warning", label) : undefined);
	}

	function apply(ctx: ExtensionContext, turnOn: readonly string[] = []): void {
		const plan = planTools(pi.getActiveTools(), allToolNames(), state, turnOn);
		if (state.codeMode) {
			codeTools = plan.codeTools;
			registerCodeTool(codeTools, state.sandbox, state.language);
		}
		const active = pi.getActiveTools();
		if (!sameTools(active, plan.active)) pi.setActiveTools(plan.active);
		updateStatus(ctx);
	}

	function update(next: ToolsState, ctx: ExtensionContext, turnOn: readonly string[] = []): void {
		state = {
			codeMode: next.codeMode,
			language: next.language,
			sandbox: next.sandbox,
			builtins: [...new Set(next.builtins)],
			off: [...new Set(next.off)],
		};
		pi.appendEntry<ToolsState>(STATE_ENTRY_TYPE, state);
		apply(ctx, turnOn);
	}

	function restore(ctx: ExtensionContext): void {
		// An explicit choice on this branch wins over the startup flag.
		const saved = readState(ctx.sessionManager.getBranch());
		state = saved ?? {
			codeMode: pi.getFlag(CODE_MODE_FLAG) === true,
			language: "javascript",
			sandbox: true,
			builtins: inferBuiltins(pi.getActiveTools()),
			off: [],
		};
		apply(ctx);
	}

	function setCodeMode(enabled: boolean, ctx: ExtensionContext): void {
		update({ ...state, codeMode: enabled }, ctx);
		ctx.ui.notify(
			enabled
				? `Code mode on: ${codeTools.length ? codeTools.join(", ") : "no built-in tools"} run only inside ${CODE_TOOL}`
				: "Code mode off: built-in tools restored",
			"info",
		);
	}

	function setLanguage(language: Language, ctx: ExtensionContext): void {
		update({ ...state, language }, ctx);
		ctx.ui.notify(`${CODE_TOOL} programs: ${LANGUAGE_NAMES[language]} only`, "info");
	}

	function setSandbox(enabled: boolean, ctx: ExtensionContext): void {
		update({ ...state, sandbox: enabled }, ctx);
		if (!enabled) ctx.ui.notify(`Sandbox off: ${CODE_TOOL} programs run with your full permissions`, "warning");
	}

	function setTool(name: string, enabled: boolean, ctx: ExtensionContext): void {
		const without = (names: string[]) => names.filter((entry) => entry !== name);
		if (isBuiltinTool(name)) {
			update({ ...state, builtins: enabled ? [...state.builtins, name] : without(state.builtins) }, ctx);
		} else {
			update({ ...state, off: enabled ? without(state.off) : [...without(state.off), name] }, ctx, enabled ? [name] : []);
		}
	}

	function toolEntries(): ToolEntry[] {
		const active = new Set(pi.getActiveTools());
		const rank = (name: string) => (isBuiltinTool(name) ? BUILTIN_TOOLS.indexOf(name) : BUILTIN_TOOLS.length);
		return pi
			.getAllTools()
			.filter((tool) => tool.name !== CODE_TOOL)
			.map((tool) => ({
				name: tool.name,
				description: summaryLine(tool.description),
				builtin: isBuiltinTool(tool.name),
				enabled: isBuiltinTool(tool.name) ? state.builtins.includes(tool.name) : active.has(tool.name),
			}))
			.sort((a, b) => rank(a.name) - rank(b.name));
	}

	registerCodeTool(codeTools, state.sandbox, state.language);

	// Pi lists skills only when read or bash is active; in code mode, point at the tools inside execute_code.
	pi.on("before_agent_start", (event) => {
		if (!state.codeMode) return;
		const options = event.systemPromptOptions;
		if (options.selectedTools.includes("read") || options.selectedTools.includes("bash")) return;
		const via = codeTools.includes("read") ? "tools.read" : codeTools.includes("bash") ? "tools.bash" : undefined;
		if (!via) return;
		const skills = formatSkillsForPrompt(options.skills ?? [], "read")
			.trim()
			.replace("Use the read tool to load a skill's file", `Load a skill's file with ${via} inside ${CODE_TOOL}`);
		if (skills) options.sections.skills = skills;
	});

	// Built-ins are inactive in code mode; refuse any direct call that still reaches us.
	pi.on("tool_call", (event) => {
		if (!state.codeMode || !isBuiltinTool(event.toolName)) return;
		return {
			block: true,
			reason: codeTools.includes(event.toolName)
				? `Code mode is on: call tools.${event.toolName}(...) inside ${CODE_TOOL} instead.`
				: `Code mode is on and ${event.toolName} is turned off.`,
		};
	});

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.registerCommand("tools", {
		description: "Turn registered tools and code mode on or off",
		async handler(_args, ctx) {
			if (ctx.mode !== "tui") {
				const on = toolEntries()
					.filter((entry) => entry.enabled)
					.map((entry) => entry.name);
				ctx.ui.notify(
					`Code mode ${state.codeMode ? "on" : "off"} (${LANGUAGE_NAMES[state.language]}), sandbox ${state.sandbox ? "on" : "off"}; tools on: ${on.join(", ") || "none"}`,
					"info",
				);
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new ToolsPanel(
						{
							codeMode: () => state.codeMode,
							sandbox: () => state.sandbox,
							tools: toolEntries,
							setCodeMode: (enabled) => setCodeMode(enabled, ctx),
							setSandbox: (enabled) => setSandbox(enabled, ctx),
							language: () => state.language,
							setLanguage: (language) => setLanguage(language, ctx),
							setTool: (name, enabled) => setTool(name, enabled, ctx),
						},
						theme,
						() => tui.requestRender(),
						() => done(),
					),
			);
		},
	});

	pi.registerCommand("code-mode", {
		description: `Toggle code mode: enabled built-in tools run only inside ${CODE_TOOL} programs`,
		getArgumentCompletions(prefix) {
			const items = [
				{ value: "on", label: "on", description: `Enabled built-in tools only inside ${CODE_TOOL}` },
				{ value: "off", label: "off", description: "Restore the built-in tools" },
			].filter((item) => item.value.startsWith(prefix.toLowerCase()));
			return items.length > 0 ? items : null;
		},
		async handler(args, ctx) {
			const requested = args.trim().toLowerCase();
			if (requested && requested !== "on" && requested !== "off") {
				ctx.ui.notify("Usage: /code-mode [on|off]", "error");
				return;
			}
			const next = requested ? requested === "on" : !state.codeMode;
			if (next === state.codeMode) {
				ctx.ui.notify(`Code mode is already ${state.codeMode ? "on" : "off"}`, "info");
				return;
			}
			setCodeMode(next, ctx);
		},
	});
}
