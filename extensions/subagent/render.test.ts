import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyUsage } from "./format.ts";
import { bodyLines, completionComponent, expandedComponent, headerLine, panelLines, readDetails, type SubagentDetails } from "./render.ts";
import type { RunSnapshot } from "./runs.ts";

initTheme("dark");
const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t, italic: (t: string) => t } as any;
const NOW = 1_000_000;
const WIDTHS = [1, 8, 20, 40, 80, 160];

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		version: 1, id: "r", parentSessionId: "p", agent: "scout", agentSource: "user", task: "Find auth entry points 并总结调用关系", cwd: "/w",
		mode: "sync", group: { kind: "single", index: 0, total: 1 }, status: "completed", startedAt: NOW - 12_000, endedAt: NOW,
		usage: { ...emptyUsage(), output: 1200, input: 300, turns: 2 }, toolCalls: ["read src/auth.ts", "$ rg login"], sessionDir: "/home/me/.pi/agent/subagent-sessions/p",
		output: "Auth lives in src/auth.ts.\n\nDetails follow.", ...overrides,
	};
}

function details(overrides: Partial<SubagentDetails> = {}): SubagentDetails {
	return { version: 2, mode: "single", agentScope: "user", projectAgentsDir: null, runs: [run()], pending: [], ...overrides };
}

const parallel = details({
	mode: "parallel",
	runs: [
		run({ id: "a", group: { kind: "parallel", index: 0, total: 3 } }),
		run({ id: "b", agent: "worker", status: "running", endedAt: undefined, activity: "$ npm test", group: { kind: "parallel", index: 1, total: 3 } }),
	],
	pending: [{ agent: "reviewer", task: "review", index: 2 }],
});

test("tool rows fit every width", () => {
	const cases = [details(), parallel, details({ mode: "chain", runs: [run({ status: "failed", exitCode: 2 })] }), details({ dispatched: true, jobId: "subagent-ab12", runs: [] })];
	for (const width of WIDTHS) {
		for (const d of cases) {
			const lines = [headerLine(theme, { agent: "scout", task: "t", tasks: d.mode === "parallel" ? [{ agent: "a", task: "x" }, { agent: "b", task: "y" }, { agent: "c", task: "z" }] : undefined }, d, width, NOW), ...bodyLines(theme, d, width, NOW), ...expandedComponent(theme, d).render(width)];
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		}
	}
});

test("header summarizes mode, progress, time, and output tokens", () => {
	assert.match(headerLine(theme, { agent: "scout", task: "find auth" }, details(), 100, NOW), /^  ●  subagent  scout · find auth +12s · ↓1\.2k  $/);
	assert.match(headerLine(theme, { tasks: [{ agent: "a", task: "x" }, { agent: "b", task: "y" }, { agent: "c", task: "z" }] }, parallel, 100, NOW), /parallel · 1\/3 done/);
	assert.match(headerLine(theme, { chain: [{ agent: "a", task: "x" }, { agent: "b", task: "y" }] }, details({ mode: "chain" }), 100, NOW), /chain · step 1\/2/);
	assert.match(headerLine(theme, { agent: "scout", task: "t", async: true }, details({ dispatched: true, jobId: "subagent-ab12", runs: [] }), 100, NOW), /↗  subagent  scout · background subagent-ab12/);
	assert.match(headerLine(theme, { agent: "scout", task: "t" }, undefined, 100, NOW), /·  subagent  scout · t/);
});

