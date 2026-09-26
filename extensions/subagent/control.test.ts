import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FAKE_RPC } from "./fake-rpc.ts";
import { type ControlEntry, readText, resolveRuns, waitUntil } from "./control.ts";
import register from "./index.ts";
import { LiveRun, newSnapshot, RunRegistry } from "./runs.ts";

const root = mkdtempSync(join(tmpdir(), "subagent-control-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "agents"), { recursive: true });
writeFileSync(join(agentDir, "agents", "scout.md"), "---\nname: scout\ndescription: test scout\n---\nInspect code.");
const cwd = join(root, "work");
mkdirSync(cwd);
// A stand-in for `pi --mode rpc`: "hang" keeps running, anything else answers at once.
const script = join(root, "fake-pi.cjs");
writeFileSync(script, `
const fs = require('node:fs'), path = require('node:path');
const argv = process.argv, arg = (name) => argv[argv.indexOf(name) + 1];
${FAKE_RPC}
// Pi writes <session dir>/<timestamp>_<session id>.jsonl; mirror that for message entries.
const file = path.join(arg('--session-dir'), '2026-01-01T00-00-00-000Z_' + arg('--session-id') + '.jsonl');
const emit = (e) => {
	out(e);
	if (e.type === 'message_end') fs.appendFileSync(file, JSON.stringify({ type: 'message', message: e.message }) + '\\n');
};
onTask((task) => {
	emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'Task: ' + task }] } });
	emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
	emit({ type: 'tool_execution_start', toolCallId: 'c', toolName: 'read', args: { path: 'src/auth.ts' } });
	if (task === 'hang') return void setInterval(() => {}, 1000);
	emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: { path: 'src/auth.ts' } }, { type: 'text', text: 'found it: ' + task }], stopReason: 'stop', usage: { output: 7 } } });
	settle();
});
`);
const originalScript = process.argv[1];
process.argv[1] = script;
process.on("exit", () => {
	process.argv[1] = originalScript;
	rmSync(root, { recursive: true, force: true });
});

function harness(sessionId = "sess-1") {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: true,
		model: { provider: "p", id: "m" },
		thinkingLevel: "high",
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
		ui: { notify() {}, confirm: async () => true, setStatus() {}, setWidget() {}, onTerminalInput: () => () => {} },
	};
	const pi = {
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerMessageRenderer() {},
		sendMessage() {},
	} as unknown as ExtensionAPI;
	register(pi);
	const emit = async (name: string) => {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx);
	};
	const control = async (params: object, signal?: AbortSignal) => {
		const result = await tools.get("subagent_control").execute("c", params, signal, undefined, ctx);
		return result.content[0].text as string;
	};
	return { ctx, tools, commands, emit, control };
}

