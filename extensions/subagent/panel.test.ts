import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { RunPanel, STOP_CONFIRM_MS } from "./panel.ts";
import { LiveRun, newSnapshot, RunRegistry } from "./runs.ts";

const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b" };
const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => `[${t}]`, bold: (t: string) => t, italic: (t: string) => t } as any;

function setup(count = 2) {
	const registry = new RunRegistry();
	const runs = Array.from({ length: count }, (_, i) => {
		const run = new LiveRun(newSnapshot({ id: `r${i}`, parentSessionId: "p", agent: i ? "worker" : "scout", agentSource: "user", task: `task ${i}`, cwd: "/", mode: i ? "async" : "sync", group: { kind: "parallel", index: i, total: count }, sessionDir: "/s" }));
		registry.add(run);
		return run;
	});
	const state = { focused: true, empty: true, clock: 1_000_000, opened: [] as string[], stopped: [] as string[], renders: 0 };
	const panel = new RunPanel(registry, {
		isEditorFocused: () => state.focused,
		isEditorEmpty: () => state.empty,
		requestRender: () => state.renders++,
		open: (id) => state.opened.push(id),
		stop: (id) => state.stopped.push(id),
		now: () => state.clock,
	});
	return { registry, runs, state, panel, key: (data: string) => panel.handleInput(data) };
}

test("↓ enters the list only from an empty, focused prompt with running subagents", () => {
	const empty = setup(0);
	assert.equal(empty.key(KEY.down), undefined);
	const t = setup();
	t.state.empty = false;
	assert.equal(t.key(KEY.down), undefined);
	t.state.empty = true;
	t.state.focused = false;
	assert.equal(t.key(KEY.down), undefined);
	t.state.focused = true;
	assert.equal(t.key(KEY.up), undefined, "↑ is left to the editor");
	assert.deepEqual(t.key(KEY.down), { consume: true });
	assert.equal(t.panel.selectedIndex(), 0);
});

test("↑↓ move the selection; ↑ from the top returns to the editor", () => {
	const t = setup();
	t.key(KEY.down);
	t.key(KEY.down);
	assert.equal(t.panel.selectedIndex(), 1);
	t.key(KEY.down);
	assert.equal(t.panel.selectedIndex(), 1, "stays on the last row");
	t.key(KEY.up);
	assert.equal(t.panel.selectedIndex(), 0);
	assert.deepEqual(t.key(KEY.up), { consume: true });
	assert.equal(t.panel.active, false);
});

test("enter opens the run; x twice within the window stops it", () => {
	const t = setup();
	t.key(KEY.down);
	t.key(KEY.down);
	assert.deepEqual(t.key(KEY.enter), { consume: true });
	assert.deepEqual(t.state.opened, ["r1"]);
	assert.equal(t.panel.active, true, "the list stays selected after the view closes");
	t.key("x");
	assert.deepEqual(t.state.stopped, []);
	assert.match(t.panel.lines(theme, 80)[0]!, /press x again to stop worker/);
	t.state.clock += STOP_CONFIRM_MS + 1;
	t.key("x");
	assert.deepEqual(t.state.stopped, [], "a late second press re-arms instead of stopping");
	t.key("x");
	assert.deepEqual(t.state.stopped, ["r1"]);
});

test("Esc is consumed so it does not interrupt the main agent; other keys go to the editor", () => {
	const t = setup();
	t.key(KEY.down);
	assert.deepEqual(t.key(KEY.escape), { consume: true });
	assert.equal(t.panel.active, false);
	t.key(KEY.down);
	assert.equal(t.key("a"), undefined);
	assert.equal(t.panel.active, false);
	t.key(KEY.down);
	t.state.focused = false;
	assert.equal(t.key(KEY.down), undefined, "a dialog took focus");
	assert.equal(t.panel.active, false);
});

test("the selection follows its run and the panel empties when runs finish", () => {
	const t = setup(3);
	t.key(KEY.down);
	t.key(KEY.down);
	assert.equal(t.panel.selectedIndex(), 1);
	t.runs[0]!.snapshot.status = "completed";
	assert.equal(t.panel.selectedIndex(), 0, "still on r1, now the first running row");
	for (const run of t.runs) run.snapshot.status = "completed";
	assert.deepEqual(t.panel.lines(theme, 80), []);
	assert.equal(t.panel.active, false);
});

test("panel lines fit the width and mark the selected row", () => {
	const t = setup();
	for (const width of [1, 10, 40, 80, 200]) {
		for (const line of t.panel.lines(theme, width)) assert.ok(visibleWidth(line) <= width + 2, `${width}: ${line}`);
	}
	assert.match(t.panel.lines(theme, 80)[0]!, /2 subagents running\s+·\s+↓ select/);
	t.key(KEY.down);
	const lines = t.panel.lines(theme, 80);
	assert.match(lines[0]!, /running\s+·\s+↑↓ select · enter view · x stop · esc back/);
	assert.match(lines[1]!, /^\[  › /);
	assert.match(lines[2]!, /worker bg/);
});
