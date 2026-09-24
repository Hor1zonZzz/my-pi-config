import assert from "node:assert/strict";
import test from "node:test";
import { type ExtensionAPI, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatStatus } from "../codex-statusline/index.ts";
import { parseWeekly } from "./format.ts";
import hairline from "./index.ts";
import { setTrueColorOverride } from "./style.ts";

setTrueColorOverride(true);
initTheme("dark");
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

function setup(mode = "tui") {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const tools: string[] = [];
	let command: any;
	const ui = {
		header: undefined as any,
		footer: undefined as any,
		editor: undefined as any,
		widgets: new Map<string, any>(),
		notes: [] as string[],
	};
	const branch: any[] = [];
	const renders: number[] = [];
	const fakeTui = { requestRender: () => renders.push(1), terminal: { rows: 40, columns: 100 } };
	const footerData = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map([["codex-quota", "me@example.com · weekly 63% left"]]),
		onBranchChange: () => () => {},
	};
	const ctx = {
		mode,
		hasUI: true,
		cwd: "/tmp/demo",
		model: { id: "gpt-5.6-sol", provider: "openai-codex" },
		modelRegistry: { isUsingOAuth: () => true },
		sessionManager: { getBranch: () => branch },
		getContextUsage: () => ({ tokens: 114_000, contextWindow: 272_000, percent: 42 }),
		isProjectTrusted: () => false,
		ui: {
			setHeader: (factory: any) => (ui.header = factory),
			setFooter: (factory: any) => (ui.footer = factory),
			setEditorComponent: (factory: any) => (ui.editor = factory),
			getEditorComponent: () => ui.editor,
			setWidget: (key: string, factory: any) => (factory ? ui.widgets.set(key, factory) : ui.widgets.delete(key)),
			notify: (message: string) => ui.notes.push(message),
		},
	};
	hairline({
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerTool: (tool: any) => tools.push(tool.name),
		registerCommand: (name: string, options: any) => {
			assert.equal(name, "hairline");
			command = options;
		},
		getThinkingLevel: () => "medium",
	} as unknown as ExtensionAPI);
	const emit = async (name: string, event: object = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, ctx);
	};
	const hud = () => ui.widgets.get("hairline-hud")?.(fakeTui, {}).render(100).map(plain);
	return {
		ctx, ui, tools, branch, renders, emit, fakeTui, footerData, hud,
		run: (args: string) => command.handler(args, ctx),
		complete: (prefix: string) => command.getArgumentCompletions(prefix),
	};
}

test("installs header, editor, footer, and HUD only in the TUI", async () => {
	const t = setup();
	assert.deepEqual(t.tools, ["read", "bash", "edit", "write"]);
	await t.emit("session_start", { reason: "startup" });
	const header = t.ui.header(t.fakeTui, {}).render(100);
	for (const line of header) assert.ok(visibleWidth(line) <= 100);
	assert.match(header.map(plain).join("\n"), /pi \d+\.\d+\.\d+ +gpt-5\.6-sol · medium/);
	const footer = t.ui.footer(t.fakeTui, {}, t.footerData).render(140).map(plain);
	assert.match(footer[0]!, /\/tmp\/demo  main .*\$0\.000 sub  ·  me@example\.com  $/, "weekly moves to the HUD");
	assert.deepEqual(t.hud(), [`  speed    ${"▁".repeat(16)}  waiting for the first reply    weekly  ━━━━━━────  63% left`]);

	const print = setup("print");
	await print.emit("session_start", { reason: "startup" });
	assert.equal(print.ui.header, undefined);
	assert.equal(print.ui.editor, undefined);
	assert.equal(print.ui.widgets.size, 0);
});

test("editor keeps only top and bottom rules and embeds working status", async () => {
	const t = setup();
	await t.emit("session_start", { reason: "startup" });
	const editor = t.ui.editor(t.fakeTui, { borderColor: (s: string) => s, selectList: {} }, {});
	let lines = editor.render(80);
	for (const line of lines) assert.ok(visibleWidth(line) <= 80);
	assert.equal(plain(lines[0]), "─".repeat(80));
	assert.match(plain(lines[lines.length - 1]), /^─ gpt-5\.6-sol · medium ─+ context ▰▰▰▰▱▱▱▱▱▱ 42% ─$/);
	assert.equal(editor.embedWorkingStatus, true);

	await t.emit("agent_start");
	await t.emit("tool_execution_start", { toolCallId: "1", toolName: "bash", args: {} });
	editor.setWorkingStatusIndicator({ kind: "working", renderInBorder: () => "Working..." });
	lines = editor.render(80);
	assert.match(plain(lines[0]), /^─ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Running bash · 0s ─+$/);
	await t.emit("tool_execution_end", { toolCallId: "1", toolName: "bash", isError: true });
	assert.match(plain(editor.render(80)[0]), /Thinking · 0s ✕ 1 error/);

	editor.setWorkingStatusIndicator({ kind: "retry", renderInBorder: () => "Retrying (1/3) in 5s..." });
	assert.match(plain(editor.render(80)[0]), /^─ Retrying \(1\/3\) in 5s\.\.\. ─+$/);

	editor.setWorkingStatusIndicator(undefined);
	editor.setText("!ls");
	assert.match(editor.render(80)[0], /38;2;159;227;207/, "bash mode tints the rules mint");
});

