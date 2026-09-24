// @ts-nocheck -- Run with Node 24 and Pi 0.87.1 dependencies available.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { BackgroundJobs } from "./background.ts";
import register from "./index.ts";
import { toolDescription } from "./tool.ts";

// Child sessions are written under the agent directory; keep them out of ~/.pi/agent.
const agentDir = mkdtempSync(join(tmpdir(), "subagent-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));

async function until(predicate, timeout = 3000) {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "condition timed out");
		await delay(10);
	}
}

function harness(cwd = tmpdir()) {
	const messages = [], commands = new Map(), events = new Map(), tools = new Map();
	const ctx = {
		cwd, mode: "tui", hasUI: true, thinkingLevel: "high",
		model: { provider: "test", id: "model" },
		sessionManager: { getSessionId: () => "session-1" },
		ui: { setStatus() {}, notify() {}, confirm: async () => true },
	};
	const pi = {
		sendMessage: (message, options) => messages.push({ message, options }),
		registerCommand: (name, command) => commands.set(name, command),
		registerTool: (tool) => tools.set(tool.name, tool),
		registerMessageRenderer() {},
		on: (event, handler) => events.set(event, handler),
	};
	return { pi, ctx, messages, commands, events, tools };
}

test("background lifecycle: deferred dispatch, steer, failure, session isolation and cancellation", async (t) => {
	await t.test("returns before execution and reports success via steer with idle wakeup", async () => {
		const h = harness(), jobs = new BackgroundJobs(h.pi);
		let ran = false;
		const id = jobs.start(h.ctx, "scout: inspect auth", async () => {
			ran = true;
			return { content: [{ type: "text", text: "auth found" }], details: {} };
		});
		assert.equal(ran, false);
		assert.match(jobs.list(), new RegExp(id));
		await until(() => h.messages.length === 1);
		assert.deepEqual(h.messages[0].options, { deliverAs: "steer", triggerTurn: true });
		assert.match(h.messages[0].message.content, /auth found/);
		await jobs.shutdown();
	});
	await t.test("caught exceptions and error results become failed completions", async () => {
		const h = harness(), jobs = new BackgroundJobs(h.pi);
		jobs.start(h.ctx, "failure", async () => { throw new Error("spawn failed"); });
		jobs.start(h.ctx, "failure result", async () => ({ content: [{ type: "text", text: "bad result" }], details: {}, isError: true }));
		await until(() => h.messages.length === 2);
		assert.ok(h.messages.every(({ message }) => message.details.status === "failed"));
		await jobs.shutdown();
	});
	await t.test("shutdown cancels work, waits for cleanup and suppresses stale delivery", async () => {
		const h = harness(), jobs = new BackgroundJobs(h.pi);
		let started = false, cleaned = false;
		jobs.start(h.ctx, "pending", (signal) => new Promise((resolve) => {
			started = true;
			signal.addEventListener("abort", () => setTimeout(() => {
				cleaned = true;
				resolve({ content: [], details: {} });
			}, 20));
		}));
		await until(() => started);
		await jobs.shutdown();
		assert.equal(cleaned, true);
		assert.equal(h.messages.length, 0);
	});
	await t.test("changed owner session does not receive a completion", async () => {
		const h = harness(), jobs = new BackgroundJobs(h.pi);
		jobs.start(h.ctx, "old session", async () => ({ content: [], details: {} }));
		h.ctx.sessionManager.getSessionId = () => "session-2";
		await until(() => jobs.list() === "No background subagents running.");
		assert.equal(h.messages.length, 0);
		await jobs.shutdown();
	});
	await t.test("tree navigation cancels old jobs but permits new branch jobs", async () => {
		const h = harness(), jobs = new BackgroundJobs(h.pi);
		jobs.start(h.ctx, "old branch", async () => assert.fail("old job must not start"));
		await jobs.shutdown(false);
		jobs.start(h.ctx, "new branch", async () => ({ content: [{ type: "text", text: "new branch result" }], details: {} }));
		await until(() => h.messages.length === 1);
		assert.match(h.messages[0].message.content, /new branch result/);
		await jobs.shutdown();
	});
	await t.test("large output is bounded in context and retained in message details", async () => {
		const h = harness(), jobs = new BackgroundJobs(h.pi);
		const output = "结论".repeat(20000);
		jobs.start(h.ctx, "large output", async () => ({ content: [{ type: "text", text: output }], details: {} }));
		await until(() => h.messages.length === 1);
		assert.ok(Buffer.byteLength(h.messages[0].message.content) < 33 * 1024);
		assert.match(h.messages[0].message.content, /Truncated/);
		assert.equal(h.messages[0].message.details.result.content[0].text, output);
		await jobs.shutdown();
	});
	await t.test("cancellation before launch does not start work; capacity is bounded", async () => {
		const h = harness(), jobs = new BackgroundJobs(h.pi);
		let ran = false;
		const run = async () => { ran = true; return { content: [], details: {} }; };
		for (let i = 0; i < 4; i++) jobs.start(h.ctx, "queued", run);
		assert.throws(() => jobs.start(h.ctx, "extra", run), /At most 4/);
		assert.equal(jobs.cancel("all"), 4);
		await until(() => h.messages.length === 4);
		assert.equal(ran, false);
		assert.ok(h.messages.every(({ message }) => message.details.status === "cancelled"));
		await jobs.shutdown();
	});
});