test("collapsed body: activity while running, answer or error afterwards, a tree for groups", () => {
	assert.match(bodyLines(theme, details({ runs: [run({ status: "running", endedAt: undefined, activity: "read a.ts" })] }), 80, NOW)[0]!, /╰ read a\.ts/);
	assert.match(bodyLines(theme, details(), 80, NOW)[0]!, /╰ Auth lives in src\/auth\.ts\./);
	assert.match(bodyLines(theme, details({ runs: [run({ status: "failed", output: "boom" })] }), 80, NOW)[0]!, /╰ boom/);
	const tree = bodyLines(theme, parallel, 100, NOW);
	assert.equal(tree.length, 3);
	assert.match(tree[0]!, /├ ● scout .* 12s · ↓1\.2k/);
	assert.match(tree[1]!, /├ ⠋ worker .* \$ npm test · 12s/);
	assert.match(tree[2]!, /└ · reviewer .* queued/);
	assert.match(bodyLines(theme, details({ dispatched: true, runs: [] }), 120, NOW)[0]!, /press ↓ on an empty prompt/);
});

test("expanded view shows task, tool calls, answer, usage, and where the transcript is", () => {
	const text = expandedComponent(theme, details()).render(100).join("\n");
	for (const expected of [/Task: Find auth/, /→ read src\/auth\.ts/, /→ \$ rg login/, /Auth lives in src\/auth\.ts\./, /2 turns ↑300 ↓1\.2k/, /transcript: \/subagent-history · .*subagent-sessions\/p/]) {
		assert.match(text, expected);
	}
});

test("reads version 1 details from existing sessions", () => {
	const legacy = readDetails({
		mode: "parallel",
		agentScope: "user",
		projectAgentsDir: null,
		results: [
			{ agent: "scout", task: "a", exitCode: 0, messages: [{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "x.ts" } }, { type: "text", text: "found" }] }], usage: { ...emptyUsage(), output: 5 } },
			{ agent: "worker", task: "b", exitCode: 2, messages: [], stderr: "crashed" },
			{ agent: "worker", task: "c", exitCode: -1, messages: [] },
		],
	})!;
	assert.equal(legacy.version, 2);
	assert.deepEqual(legacy.runs.map((r) => r.status), ["completed", "failed", "running"]);
	assert.equal(legacy.runs[0]!.output, "found");
	assert.deepEqual(legacy.runs[0]!.toolCalls, ["read x.ts"]);
	assert.equal(legacy.runs[1]!.output, "crashed");
	assert.equal(readDetails(undefined), undefined);
	assert.equal(readDetails({ unrelated: true }), undefined);
	const dispatched = readDetails({ mode: "single", results: [], jobId: "subagent-1", status: "running" })!;
	assert.equal(dispatched.dispatched, true);
});

test("completion cards render current and legacy background results", () => {
	const current = completionComponent(theme, "Subagent job subagent-ab12 completed.", { jobId: "subagent-ab12", status: "completed", result: { content: [], details: details() } }, false).render(80);
	assert.match(current[0]!, /●  subagent  subagent-ab12 completed · scout/);
	assert.match(current[1]!, /╰ Auth lives in src\/auth\.ts\./);
	const expanded = completionComponent(theme, "x", { jobId: "j", status: "failed", result: { details: details({ runs: [run({ status: "failed", output: "boom" })] }) } }, true).render(80).join("\n");
	assert.match(expanded, /✕  subagent  j failed/);
	assert.match(expanded, /boom/);
	const legacy = completionComponent(theme, "Subagent job old completed.\n\nplain text", { jobId: "old", status: "completed", result: { details: {} } }, false).render(60);
	assert.ok(legacy.join("\n").includes("plain text"));
	for (const line of [...current, ...legacy]) assert.ok(visibleWidth(line) <= 80);
});

test("panel lines list running runs with activity", () => {
	const lines = panelLines(theme, [run({ status: "running", endedAt: undefined, activity: "read a.ts", mode: "async" })], 0, 90, NOW);
	assert.match(lines[0]!, /1 subagent running\s+·\s+↑↓ select · enter view · x stop · esc back/);
	assert.match(lines[1]!, /› ⠋ scout bg  Find auth .* read a\.ts · 12s/);
	assert.deepEqual(panelLines(theme, [], undefined, 80, NOW), []);
});
