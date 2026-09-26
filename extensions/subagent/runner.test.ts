import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentConfig } from "./agents.ts";
import { FAKE_RPC } from "./fake-rpc.ts";
import { applyEvent, buildArgs, runAgent, taskCommand } from "./runner.ts";
import { LiveRun, newSnapshot, RunRegistry } from "./runs.ts";
import { findSessionFile, listRuns, parentSessionDir, readSessionMessages } from "./store.ts";

// getAgentDir() reads this at call time; keep child sessions out of ~/.pi/agent.
const root = mkdtempSync(join(tmpdir(), "subagent-runner-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const cwd = join(root, "work");
const script = join(root, "fake-pi.cjs");
mkdirSync(cwd, { recursive: true });

// A stand-in for `pi --mode rpc`: commands on stdin, JSON records on stdout, a session file on disk.
writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv;
const arg = (name) => argv[argv.indexOf(name) + 1];
${FAKE_RPC}
process.stderr.write("Warning: No project session found with id '" + arg('--session-id') + "'; creating a new session with that id.\\n");
process.on('exit', () => fs.writeFileSync('received-' + arg('--session-id') + '.json', JSON.stringify(received)));
const answer = (text) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage: { output: 1 } });
onTask((task) => {
  if (task === 'wait') {
    fs.writeFileSync('started', '1');
    out({ type: 'message_start', message: { role: 'assistant', content: [] } });
    out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' } });
    setInterval(() => {}, 1000);
    return;
  }
  if (task === 'fail') {
    // Pi's RPC mode routes an extension's direct terminal writes (notify.ts's OSC) to stderr.
    process.stderr.write('\\x1b]777;notify;Pi;Ready for input\\x07boom');
    process.exit(3);
  }
  if (task === 'reject') return false;
  if (task === 'env') {
    out({ type: 'message_end', message: answer('child env ' + process.env.PI_SUBAGENT_CHILD) });
    settle();
    return;
  }
  if (task === 'dialog') {
    out({ type: 'extension_ui_request', id: 'ui-1', method: 'notify', message: 'hello' });
    out({ type: 'extension_ui_request', id: 'ui-2', method: 'confirm', title: 'Sure?', message: 'x' });
    const poll = setInterval(() => {
      const reply = received.find((c) => c.type === 'extension_ui_response' && c.id === 'ui-2');
      if (!reply) return;
      clearInterval(poll);
      // An extension writing a terminal notification straight to stdout, as notify.ts does.
      process.stdout.write('\\x1b]777;notify;Pi;Ready for input\\x07');
      const notifyReplies = received.filter((c) => c.id === 'ui-1').length;
      out({ type: 'message_end', message: answer('dialog ' + JSON.stringify(reply) + ' notify replies ' + notifyReplies) });
      settle();
    }, 5);
    return;
  }
  const user = { role: 'user', content: 'Task: ' + task };
  const call = { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } };
  out({ type: 'message_end', message: user });
  out({ type: 'message_start', message: { role: 'assistant', content: [] } });
  out({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' } });
  out({ type: 'message_end', message: { role: 'assistant', content: [call], stopReason: 'toolUse', usage: { input: 5, output: 7, cost: { total: 0.001 } } } });
  out({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts' } });
  const result = { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'x\\ny' }], isError: false };
  out({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'read', result, isError: false });
  out({ type: 'message_end', message: result });
  const final = { role: 'assistant', content: [{ type: 'text', text: 'done:' + task }], stopReason: 'stop', model: 'fake-model', usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.002 } } };
  out({ type: 'message_end', message: final });
  const lines = [{ type: 'session', id: arg('--session-id') }, { type: 'message', message: user }, { type: 'message', message: final }, 'torn'];
  fs.writeFileSync(path.join(arg('--session-dir'), '2026-01-01T00-00-00-000Z_' + arg('--session-id') + '.jsonl'),
    lines.map((l) => typeof l === 'string' ? l : JSON.stringify(l)).join('\\n'));
  settle();
});
`);
const originalScript = process.argv[1];
process.argv[1] = script;
process.on("exit", () => {
	process.argv[1] = originalScript;
	rmSync(root, { recursive: true, force: true });
});

const agent: AgentConfig = { name: "scout", description: "test", systemPrompt: "Inspect code.", source: "user", filePath: join(root, "scout.md") };

function request(task: string, registry = new RunRegistry(), signal?: AbortSignal) {
	const changes: string[] = [];
	return {
		changes,
		registry,
		promise: runAgent({
			agent,
			task,
			cwd,
			defaults: { model: "openai-codex/gpt-5.6-sol", thinkingLevel: "high" },
			mode: "sync",
			group: { kind: "single", index: 0, total: 1 },
			parentSessionId: "parent-1",
			signal,
			registry,
			onChange: (run) => changes.push(run.snapshot.status),
		}),
	};
}

async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "condition timed out");
		await delay(10);
	}
}

test("builds a persisted child session instead of --no-session", () => {
	const base = { agent, task: "find auth", cwd, defaults: { model: "p/m", thinkingLevel: "high" as const }, mode: "sync" as const, group: { kind: "single" as const, index: 0, total: 1 }, parentSessionId: "p", registry: new RunRegistry() };
	const args = buildArgs(base, "run-1", "/sessions/p", "/tmp/prompt.md");
	assert.ok(!args.includes("--no-session"));
	assert.deepEqual(args.slice(0, 6), ["--mode", "rpc", "--session-dir", "/sessions/p", "--session-id", "run-1"]);
	assert.equal(args[args.indexOf("--name") + 1], "scout · find auth");
	assert.equal(args[args.indexOf("--model") + 1], "p/m");
	assert.equal(args[args.indexOf("--thinking") + 1], "high");
	assert.ok(!args.some((arg) => arg.startsWith("Task:")), "RPC mode receives the task on stdin");
	assert.deepEqual(JSON.parse(taskCommand("find auth")), { id: "task", type: "prompt", message: "Task: find auth" });
	assert.ok(taskCommand("a\nb").endsWith("}\n") && taskCommand("a\nb").split("\n").length === 2, "one JSONL record");
	const own = buildArgs({ ...base, agent: { ...agent, model: "x/y" } }, "run-2", "/s");
	assert.equal(own[own.indexOf("--model") + 1], "x/y");
	assert.ok(!own.includes("--thinking"), "an agent with its own model does not inherit the dispatch thinking level");
});

test("applies streaming, tool, and message events to the live run", () => {
	const run = new LiveRun(newSnapshot({ id: "r", parentSessionId: "p", agent: "scout", agentSource: "user", task: "t", cwd, mode: "sync", group: { kind: "single", index: 0, total: 1 }, sessionDir: "/s" }));
	assert.equal(applyEvent(run, { type: "message_start", message: { role: "assistant" } }), true);
	applyEvent(run, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "plan" } });
	applyEvent(run, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
	applyEvent(run, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } });
	assert.deepEqual(run.streaming, { thinking: "plan", text: "Hello" });
	assert.equal(run.snapshot.activity, "writing");
	applyEvent(run, { type: "tool_execution_start", toolName: "bash", args: { command: "git status" } });
	assert.equal(run.snapshot.activity, "$ git status");
	assert.deepEqual(run.snapshot.toolCalls, ["$ git status"]);
	applyEvent(run, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello" }], stopReason: "stop", usage: { input: 3, output: 4, cacheRead: 5, totalTokens: 12, cost: { total: 0.5 } } } });
	assert.equal(run.streaming, undefined);
	assert.equal(run.snapshot.output, "Hello");
	assert.deepEqual({ ...run.snapshot.usage }, { input: 3, output: 4, cacheRead: 5, cacheWrite: 0, cost: 0.5, contextTokens: 12, turns: 1 });
	assert.equal(applyEvent(run, { type: "unknown" }), false);
});

test("runs a child to completion and saves its session and metadata", async () => {
	const { promise, registry, changes } = request("hello");
	const run = await promise;
	const s = run.snapshot;
	assert.equal(s.status, "completed");
	assert.equal(s.output, "done:hello");
	assert.equal(s.usage.output, 27);
	assert.equal(s.usage.turns, 2);
	assert.equal(s.model, "openai-codex/gpt-5.6-sol");
	assert.deepEqual(s.toolCalls, ["read a.ts"]);
	assert.equal(s.stderr, undefined, "the expected --session-id warning is dropped");
	assert.equal(s.activity, undefined);
	assert.ok(changes.includes("running") && changes.at(-1) === "completed");
	assert.equal(registry.get(s.id), run);
	assert.equal(run.messages.filter((m) => m.role === "toolResult").length, 1);

	const dir = parentSessionDir("parent-1");
	assert.equal(s.sessionDir, dir);
	const stored = listRuns(dir).find((r) => r.id === s.id);
	assert.equal(stored?.status, "completed");
	assert.equal((stored as { activity?: string } | undefined)?.activity, undefined);
	const file = findSessionFile(dir, s.id);
	assert.ok(file && existsSync(file));
	assert.deepEqual(readSessionMessages(file!).map((m) => m.role), ["user", "assistant"]);
});

test("reports failures with stderr", async () => {
	const run = await request("fail").promise;
	assert.equal(run.snapshot.status, "failed");
	assert.equal(run.snapshot.exitCode, 3);
	assert.equal(run.snapshot.output, "boom", "terminal escapes are stripped from stderr");
	assert.doesNotMatch(run.snapshot.stderr ?? "", /No project session/);
});

test("a user stop cancels only that run and resolves", async () => {
	rmSync(join(cwd, "started"), { force: true });
	const { promise, registry } = request("wait");
	await until(() => existsSync(join(cwd, "started")) && registry.running().length === 1);
	await until(() => registry.running()[0]!.streaming?.text === "partial");
	assert.equal(registry.running()[0]!.stop(), true);
	const run = await promise;
	assert.equal(run.snapshot.status, "cancelled");
	assert.match(run.snapshot.output ?? "", /Stopped by the user/);
	assert.equal(run.stop(), false, "a finished run cannot be stopped again");
	assert.equal(JSON.parse(readFileSync(join(run.snapshot.sessionDir, `${run.id}.meta.json`), "utf8")).status, "cancelled");
	const received = JSON.parse(readFileSync(join(cwd, `received-${run.id}.json`), "utf8"));
	assert.deepEqual(received.map((c: { type: string }) => c.type), ["prompt", "abort"], "stop asks Pi to abort before closing stdin");
});

test("answers dialogs with cancel, ignores notifications and stray escapes, and marks children", async () => {
	const dialog = (await request("dialog").promise).snapshot;
	assert.equal(dialog.status, "completed");
	assert.equal(dialog.output, 'dialog {"type":"extension_ui_response","id":"ui-2","cancelled":true} notify replies 0');
	assert.equal((await request("env").promise).snapshot.output, "child env 1");
});

test("a rejected task fails the run", async () => {
	const run = (await request("reject").promise).snapshot;
	assert.equal(run.status, "failed");
	assert.equal(run.output, "prompt rejected");
});

test("aborting the parent kills the child, records cancelled, and throws", async () => {
	rmSync(join(cwd, "started"), { force: true });
	const controller = new AbortController();
	const { promise, registry } = request("wait", new RunRegistry(), controller.signal);
	await until(() => existsSync(join(cwd, "started")));
	controller.abort();
	await assert.rejects(promise, /aborted/);
	const run = registry.list()[0]!;
	assert.equal(run.snapshot.status, "cancelled");
	assert.match(run.snapshot.output ?? "", /parent/);
	await assert.rejects(request("never", new RunRegistry(), controller.signal).promise, /abort/i);
});

test("lists recorded runs newest first and skips unreadable metadata", async () => {
	const dir = parentSessionDir("parent-1");
	writeFileSync(join(dir, "broken.meta.json"), "{");
	const runs = listRuns(dir);
	assert.ok(runs.length >= 4);
	for (let i = 1; i < runs.length; i++) assert.ok(runs[i - 1]!.startedAt >= runs[i]!.startedAt);
	assert.deepEqual(listRuns(join(root, "missing")), []);
	assert.equal(findSessionFile(join(root, "missing"), "x"), undefined);
});