test("measures speed from assistant messages and keeps usage totals", async () => {
	const t = setup();
	await t.emit("session_start", { reason: "startup" });
	// Pi calls footer and widget factories immediately; this binds footer data and the TUI used for redraws.
	t.ui.footer(t.fakeTui, {}, t.footerData);
	t.hud();
	const realNow = Date.now;
	let now = 1_000;
	Date.now = () => now;
	try {
		await t.emit("agent_start");
		await t.emit("turn_start", { turnIndex: 0, timestamp: now });
		await t.emit("message_start", { message: { role: "assistant" } });
		now += 10_000;
		const message = { role: "assistant", stopReason: "stop", usage: { input: 12_400, output: 510, cost: { total: 0.01 } } };
		t.branch.push({ type: "message", message });
		await t.emit("message_end", { message });
		await t.emit("message_start", { message: { role: "assistant" } });
		now += 5_000;
		await t.emit("message_end", { message: { role: "assistant", stopReason: "aborted", usage: { output: 9_000 } } });
		now += 3_000;
		await t.emit("agent_end", { messages: [] });
		assert.deepEqual(t.hud(), [`  speed    ${"▁".repeat(15)}█  51 tok/s       weekly  ${"━".repeat(13)}${"─".repeat(7)}  63% left`]);
		const footer = plain(t.ui.footer(t.fakeTui, {}, t.footerData).render(140)[0]);
		assert.match(footer, /↑12k ↓510  ·  \$0\.010 sub/);
		assert.ok(t.renders.length > 0);
	} finally {
		Date.now = realNow;
	}
});

test("HUD reads codex-statusline's weekly wording", async () => {
	const now = 1_000_000;
	const cached = { version: 1, attemptedAt: now, nextCheckAt: now + 60_000, state: "ok", quota: { remainingPercent: 63 } } as any;
	assert.deepEqual(parseWeekly(formatStatus("me@example.com", cached, now)), { percent: 63, stale: false });
	assert.deepEqual(parseWeekly(formatStatus("me@example.com", { ...cached, state: "error" }, now)), { percent: 63, stale: true });
	assert.equal(parseWeekly(formatStatus("me@example.com", undefined, now)), "loading");
	assert.equal(parseWeekly(formatStatus("me@example.com", { ...cached, state: "error", quota: undefined }, now)), "unavailable");

	const t = setup();
	await t.emit("session_start", { reason: "startup" });
	t.footerData.getExtensionStatuses = () => new Map();
	t.ui.footer(t.fakeTui, {}, t.footerData);
	assert.deepEqual(t.hud(), [`  speed    ${"▁".repeat(16)}  waiting for the first reply`], "no weekly segment without Codex status");
});

test("/hairline switches the skin and the HUD", async () => {
	const t = setup();
	await t.emit("session_start", { reason: "startup" });
	await t.run("hud off");
	assert.equal(t.ui.widgets.has("hairline-hud"), false);
	const footer = () => plain(t.ui.footer(t.fakeTui, {}, t.footerData).render(140)[0]);
	assert.match(footer(), /me@example\.com · weekly 63% left  $/, "without the HUD the footer keeps the weekly text");
	assert.ok(t.ui.header);
	await t.run("hud on");
	assert.equal(t.ui.widgets.has("hairline-hud"), true);
	assert.match(footer(), /me@example\.com  $/);
	await t.run("off");
	assert.equal(t.ui.header, undefined);
	assert.equal(t.ui.footer, undefined);
	assert.equal(t.ui.editor, undefined);
	assert.equal(t.ui.widgets.size, 0);
	await t.run("hud on");
	assert.equal(t.ui.widgets.size, 0, "HUD waits until the skin is on");
	await t.run("on");
	assert.ok(t.ui.header && t.ui.footer && t.ui.editor && t.ui.widgets.has("hairline-hud"));
	await t.run("");
	assert.equal(t.ui.notes[t.ui.notes.length - 1], "Hairline on · HUD on");
	await t.run("sparkle");
	assert.match(t.ui.notes[t.ui.notes.length - 1]!, /^Usage: \/hairline/);
	assert.deepEqual(t.complete("h").map((item: any) => item.value), ["hud on", "hud off"]);
	assert.equal(t.complete("x"), null);
});
