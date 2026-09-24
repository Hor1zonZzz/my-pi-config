import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyUsage } from "./format.ts";
import type { RunSnapshot } from "./runs.ts";
import { HistoryView, messageLines, RunView } from "./viewer.ts";

initTheme("dark");
const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t, italic: (t: string) => t } as any;
const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b" };

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		version: 1, id: "r1", parentSessionId: "p", agent: "scout", agentSource: "user", task: "find auth", cwd: "/w", mode: "sync",
		group: { kind: "single", index: 0, total: 1 }, status: "running", startedAt: Date.now() - 5000, usage: emptyUsage(), toolCalls: [], sessionDir: "/s", ...overrides,
	};
}

const messages: any[] = [
	{ role: "user", content: "Task: find auth" },
	{ role: "assistant", content: [{ type: "thinking", thinking: Array.from({ length: 12 }, (_, i) => `step ${i}`).join("\n") }, { type: "toolCall", id: "1", name: "read", arguments: { path: "src/auth.ts" } }] },
	{ role: "toolResult", toolCallId: "1", toolName: "read", content: [{ type: "text", text: "line a\nline b" }], isError: false },
	{ role: "toolResult", toolCallId: "2", toolName: "bash", content: [{ type: "text", text: "permission denied" }], isError: true },
	...Array.from({ length: 30 }, (_, i) => ({ role: "assistant", content: [{ type: "text", text: `answer paragraph ${i}` }] })),
];

test("transcript lines show tasks, thinking previews, tool calls, results, and errors", () => {
	const text = messageLines(theme, messages, 80, false).join("\n");
	assert.match(text, /▸ task\n +Task: find auth/);
	assert.match(text, /∴ thinking/);
	assert.match(text, /… 8 more lines · t to show/);
	assert.match(text, /→ read src\/auth\.ts/);
	assert.match(text, /↳ 2 lines · line a/);
	assert.match(text, /↳ permission denied/);
	assert.match(text, /answer paragraph 29/);
	assert.doesNotMatch(messageLines(theme, messages, 80, true).join("\n"), /more lines/);
});

function view(status: RunSnapshot["status"] = "running") {
	const state = { closed: 0, stopped: [] as string[], renders: 0 };
	const tui = { terminal: { rows: 20 }, requestRender: () => state.renders++ };
	const source = { snapshot: snapshot({ status }), messages, streaming: status === "running" ? { thinking: "", text: "typing" } : undefined };
	const v = new RunView({ theme, tui, source: () => source, onClose: () => state.closed++, onStop: (id) => state.stopped.push(id) });
	return { v, state, source };
}

test("run view fills the screen, follows new output, and scrolls", () => {
	const { v } = view();
	const lines = v.render(70);
	assert.equal(lines.length, 20, "the view covers the whole screen");
	for (const line of lines) assert.equal(visibleWidth(line), 70);
	assert.match(lines[0]!, /scout running · foreground/);
	assert.match(lines.join("\n"), /typing▍/, "follows the streaming tail");
	v.handleInput(KEY.up);
	v.handleInput(KEY.up);
	assert.doesNotMatch(v.render(70).join("\n"), /typing▍/, "scrolling up stops following");
	v.handleInput("G");
	assert.match(v.render(70).join("\n"), /typing▍/);
	v.handleInput("g");
	assert.match(v.render(70).join("\n"), /▸ task/);
});

test("run view stops only after two presses of x and closes on Esc", () => {
	const { v, state } = view();
	v.handleInput("x");
	assert.deepEqual(state.stopped, []);
	assert.match(v.render(70).at(-1)!, /press x again to stop scout/);
	v.handleInput("x");
	assert.deepEqual(state.stopped, ["r1"]);
	v.handleInput(KEY.escape);
	assert.equal(state.closed, 1);
	const done = view("completed");
	done.v.handleInput("x");
	done.v.handleInput("x");
	assert.deepEqual(done.state.stopped, [], "finished runs cannot be stopped");
	assert.doesNotMatch(done.v.render(70).at(-1)!, /x stop/);
});

test("history lists runs, opens a transcript, and returns to the list", () => {
	const state = { closed: 0, opened: [] as string[] };
	const tui = { terminal: { rows: 16 }, requestRender() {} };
	const items = [
		{ snapshot: snapshot({ id: "new", status: "running" }) },
		{ snapshot: snapshot({ id: "old", agent: "worker", status: "completed", startedAt: Date.now() - 3_600_000, endedAt: Date.now() - 3_500_000 }) },
	];
	const h = new HistoryView({
		theme,
		tui,
		load: () => items,
		open: (item) => {
			state.opened.push(item.snapshot.id);
			return { snapshot: item.snapshot, messages };
		},
		onClose: () => state.closed++,
		onStop: () => {},
	});
	const list = h.render(90);
	assert.match(list[0]!, /Subagent history  2 runs in this session/);
	assert.match(list[2]!, /› [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] scout/);
	assert.match(list[3]!, /worker .* 1m 40s · ↓0 · 1h ago/);
	h.handleInput(KEY.down);
	h.handleInput(KEY.enter);
	assert.deepEqual(state.opened, ["old"]);
	assert.match(h.render(90)[0]!, /worker completed/);
	h.handleInput(KEY.escape);
	assert.match(h.render(90)[0]!, /Subagent history/);
	h.handleInput(KEY.escape);
	assert.equal(state.closed, 1);

	const direct = new HistoryView({ theme, tui, load: () => items, open: (item) => ({ snapshot: item.snapshot, messages: [] }), onClose() {}, onStop() {}, initialRunId: "old" });
	assert.match(direct.render(90)[0]!, /worker completed/);
	const empty = new HistoryView({ theme, tui, load: () => [], open: (item) => ({ snapshot: item.snapshot, messages: [] }), onClose() {}, onStop() {} });
	assert.match(empty.render(60).join("\n"), /No subagent runs recorded/);
});
