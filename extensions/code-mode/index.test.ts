import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import codeMode, {
	CODE_MODE_FLAG,
	CODE_TOOL,
	inferBuiltins,
	planTools,
	readState,
	STATE_ENTRY_TYPE,
	type ToolsState,
} from "./index.ts";
import { CODE_MODE_ITEM, ToolsPanel, type ToolsPanelModel } from "./panel.ts";
import { renderCodeCall, renderCodeResult } from "./render.ts";

initTheme("dark");
// Pi hands its global theme to tool renderers; load that same module instance.
const { theme } = await import(
	new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
);

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "code-mode-index-")));
test.after(() => rmSync(cwd, { recursive: true, force: true }));

const DEFAULT = ["read", "bash", "edit", "write"];
const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const DOWN = "\x1b[B";
const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_[^\x07]*\x07/g, ""));

function setup(options: { active?: string[]; entries?: any[]; flag?: boolean; extra?: string[] } = {}) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const entries: any[] = [...(options.entries ?? [])];
	const statuses = new Map<string, string | undefined>();
	const notes: string[] = [];
	const registry = new Map<string, string>(
		[...BUILTINS, ...(options.extra ?? ["subagent"])].map((name) => [name, `The ${name} tool. More detail.`]),
	);
	let active = [...(options.active ?? [...DEFAULT, ...(options.extra ?? ["subagent"])])];
	let registrations = 0;
	const pi = {
		registerTool(tool: any) {
			registrations++;
			const known = registry.has(tool.name);
			tools.set(tool.name, tool);
			registry.set(tool.name, tool.description);
			// Pi activates newly registered tools and keeps a replaced tool's state.
			if (!known && !active.includes(tool.name)) active.push(tool.name);
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerFlag() {},
		getFlag: (name: string) => (name === CODE_MODE_FLAG ? options.flag : undefined),
		on(event: string, handler: any) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getAllTools: () => [...registry].map(([name, description]) => ({ name, description, parameters: {} })),
		getActiveTools: () => [...active],
		setActiveTools(names: string[]) {
			active = names.filter((name) => registry.has(name));
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	};
	const ctx: any = {
		cwd,
		mode: "tui",
		hasUI: true,
		isProjectTrusted: () => false,
		sessionManager: { getBranch: () => entries, getSessionId: () => "test-session", getSessionFile: () => undefined },
		ui: {
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			notify: (message: string) => notes.push(message),
			theme: { fg: (_color: string, text: string) => text },
			custom: async (factory: any) => {
				let closed = false;
				ctx.panel = factory({ requestRender() {} }, theme, {}, () => (closed = true));
				ctx.panelClosed = () => closed;
			},
		},
	};
	codeMode(pi as any);
	const emit = async (event: string, payload: any = {}) => {
		let result: any;
		for (const handler of handlers.get(event) ?? []) result = (await handler(payload, ctx)) ?? result;
		return result;
	};
	const run = (name: string, args = "") => commands.get(name).handler(args, ctx);
	const openPanel = async (): Promise<ToolsPanel> => {
		await run("tools");
		return ctx.panel;
	};
	const lastState = (): ToolsState => entries.filter((entry) => entry.customType === STATE_ENTRY_TYPE).at(-1)?.data;
	return {
		pi,
		ctx,
		tools,
		entries,
		statuses,
		notes,
		emit,
		run,
		openPanel,
		lastState,
		active: () => active,
		description: () => tools.get(CODE_TOOL).description as string,
		registrations: () => registrations,
	};
}

test("planTools moves the built-ins that are on into execute_code and back", () => {
	const all = [...BUILTINS, "subagent", "mcp", "lazy", CODE_TOOL];
	const active = [...DEFAULT, "subagent", "mcp", CODE_TOOL];
	assert.deepEqual(planTools(active, all, { codeMode: false, language: "javascript", sandbox: true, builtins: DEFAULT, off: [] }), {
		active: [...DEFAULT, "subagent", "mcp"],
		codeTools: [],
	});
	assert.deepEqual(planTools(active, all, { codeMode: true, language: "javascript", sandbox: true, builtins: ["read", "edit", "write"], off: ["mcp"] }), {
		active: ["subagent", CODE_TOOL],
		codeTools: ["read", "edit", "write"],
	});
	// Other tools keep their activation unless turned off; turnOn activates one.
	assert.deepEqual(planTools(["subagent", CODE_TOOL], all, { codeMode: false, language: "javascript", sandbox: true, builtins: ["grep"], off: [] }, ["lazy"]).active, [
		"grep",
		"subagent",
		"lazy",
	]);
	assert.deepEqual(planTools(active, all, { codeMode: true, language: "javascript", sandbox: true, builtins: BUILTINS, off: [] }).codeTools, BUILTINS);
});

test("inferBuiltins reads Pi's active set, including after code mode hid the built-ins", () => {
	assert.deepEqual(inferBuiltins([...DEFAULT, "subagent", CODE_TOOL]), DEFAULT);
	assert.deepEqual(inferBuiltins(["grep", "read"]), ["read", "grep"]);
	assert.deepEqual(inferBuiltins(["subagent", CODE_TOOL]), DEFAULT);
	assert.deepEqual(inferBuiltins(["subagent"]), []);
});

test("readState returns the latest valid tools-state entry on the branch", () => {
	const entry = (data: unknown, customType = STATE_ENTRY_TYPE) => ({ type: "custom", customType, data });
	assert.equal(readState([]), undefined);
	assert.deepEqual(
		readState([
			entry({ codeMode: true, builtins: ["read", 1], off: ["mcp"] }),
			entry({ codeMode: "x", builtins: [], off: [] }),
			entry({ codeMode: false, builtins: [] }),
			entry({ codeMode: false, builtins: [], off: [] }, "other"),
		]),
		{ codeMode: true, language: "javascript", sandbox: true, builtins: ["read"], off: ["mcp"] },
	);
	assert.equal(readState([entry({ codeMode: true, language: "python", builtins: [], off: [] })])?.language, "python");
	assert.equal(readState([entry({ codeMode: true, language: "ruby", builtins: [], off: [] })])?.language, "javascript");
	assert.equal(readState([entry({ codeMode: true, sandbox: false, builtins: [], off: [] })])?.sandbox, false);
});

test("sessions start unchanged with code mode off; /code-mode takes over and returns the enabled built-ins", async () => {
	const h = setup();
	await h.emit("session_start");
	assert.deepEqual(h.active(), [...DEFAULT, "subagent"]);
	assert.equal(h.statuses.get(CODE_MODE_FLAG), undefined);
	assert.equal(h.entries.length, 0, "starting a session writes nothing");

	await h.run("code-mode", "on");
	assert.deepEqual(h.active(), ["subagent", CODE_TOOL]);
	assert.equal(h.statuses.get(CODE_MODE_FLAG), "code mode · js");
	assert.deepEqual(h.lastState(), { codeMode: true, language: "javascript", sandbox: true, builtins: DEFAULT, off: [] });
	assert.match(h.notes.at(-1)!, /read, bash, edit, write run only inside execute_code/);
	assert.match(h.description(), /The enabled built-in tools \(read, bash, edit, write\)/);
	assert.doesNotMatch(h.description(), /^tools\.grep/m);

	await h.run("code-mode", "on");
	assert.match(h.notes.at(-1)!, /already on/);
	await h.run("code-mode", "sideways");
	assert.match(h.notes.at(-1)!, /Usage/);

	await h.run("code-mode");
	assert.deepEqual(h.active(), ["read", "bash", "edit", "write", "subagent"]);
	assert.equal(h.statuses.get(CODE_MODE_FLAG), undefined);
});

test("/tools turns tools on and off, and the execute_code prompt follows the built-ins inside it", async () => {
	const h = setup();
	await h.emit("session_start");
	await h.run("code-mode", "on");
	const panel = await h.openPanel();

	const model = (panel as any).model as ToolsPanelModel;
	model.setTool("grep", true);
	assert.deepEqual(h.active(), ["subagent", CODE_TOOL]);
	assert.match(h.description(), /read, bash, edit, write, grep\)/);
	assert.match(h.description(), /^tools\.grep\(/m);
	assert.match(h.tools.get(CODE_TOOL).promptSnippet, /\(read, bash, edit, write, grep\)/);

	model.setTool("bash", false);
	assert.doesNotMatch(h.description(), /^tools\.bash\(/m);
	assert.match(h.tools.get(CODE_TOOL).promptGuidelines[0], /^Code mode is on: read, edit, write, grep exist only/);
	const blocked = await h.emit("tool_call", { toolName: "bash", input: {} });
	assert.match(blocked.reason, /bash is turned off/);
	assert.match((await h.emit("tool_call", { toolName: "read", input: {} })).reason, /tools\.read\(\.\.\.\) inside execute_code/);

	model.setTool("subagent", false);
	assert.deepEqual(h.active(), [CODE_TOOL]);

	model.setCodeMode(false);
	assert.deepEqual(h.active(), ["read", "edit", "write", "grep"]);
	assert.equal(await h.emit("tool_call", { toolName: "bash", input: {} }), undefined);
	assert.deepEqual(h.lastState(), { codeMode: false, language: "javascript", sandbox: true, builtins: ["read", "edit", "write", "grep"], off: ["subagent"] });

	// Re-registration happens only when the set inside execute_code changes.
	const before = h.registrations();
	model.setTool("subagent", true);
	assert.equal(h.registrations(), before);
});

test("the /tools panel toggles code mode and tools from the keyboard", async () => {
	const h = setup();
	await h.emit("session_start");
	const panel = await h.openPanel();
	let lines = plain(panel.render(100));
	assert.equal(lines[0], "Tools");
	assert.match(lines[1]!, /^5 of 8 tools on$/);
	assert.ok(lines.some((line) => /Code mode\s+off/.test(line)));
	assert.ok(lines.some((line) => /grep\s+off/.test(line)));

	panel.handleInput(" ");
	assert.deepEqual(h.active(), ["subagent", CODE_TOOL]);
	lines = plain(panel.render(100));
	assert.match(lines[1]!, /^code mode \(js, sandboxed\) · execute_code: read, bash, edit, write · 1 other tools on$/);
	assert.ok(lines.some((line) => /read\s+code/.test(line)));
	assert.ok(lines.some((line) => /Sandbox\s+on/.test(line)));

	panel.handleInput(DOWN);
	panel.handleInput(" ");
	assert.equal(h.lastState().sandbox, false);
	assert.equal(h.statuses.get(CODE_MODE_FLAG), "code mode · js · unsandboxed");
	assert.match(plain(panel.render(100))[1]!, /\(js, unsandboxed\)/);
	panel.handleInput(" ");
	assert.equal(h.lastState().sandbox, true);

	panel.handleInput(DOWN);
	panel.handleInput(" ");
	assert.equal(h.lastState().language, "python");
	assert.equal(h.statuses.get(CODE_MODE_FLAG), "code mode · python");
	assert.ok(plain(panel.render(100)).some((line) => /Language\s+python/.test(line)));
	panel.handleInput(" ");
	assert.equal(h.lastState().language, "javascript");

	panel.handleInput(DOWN);
	panel.handleInput(" ");
	assert.deepEqual(h.lastState().builtins, ["bash", "edit", "write"]);
	assert.doesNotMatch(h.description(), /^tools\.read\(/m);

	for (let width = 1; width <= 120; width++) {
		for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
	}
	panel.handleInput("\x1b");
	assert.equal(h.ctx.panelClosed(), true);
});

test("a saved selection is restored on start, reload, and tree navigation", async () => {
	const saved = { codeMode: true, language: "javascript", sandbox: true, builtins: ["read", "bash", "write", "grep"], off: [] };
	const h = setup({ entries: [{ type: "custom", customType: STATE_ENTRY_TYPE, data: saved }] });
	await h.emit("session_start");
	assert.deepEqual(h.active(), ["subagent", CODE_TOOL]);
	assert.match(h.description(), /\(read, bash, write, grep\)/);

	h.entries.push({ type: "custom", customType: STATE_ENTRY_TYPE, data: { codeMode: false, language: "javascript", sandbox: true, builtins: [...DEFAULT, "grep"], off: ["subagent"] } });
	await h.emit("session_tree");
	assert.deepEqual(h.active(), ["read", "bash", "edit", "write", "grep"]);
});

test("the --code-mode flag applies only without a saved choice, and survives a reload", async () => {
	const flagged = setup({ flag: true });
	await flagged.emit("session_start");
	assert.deepEqual(flagged.active(), ["subagent", CODE_TOOL]);

	// After /reload Pi keeps the active set, where code mode had hidden the built-ins.
	const reloaded = setup({ flag: false, active: ["subagent", CODE_TOOL] });
	await reloaded.emit("session_start");
	await reloaded.run("code-mode", "on");
	await reloaded.run("code-mode", "off");
	assert.deepEqual(reloaded.active(), ["read", "bash", "edit", "write", "subagent"]);

	const chosen = setup({ flag: true, entries: [{ type: "custom", customType: STATE_ENTRY_TYPE, data: { codeMode: false, language: "javascript", sandbox: true, builtins: DEFAULT, off: [] } }] });
	await chosen.emit("session_start");
	assert.ok(chosen.active().includes("bash"));
	assert.ok(!chosen.active().includes(CODE_TOOL));
});

test("other extensions' activation choices survive; only explicit offs are enforced", async () => {
	// "lazy" is registered but held inactive by its extension (like MCP direct tools before a search).
	const h = setup({ extra: ["subagent", "lazy"], active: [...DEFAULT, "subagent"] });
	await h.emit("session_start");
	await h.run("code-mode", "on");
	assert.deepEqual(h.active(), ["subagent", CODE_TOOL]);
	h.pi.registerTool({ name: "mcp_search", description: "Search." });
	await h.run("code-mode", "off");
	assert.deepEqual(h.active(), [...DEFAULT, "subagent", "mcp_search"]);

	// The extension activates its tool later; our toggles keep it.
	h.pi.setActiveTools([...h.active(), "lazy"]);
	await h.run("code-mode", "on");
	assert.ok(h.active().includes("lazy"));

	const model = ((await h.openPanel()) as any).model as ToolsPanelModel;
	model.setTool("lazy", false);
	assert.ok(!h.active().includes("lazy"));
	h.pi.setActiveTools([...h.active(), "lazy"]);
	model.setCodeMode(false);
	assert.ok(!h.active().includes("lazy"), "an explicit off is enforced");
	model.setTool("lazy", true);
	assert.ok(h.active().includes("lazy"));
	assert.deepEqual(h.lastState().off, []);
});

test("skills stay listed in code mode through a tool inside execute_code", async () => {
	const h = setup();
	await h.emit("session_start");
	const skill = { name: "herdr", description: "Drive Herdr panes", filePath: "/skills/herdr/SKILL.md" };
	const prompt = async () => {
		const options = { selectedTools: [...h.active()], skills: [skill], sections: {} as Record<string, string> };
		await h.emit("before_agent_start", { systemPromptOptions: options });
		return options.sections.skills;
	};

	assert.equal(await prompt(), undefined);
	await h.run("code-mode", "on");
	assert.match((await prompt())!, /Load a skill's file with tools\.read inside execute_code/);
	assert.match((await prompt())!, /<name>herdr<\/name>/);

	const model = ((await h.openPanel()) as any).model as ToolsPanelModel;
	model.setTool("read", false);
	assert.match((await prompt())!, /with tools\.bash inside execute_code/);
	model.setTool("bash", false);
	assert.equal(await prompt(), undefined);
});

test("execute_code runs programs against only the enabled built-ins and reports nested calls", async () => {
	writeFileSync(join(cwd, "data.txt"), "a\nb\nc\n");
	const h = setup();
	await h.emit("session_start");
	await h.run("code-mode", "on");
	const tool = () => h.tools.get(CODE_TOOL);
	assert.deepEqual(tool().parameters.required, ["code"]);

	const ok = await tool().execute(
		"call-1",
		{ code: `const t = await tools.read({ path: "data.txt" }); console.log(t.trim().split("\\n").length, Object.keys(tools).join(","));` },
		undefined,
		undefined,
		h.ctx,
	);
	assert.equal(ok.content[0].text, "3 read,bash,edit,write");
	assert.equal(ok.details.exitCode, 0);
	assert.deepEqual(
		ok.details.calls.map((call: any) => [call.tool, call.label, call.status]),
		[["read", "data.txt", "ok"]],
	);

	const model = ((await h.openPanel()) as any).model as ToolsPanelModel;
	model.setTool("bash", false);
	model.setLanguage("python");
	const narrowed = await tool().execute("call-2", { code: "print(hasattr(tools, 'bash'), hasattr(tools, 'read'))" }, undefined, undefined, h.ctx);
	assert.equal(narrowed.content[0].text, "False True");

	const quiet = await tool().execute("call-3", { code: "x = 1" }, undefined, undefined, h.ctx);
	assert.equal(quiet.content[0].text, "(no output)");

	const updates: any[] = [];
	await assert.rejects(
		tool().execute(
			"call-4",
			{ code: `print("before")\ntools.read(path="missing.txt")` },
			undefined,
			(update: any) => updates.push(update),
			h.ctx,
		),
		(error: Error) => {
			assert.match(error.message, /before/);
			assert.match(error.message, /ToolError/);
			assert.match(error.message, /Program exited with code 1$/);
			return true;
		},
	);
	assert.equal(updates.at(-1).details.running, false);
	assert.deepEqual(
		updates.at(-1).details.calls.map((call: any) => call.status),
		["error"],
	);

	model.setLanguage("javascript");
	await assert.rejects(
		tool().execute("call-5", { code: "await new Promise(() => setInterval(() => {}, 1000));", timeout: 0.3 }, undefined, undefined, h.ctx),
		/Program timed out after 0.3 seconds/,
	);
});

test("execute_code accepts exactly one language, chosen in /tools", async () => {
	const h = setup();
	await h.emit("session_start");
	await h.run("code-mode", "on");
	const tool = () => h.tools.get(CODE_TOOL);
	assert.deepEqual(Object.keys(tool().parameters.properties), ["code", "timeout"]);
	assert.match(h.description(), /^Run a JavaScript \(Node\.js ES module\) program/);
	assert.match(h.description(), /Programs must be written in JavaScript\./);
	assert.match(h.description(), /^tools\.read\(\{ path, offset\?, limit\? \}\) → string$/m);
	assert.doesNotMatch(h.description(), /Python|print\(\)|open\(\)/);
	assert.match(tool().promptSnippet, /^Run a JavaScript program/);
	assert.ok(tool().promptGuidelines.includes("execute_code programs must be written in JavaScript."));
	const js = await tool().execute("l-1", { code: "console.log(typeof process.versions.node)" }, undefined, undefined, h.ctx);
	assert.equal(js.content[0].text, "string");

	const model = ((await h.openPanel()) as any).model as ToolsPanelModel;
	model.setLanguage("python");
	assert.match(h.notes.at(-1)!, /Python only/);
	assert.match(h.description(), /^Run a Python 3 program/);
	assert.match(h.description(), /^tools\.read\(path, offset=None, limit=None\) -> str$/m);
	assert.match(h.description(), /^ {2}- edits: list\[dict\] — /m);
	assert.match(h.description(), /^ {4}- oldText: str — Exact text/m);
	assert.doesNotMatch(h.description(), /JavaScript|await tools|console\.log|Promise\.all/);
	assert.match(tool().promptSnippet, /^Run a Python program/);
	const py = await tool().execute("l-2", { code: "import sys; print(sys.version_info[0])" }, undefined, undefined, h.ctx);
	assert.equal(py.content[0].text, "3");
	// JavaScript is no longer accepted: the same source now runs as Python.
	await assert.rejects(tool().execute("l-3", { code: "console.log(1)" }, undefined, undefined, h.ctx), /NameError: name 'console'/);

	// The choice is saved with the session and restored.
	const restored = setup({ entries: [...h.entries] });
	await restored.emit("session_start");
	assert.match(restored.description(), /^Run a Python 3 program/);
	assert.equal(restored.statuses.get(CODE_MODE_FLAG), "code mode · python");
});

test("the sandbox setting reaches the prompt and the program", async () => {
	const h = setup();
	await h.emit("session_start");
	await h.run("code-mode", "on");
	assert.match(h.description(), /The program runs in a sandbox: it cannot read or write files/);
	const tool = () => h.tools.get(CODE_TOOL);
	((await h.openPanel()) as any).model.setLanguage("python");
	const probe = {
		code: `try:\n    open("data.txt").read()\n    print("direct read allowed")\nexcept PermissionError:\n    print("direct read blocked")\nprint(tools.read(path="data.txt").splitlines()[0])`,
	};
	writeFileSync(join(cwd, "data.txt"), "a\nb\nc\n");
	const sandboxed = await tool().execute("s-1", probe, undefined, undefined, h.ctx);
	assert.equal(sandboxed.content[0].text, "direct read blocked\na");

	const model = ((await h.openPanel()) as any).model as ToolsPanelModel;
	model.setSandbox(false);
	assert.doesNotMatch(h.description(), /runs in a sandbox/);
	assert.match(h.notes.at(-1)!, /Sandbox off/);
	const open = await tool().execute("s-2", probe, undefined, undefined, h.ctx);
	assert.equal(open.content[0].text, "direct read allowed\na");
});

test("renderers stay within the terminal width", () => {
	const code = Array.from({ length: 12 }, (_, i) => `console.log("line ${i} ${"x".repeat(80)}")`).join("\n");
	const details = {
		language: "javascript",
		calls: [
			{ tool: "read", label: "src/很长的文件名/".repeat(6), status: "ok", durationMs: 12 },
			{ tool: "bash", label: "npm test", status: "error", error: "Command exited with code 1", durationMs: 2300 },
			{ tool: "grep", label: "TODO", status: "running" },
		],
		callCount: 9,
		running: false,
		durationMs: 4200,
	};
	const result = { content: [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `out ${i} ${"y".repeat(90)}`).join("\n") }], details };
	for (const expanded of [false, true]) {
		const call = renderCodeCall({ language: "javascript", code, timeout: 30 }, theme, { expanded });
		const res = renderCodeResult(result, { expanded, isPartial: false }, theme, { state: {}, isError: false });
		for (let width = 1; width <= 160; width++) {
			for (const line of [...call.render(width), ...res.render(width)]) {
				assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
			}
		}
	}
	const collapsedCall = plain(renderCodeCall({ language: "python", code }, theme, { expanded: false }).render(200));
	assert.match(collapsedCall[0]!, /^execute_code python · 12 lines$/);
	assert.equal(collapsedCall.at(-1), "  … 8 more lines");
	const collapsed = plain(renderCodeResult(result, { expanded: false, isPartial: false }, theme, { state: {}, isError: false }).render(200));
	assert.equal(collapsed[0], "  … 6 earlier calls");
	assert.ok(collapsed.includes("  … 12 earlier output lines"));
	assert.equal(collapsed.at(-1), "  4.2s");

	// A thrown result has no details; the renderer falls back to the last ones it saw.
	const state: any = {};
	renderCodeResult({ content: [], details }, { expanded: false, isPartial: true }, theme, { state, isError: false });
	const failed = plain(
		renderCodeResult({ content: [{ type: "text", text: "boom" }] }, { expanded: false, isPartial: false }, theme, { state, isError: true }).render(200),
	);
	assert.ok(failed.some((line) => line.includes("✗ bash npm test")));
	assert.ok(failed.includes("  boom"));
	assert.equal(CODE_MODE_ITEM.includes(":"), true);
});
