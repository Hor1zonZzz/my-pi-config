import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FAKE_RPC } from "./fake-rpc.ts";
import register from "./index.ts";
import { NOTICE_TYPE } from "./notices.ts";

const root = mkdtempSync(join(tmpdir(), "subagent-control-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "agents"), { recursive: true });
writeFileSync(join(agentDir, "agents", "scout.md"), "---\nname: scout\ndescription: test scout\n---\nInspect code.");
const cwd = join(root, "work");
mkdirSync(cwd);
// A stand-in for `pi --mode rpc` that reacts to steer, abort, and a second prompt as Pi does.
const script = join(root, "fake-pi.cjs");
writeFileSync(script, `
const path = require('node:path');
const argv = process.argv, arg = (name) => argv[argv.indexOf(name) + 1];
${FAKE_RPC}
const answer = (text) => out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage: { output: 1 } } });
onTask((task) => {
  out({ type: 'agent_start' });
  if (task === 'wait') {
    out({ type: 'tool_execution_start', toolCallId: 'c', toolName: 'read', args: { path: 'a.ts' } });
    globalThis.onCommand = (command) => {
      if (command.type === 'steer') setImmediate(() => { answer('steered: ' + command.message); settle(); });
      // An abort leaves the child idle and settled, then the interrupt's prompt starts a new run.
      if (command.type === 'abort') {
        out({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted' } });
        settle();
      }
      if (command.type === 'prompt') setImmediate(() => { out({ type: 'agent_start' }); answer('redirected: ' + command.message); settle(); });
    };
    return;
  }
  // A continued run gets the message itself as its first prompt, on the same session file.
  answer('done ' + task + ' @ ' + path.basename(arg('--session')));
  settle();
});
`);
const originalScript = process.argv[1];
process.argv[1] = script;
process.on("exit", () => {
	process.argv[1] = originalScript;
	rmSync(root, { recursive: true, force: true });
});

function harness() {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const tools = new Map<string, any>();
	const messages: Array<{ message: any; options: any }> = [];
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: true,
		model: { provider: "p", id: "m" },
		thinkingLevel: "high",
		sessionManager: { getSessionId: () => "sess-c", getSessionFile: () => undefined },
		ui: { notify() {}, confirm: async () => true, setStatus() {}, setWidget() {}, onTerminalInput: () => () => {} },
	};
	const pi = {
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand() {},
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerMessageRenderer() {},
		sendMessage: (message: any, options: any) => messages.push({ message, options }),
	} as unknown as ExtensionAPI;
	register(pi);
	const emit = async (name: string) => {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx);
	};
	const dispatchTasks = (tasks: Array<{ agent: string; task: string }>) => tools.get("subagent").execute("p", { tasks, async: true }, undefined, undefined, ctx);
	const dispatch = async (task: string) => {
		const result = await tools.get("subagent").execute("s", { agent: "scout", task, async: true }, undefined, undefined, ctx);
		return result.details.runIds[0] as string;
	};
	const control = async (params: object) => (await tools.get("subagent_control").execute("c", params, undefined, undefined, ctx)).content[0].text as string;
	const finals = () => messages.filter((m) => m.message.customType === "subagent-completion").map((m) => String(m.message.content));
	return { emit, dispatch, dispatchTasks, control, finals, messages };
}

async function until(predicate: () => boolean, what: string, timeout = 8000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, what);
		await delay(10);
	}
}

test("send steers a running run after its current step", async () => {
	const h = harness();
	await h.emit("session_start");
	try {
		const id = await h.dispatch("wait");
		await delay(300);
		assert.equal(await h.control({ action: "send", run: id, message: "check b.ts too" }), `Sent to ${id}; it sees the message after its current step.`);
		await until(() => h.finals().length === 1, "no final answer");
		assert.match(h.finals()[0]!, new RegExp(`<subagent_result run="${id}" agent="scout" status="completed">\\nsteered: check b.ts too\\n`));
	} finally {
		await h.emit("session_shutdown");
	}
});