test("the main agent can list, inspect, read, and wait for its subagents", async () => {
	const h = harness();
	await h.emit("session_start");
	try {
		assert.equal(await h.control({ action: "list" }), "No subagent runs in this session.");
		assert.equal(await h.control({ action: "wait" }), "No subagent runs are running.");

		await h.tools.get("subagent").execute("s1", { agent: "scout", task: "auth flow" }, undefined, undefined, h.ctx);
		const dispatched = await h.tools.get("subagent").execute("s2", { agent: "scout", task: "hang", async: true }, undefined, undefined, h.ctx);
		assert.match(dispatched.content[0].text, /subagent_control/);
		const jobId = dispatched.details.jobId as string;

		let list = "";
		const deadline = Date.now() + 5000;
		while (!/1 running/.test(list) || !/now: read src\/auth\.ts/.test(list)) {
			assert.ok(Date.now() < deadline, "the async run never reported its activity");
			list = await h.control({ action: "list" });
			await delay(10);
		}
		assert.match(list, /^2 runs · 1 running/);
		assert.match(list, /scout {2}completed · \d+s · ↓7\n {10}task: auth flow/);
		assert.match(list, new RegExp(`scout {2}running · bg ${jobId} · \\d+s · ↓0 · now: read src/auth\\.ts`));
		const [doneId, runningId] = [...list.matchAll(/^([0-9a-f]{8}) {2}scout/gm)].map((m) => m[1]!);

		const inspected = await h.control({ action: "inspect", run: runningId!.slice(0, 5) });
		assert.match(inspected, /· running · background job subagent-/);
		assert.match(inspected, /now: read src\/auth\.ts/);
		assert.match(inspected, /tool calls \(last 1 of 1\):\n {2}read src\/auth\.ts/);
		assert.match(await h.control({ action: "inspect", run: doneId }), /output:\nfound it: auth flow/);

		const read = await h.control({ action: "read", run: doneId });
		assert.match(read, /#1 user\n {2}Task: auth flow/);
		assert.match(read, /#2 assistant\n {2}→ read src\/auth\.ts\n {2}found it: auth flow/);
		assert.match(read, /messages 1-2 of 2$/);

		assert.match(await h.control({ action: "wait", run: runningId, timeout: 1 }), /^Still running after 1s\.[\s\S]*running: [0-9a-f]{8} scout \(read src\/auth\.ts\)/);
		assert.match(await h.control({ action: "wait", run: doneId }), /^Already finished\.\n\n[0-9a-f]{8} scout completed/);

		// With no run, wait returns as soon as any running run finishes.
		const waiting = h.control({ action: "wait", timeout: 30 });
		await h.commands.get("subagent-jobs").handler(`cancel ${jobId}`, h.ctx);
		assert.match(await waiting, /scout cancelled after/);
		assert.match(await h.control({ action: "list" }), /^2 runs · 0 running/);

		await assert.rejects(h.control({ action: "inspect" }), /inspect needs run/);
		await assert.rejects(h.control({ action: "read", run: "zzz" }), /No subagent run matches "zzz"/);
	} finally {
		await h.emit("session_shutdown");
	}
});

test("finished runs stay visible after a reload, and other sessions' runs do not", async () => {
	const first = harness("sess-reload");
	await first.emit("session_start");
	await first.tools.get("subagent").execute("s1", { agent: "scout", task: "persisted" }, undefined, undefined, first.ctx);
	await first.emit("session_shutdown");

	const again = harness("sess-reload");
	await again.emit("session_start");
	try {
		const list = await again.control({ action: "list" });
		assert.match(list, /^1 run · 0 running/);
		const id = /^([0-9a-f]{8})/m.exec(list.split("\n")[1]!)![1]!;
		assert.match(await again.control({ action: "read", run: id }), /found it: persisted/);
	} finally {
		await again.emit("session_shutdown");
	}

	const other = harness("sess-other");
	await other.emit("session_start");
	assert.equal(await other.control({ action: "list" }), "No subagent runs in this session.");
	await other.emit("session_shutdown");
});

function entry(id: string, jobId?: string): ControlEntry {
	const snapshot = newSnapshot({
		id,
		parentSessionId: "s",
		agent: "worker",
		agentSource: "user",
		task: "t",
		cwd,
		mode: jobId ? "async" : "sync",
		group: { kind: "single", index: 0, total: 1 },
		sessionDir: join(root, "none"),
		jobId,
	});
	return { snapshot, live: new LiveRun(snapshot) };
}

test("runs resolve by id, prefix, or job", () => {
	const entries = [entry("aaaa1111-x"), entry("aaaa2222-y", "subagent-j1"), entry("bbbb3333-z", "subagent-j1")];
	assert.equal(resolveRuns(entries, "aaaa1111-x")[0]!.snapshot.id, "aaaa1111-x");
	assert.equal(resolveRuns(entries, "bbbb")[0]!.snapshot.id, "bbbb3333-z");
	assert.equal(resolveRuns(entries, "subagent-j1").length, 2);
	assert.throws(() => resolveRuns(entries, "aaaa"), /"aaaa" matches 2 runs \(aaaa1111, aaaa2222\)/);
	assert.throws(() => resolveRuns(entries, "  "), /run is empty/);
});

test("read pages through long transcripts from the end", () => {
	const e = entry("cccc4444-w");
	for (let i = 1; i <= 30; i++) e.live!.messages.push({ role: "user", content: [{ type: "text", text: `m${i}` }], timestamp: 0 } as any);
	const tail = readText(e, undefined, 20);
	assert.match(tail, /^run cccc4444 · worker · running\n\n#11 user\n {2}m11/);
	assert.match(tail, /messages 11-30 of 30 · earlier: from 1$/);
	const middle = readText(e, 5, 3);
	assert.match(middle, /#5 user[\s\S]*#7 user/);
	assert.match(middle, /messages 5-7 of 30 · next: from 8 · earlier: from 2$/);
	assert.match(readText(e, 99, 5), /messages 30-30 of 30/);
	assert.match(readText(entry("dddd"), undefined, 5), /No transcript messages yet\./);
	const withPrompt = entry("eeee5555-v");
	withPrompt.live!.messages.push({ role: "system", content: [{ type: "text", text: "x".repeat(5000) }] } as any);
	assert.match(readText(withPrompt, undefined, 5), /#1 system prompt \(5000 chars, not shown\)\n\nmessages 1-1 of 1$/);
});

test("wait stops when the tool call is aborted", async () => {
	const registry = new RunRegistry();
	const controller = new AbortController();
	const waiting = waitUntil(registry, () => false, 10_000, controller.signal);
	controller.abort();
	await assert.rejects(waiting, /Wait cancelled/);
	assert.equal(await waitUntil(registry, () => false, 20), false);
});