test("subagent tool with real subprocesses and deterministic JSON output", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-test-"));
	const script = join(dir, "fake-pi.cjs"), originalScript = process.argv[1];
	mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
	writeFileSync(join(dir, ".pi", "agents", "scout.md"), "---\nname: scout\ndescription: test\n---\nInspect code.");
	writeFileSync(script, `
const fs = require('node:fs');
const task = process.argv.at(-1).replace(/^Task: /, '');
if (task === 'stubborn') {
  process.on('SIGTERM', () => {});
  fs.writeFileSync('ready', String(process.pid));
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => {
    if (task === 'fail') { process.stderr.write('child failed'); process.exit(2); }
    console.log(JSON.stringify({ type: 'message_end', message: {
      role: 'assistant', content: [{ type: 'text', text: 'result:' + task }],
      stopReason: 'stop', usage: { input: 1, output: 1 }
    }}));
  }, task === 'slow' ? 300 : 20);
}
`);
	process.argv[1] = script;
	const h = harness(dir);
	register(h.pi);
	const execute = (params, signal, update) => h.tools.get("subagent").execute("call", { agentScope: "project", ...params }, signal, update, h.ctx);
	try {
		await t.test("async dispatch returns before result and does not keep using the tool update callback", async () => {
			const controller = new AbortController();
			const response = await execute({ agent: "scout", task: "slow", async: true }, controller.signal, () => assert.fail("stale update"));
			assert.equal(response.details.dispatched, true);
			assert.match(response.details.jobId, /^subagent-/);
			assert.equal(h.messages.length, 0);
			controller.abort(); // Ending/cancelling the dispatch call must not cancel detached work.
			await until(() => h.messages.length === 1);
			assert.match(h.messages[0].message.content, /result:slow/);
		});
		await t.test("default synchronous mode still returns final output", async () => {
			const response = await execute({ agent: "scout", task: "sync" });
			assert.equal(response.content[0].text, "result:sync");
			assert.equal(h.messages.length, 1);
		});
		await t.test("async chain substitutes previous output; parallel failure is reported", async () => {
			await execute({ chain: [{ agent: "scout", task: "first" }, { agent: "scout", task: "next {previous}" }], async: true });
			await until(() => h.messages.length === 2);
			assert.match(h.messages[1].message.content, /result:next result:first/);
			await execute({ tasks: [{ agent: "scout", task: "ok" }, { agent: "scout", task: "fail" }], async: true });
			await until(() => h.messages.length === 3);
			assert.equal(h.messages[2].message.details.status, "failed");
			assert.match(h.messages[2].message.content, /child failed/);
		});
		await t.test("denied project confirmation launches nothing; single-shot mode and unknown agents fail early", async () => {
			h.ctx.ui.confirm = async () => false;
			const response = await execute({ agent: "scout", task: "no", async: true });
			assert.match(response.content[0].text, /Canceled/);
			h.ctx.ui.confirm = async () => true;
			h.ctx.mode = "json";
			await assert.rejects(execute({ agent: "scout", task: "no", async: true }), /TUI or RPC/);
			h.ctx.mode = "tui";
			await assert.rejects(execute({ agent: "missing", task: "no", async: true }), /Unknown agent: "missing"\. Available agents: "scout"\./);
			assert.equal(h.messages.length, 3);
		});
		await t.test("shutdown escalates SIGTERM to SIGKILL and waits for subprocess exit", async () => {
			await execute({ agent: "scout", task: "stubborn", async: true });
			await until(() => existsSync(join(dir, "ready")));
			const pid = Number(readFileSync(join(dir, "ready"), "utf8"));
			await h.events.get("session_shutdown")();
			assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
			assert.equal(h.messages.length, 3);
		});
	} finally {
		await h.events.get("session_shutdown")();
		process.argv[1] = originalScript;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tool description names the installed user agents", () => {
	const agent = (name, description) => ({ name, description, source: "user", systemPrompt: "", filePath: `/a/${name}.md` });
	const text = toolDescription([agent("scout", "Fast codebase recon"), agent("worker", "x".repeat(300))]);
	assert.match(text, /User agents \(use these exact names\): scout — Fast codebase recon; worker — x+…\./);
	assert.ok(text.length < 1000, "long agent descriptions are shortened");
	assert.match(toolDescription([]), /No user agents are installed\./);
});