test("send with interrupt aborts the current step and keeps the run going on the new message", async () => {
	const h = harness();
	await h.emit("session_start");
	try {
		const id = await h.dispatch("wait");
		await delay(300);
		assert.equal(await h.control({ action: "send", run: id, message: "look at c.ts instead", interrupt: true }), `Interrupted ${id}; it is working on your message now.`);
		await until(() => h.finals().length === 1, "no final answer");
		// Had the abort's settle closed stdin, the child would have exited before the new prompt.
		assert.match(h.finals()[0]!, /status="completed">\nredirected: look at c\.ts instead\n/);
	} finally {
		await h.emit("session_shutdown");
	}
});

test("stop ends a running run, reports it in the result, and adds no notice of its own", async () => {
	const h = harness();
	await h.emit("session_start");
	try {
		const id = await h.dispatch("wait");
		await delay(300);
		assert.equal(await h.control({ action: "stop", run: id }), `${id} stopped.`);
		assert.equal(await h.control({ action: "stop", run: id }), `${id} is already stopped.`);
		await until(() => h.finals().length === 1, "no final message");
		assert.match(h.finals()[0]!, /status="stopped">\nStopped by the main agent before it finished\./);
		assert.equal(h.messages.filter((m) => m.message.customType === NOTICE_TYPE).length, 0);
	} finally {
		await h.emit("session_shutdown");
	}
});

test("send to a finished run continues it on its own session file in the background", async () => {
	const h = harness();
	await h.emit("session_start");
	try {
		const id = await h.dispatch("first");
		await until(() => h.finals().length === 1, "the first run did not finish");
		const started = await h.control({ action: "send", run: id.slice(0, 5), message: "now the tests" });
		assert.match(started, new RegExp(`^Continued ${id} in background job subagent-[0-9a-f]{8}; its answer arrives when it finishes\\.\\n${id} scout running /.*/${id}\\.jsonl$`));
		await until(() => h.finals().length === 2, "the continued run did not finish");
		assert.match(h.finals()[1]!, new RegExp(`<subagent_result run="${id}" agent="scout" status="completed">\\ndone now the tests @ ${id}\\.jsonl\\n`));
		assert.equal(h.messages.filter((m) => m.message.customType === NOTICE_TYPE).length, 0, "a continued run's restart is in the tool result, not a notice");
	} finally {
		await h.emit("session_shutdown");
	}
});

test("control reports unknown runs and a missing message", async () => {
	const h = harness();
	await h.emit("session_start");
	try {
		await assert.rejects(h.control({ action: "stop", run: "zzzz" }), /No subagent run "zzzz" in this session\./);
		const id = await h.dispatch("first");
		await assert.rejects(h.control({ action: "send", run: id }), /send needs a message\./);
	} finally {
		await h.emit("session_shutdown");
	}
});

test("a run can be messaged right after dispatch", async () => {
	const h = harness();
	await h.emit("session_start");
	try {
		const id = await h.dispatch("wait");
		// No delay: the background job has not registered the run yet.
		assert.equal(await h.control({ action: "send", run: id, message: "hurry" }), `Sent to ${id}; it sees the message after its current step.`);
		await until(() => h.finals().length === 1, "no final answer");
		assert.match(h.finals()[0]!, /steered: hurry/);
	} finally {
		await h.emit("session_shutdown");
	}
});

test("a queued task stopped before its turn never starts and leaves no file", async () => {
	const h = harness();
	await h.emit("session_start");
	try {
		// Four start together; the fifth waits for a slot.
		const tasks = Array.from({ length: 5 }, () => ({ agent: "scout", task: "wait" }));
		const result = await h.dispatchTasks(tasks);
		const ids = result.details.runIds as string[];
		const files = result.details.sessionFiles as string[];
		assert.match(result.content[0].text, new RegExp(`\\n${ids[4]} scout queued `));
		assert.equal(await h.control({ action: "stop", run: ids[4] }), `${ids[4]} will not start.`);
		await delay(300);
		for (const id of ids.slice(0, 4)) assert.equal(await h.control({ action: "stop", run: id }), `${id} stopped.`);
		await until(() => h.finals().length === 1, "no final message");
		assert.match(h.finals()[0]!, new RegExp(`<subagent_result run="${ids[4]}" agent="scout" status="stopped">\\nStopped by the main agent before it started\\.`));
		assert.equal(existsSync(files[4]!), false);
		assert.equal(h.messages.filter((m) => m.message.customType === NOTICE_TYPE).length, 0, "the agent's own stops are not noticed");
	} finally {
		await h.emit("session_shutdown");
	}
});
