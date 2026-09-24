import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type ExtensionAPI, initTheme } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";

initTheme("dark");
const root = mkdtempSync(join(tmpdir(), "subagent-index-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "agents"), { recursive: true });
writeFileSync(join(agentDir, "agents", "scout.md"), "---\nname: scout\ndescription: test scout\n---\nInspect code.");
const cwd = join(root, "work");
mkdirSync(cwd);
const script = join(root, "fake-pi.cjs");
writeFileSync(script, `
const task = process.argv.at(-1).replace(/^Task: /, '');
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
out({ type: 'message_start', message: { role: 'assistant', content: [] } });
out({ type: 'tool_execution_start', toolCallId: 'c', toolName: 'read', args: { path: 'src/auth.ts' } });
if (task === 'wait') setInterval(() => {}, 1000);
else out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop', usage: { output: 3 } } });
`);
const originalScript = process.argv[1];
process.argv[1] = script;
process.on("exit", () => {
	process.argv[1] = originalScript;
	rmSync(root, { recursive: true, force: true });
});

const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t, italic: (t: string) => t } as any;

async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "condition timed out");
		await delay(10);
	}
}

function harness() {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const state = {
		editorText: "",
		focused: true,
		widget: undefined as undefined | { key: string; factory: any; options: any },
		input: undefined as undefined | ((data: string) => unknown),
		overlays: [] as Array<{ component: any; options: any; closed: boolean }>,
		notes: [] as string[],
	};
	const editor = { actionHandlers: new Map(), getText: () => state.editorText };
	const tui = { terminal: { rows: 30 }, requestRender() {}, getFocusedComponent: () => (state.focused ? editor : { dialog: true }) };
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: true,
		model: { provider: "p", id: "m" },
		thinkingLevel: "high",
		sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => undefined },
		ui: {
			notify: (message: string) => state.notes.push(message),
			confirm: async () => true,
			setStatus() {},
			setWidget: (key: string, factory: any, options: any) => (state.widget = factory ? { key, factory, options } : undefined),
			onTerminalInput: (handler: (data: string) => unknown) => {
				state.input = handler;
				return () => (state.input = undefined);
			},
			custom: (factory: any, options: any) =>
				new Promise<void>((resolve) => {
					const entry = { component: undefined as any, options, closed: false };
					entry.component = factory(tui, theme, {}, () => {
						entry.closed = true;
						entry.component.dispose?.();
						resolve();
					});
					state.overlays.push(entry);
				}),
		},
	};
	const pi = {
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerMessageRenderer() {},
		sendMessage() {},
	} as unknown as ExtensionAPI;
	register(pi);
	const emit = async (name: string, event: object = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
	};
	const panel = () => state.widget!.factory(tui, theme).render(90) as string[];
	return { ctx, state, commands, tools, emit, panel, key: (data: string) => state.input!(data) };
}

test("select a running subagent from the prompt, watch it, stop it, and find it in history", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	try {
	assert.equal(h.state.widget?.key, "subagent-runs");
	assert.deepEqual(h.state.widget?.options, { placement: "belowEditor" });
	assert.deepEqual(h.panel(), []);
	assert.equal(h.key("\x1b[B"), undefined, "nothing to select yet");

	const pending = h.tools.get("subagent").execute("call-1", { agent: "scout", task: "wait" }, undefined, undefined, h.ctx);
	await until(() => h.panel().length === 2 && /read src\/auth\.ts/.test(h.panel()[1]!));
	assert.match(h.panel()[0]!, /1 subagent running\s+·\s+↓ select/);

	h.state.editorText = "draft";
	assert.equal(h.key("\x1b[B"), undefined, "a non-empty prompt keeps ↓");
	h.state.editorText = "";
	assert.deepEqual(h.key("\x1b[B"), { consume: true });
	assert.match(h.panel()[1]!, /› ⠋|› [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);

	assert.deepEqual(h.key("\r"), { consume: true });
	const view = h.state.overlays[0]!;
	assert.equal(view.options.overlay, true);
	assert.match(view.component.render(80)[0], /scout running · foreground/);
	assert.equal(typeof view.component.dispose, "function");
	view.component.handleInput("x");
	view.component.handleInput("x");
	const result = await pending;
	assert.equal(result.isError, true);
	assert.equal(result.cancelled, true);
	assert.match(result.content[0].text, /stopped by the user/);
	assert.equal(result.details.runs[0].status, "cancelled");
	assert.deepEqual(h.panel(), [], "the panel empties once nothing runs");
	view.component.handleInput("\x1b");
	assert.equal(view.closed, true);

	await h.tools.get("subagent").execute("call-2", { agent: "scout", task: "quick" }, undefined, undefined, h.ctx);
	await h.commands.get("subagent-history").handler("", h.ctx);
	const history = h.state.overlays[1]!.component.render(90).join("\n");
	assert.match(history, /2 runs in this session/);
	assert.match(history, /scout {2}quick/);
	assert.match(history, /scout {2}wait/);

	} finally {
		// Stops any child left running by a failed assertion so the test process can exit.
		await h.emit("session_shutdown");
	}
	assert.equal(h.state.input, undefined);
});

test("Esc on the prompt is left alone when the panel is not selected", async () => {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	assert.equal(h.key("\x1b"), undefined);
	await h.emit("session_shutdown");
});
