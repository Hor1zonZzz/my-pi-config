import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FAKE_RPC } from "./fake-rpc.ts";
import register from "./index.ts";
import { jobProgress, NOTICE_TYPE, noticeText, watchRunNotices } from "./notices.ts";
import { LiveRun, newSnapshot, RunRegistry, type RunSnapshot } from "./runs.ts";

const root = mkdtempSync(join(tmpdir(), "subagent-notices-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "agents"), { recursive: true });
writeFileSync(join(agentDir, "agents", "scout.md"), "---\nname: scout\ndescription: test scout\n---\nInspect code.");
const cwd = join(root, "work");
mkdirSync(cwd);
// A stand-in for `pi --mode rpc`: "hang" keeps running, anything else answers at once.
const script = join(root, "fake-pi.cjs");
writeFileSync(script, `
${FAKE_RPC}
onTask((task) => {
  if (task === 'hang') return void setInterval(() => {}, 1000);
  out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done ' + task }], stopReason: 'stop', usage: { output: 1 } } });
  settle();
});
`);
const originalScript = process.argv[1];
process.argv[1] = script;
process.on("exit", () => {
	process.argv[1] = originalScript;
	rmSync(root, { recursive: true, force: true });
});

function snapshot(fields: Partial<RunSnapshot> & { group: RunSnapshot["group"] }): RunSnapshot {
	return {
		...newSnapshot({ id: "r", parentSessionId: "s", agent: "scout", agentSource: "user", task: "t", cwd, mode: "async", group: fields.group, sessionDir: "/d", jobId: "subagent-j" }),
		status: "completed",
		...fields,
	};
}

test("only a run that finishes while its background job keeps going gets a notice", () => {
	const chain = (index: number, status: RunSnapshot["status"] = "completed") => snapshot({ group: { kind: "chain", index, total: 3 }, status });
	assert.equal(jobProgress(chain(0), []), 1);
	assert.equal(jobProgress(chain(1), []), 2);
	assert.equal(jobProgress(chain(2), []), undefined, "the last step ends the job; its completion message reports it");
	assert.equal(jobProgress(chain(0, "failed"), []), undefined, "a failed step stops the chain");
	assert.equal(jobProgress(chain(0, "running"), []), undefined);

	const part = (id: string, status: RunSnapshot["status"]) => snapshot({ id, group: { kind: "parallel", index: 0, total: 3 }, status });
	const runs = [part("a", "completed"), part("b", "failed"), part("c", "running")];
	assert.equal(jobProgress(runs[1]!, runs), 2);
	assert.equal(jobProgress(runs[1]!, [...runs.slice(0, 2), part("c", "completed")]), undefined, "the last one to finish ends the job");

	assert.equal(jobProgress(snapshot({ group: { kind: "single", index: 0, total: 1 } }), []), undefined, "single jobs have a completion message");
	assert.equal(jobProgress(snapshot({ group: { kind: "chain", index: 0, total: 3 }, mode: "sync", jobId: undefined }), []), undefined, "foreground runs are in the tool result");
});

test("a notice is one tagged line of JSON", () => {
	const text = noticeText({ job: "subagent-1a2b3c4d", run: "a3f9c2e1", agent: "scout", status: "cancelled", done: 2, total: 4, elapsedMs: 72_000 });
	assert.equal(text, '<subagent_notification>\n{"job":"subagent-1a2b3c4d","run":"a3f9c2e1","agent":"scout","status":"stopped","done":"2/4","elapsed":"1m 12s"}\n</subagent_notification>');
	assert.match(noticeText({ job: "j", run: "r", agent: "a", status: "failed", done: 1, total: 2, elapsedMs: 0 }, "No API key"), /"error":"No API key"/);
});

test("the watcher sends each qualifying run once, without a turn, and only for the active session", () => {
	const sent: Array<{ message: any; options: any }> = [];
	const pi = { sendMessage: (message: any, options: any) => sent.push({ message, options }) } as unknown as ExtensionAPI;
	const registry = new RunRegistry();
	let session = "s";
	watchRunNotices(pi, registry, { sessionId: () => session });
	const live = (id: string) => {
		const run = new LiveRun(snapshot({ id, status: "running", group: { kind: "parallel", index: 0, total: 3 } }));
		registry.add(run);
		return run;
	};
	const [a, b, c] = [live("aaaaaaaa-1"), live("bbbbbbbb-2"), live("cccccccc-3")];
	a.snapshot.status = "completed";
	registry.emit(a);
	registry.emit(a);
	assert.equal(sent.length, 1, "repeated change events do not repeat the notice");
	assert.equal(sent[0]!.message.customType, NOTICE_TYPE);
	assert.deepEqual(sent[0]!.options, { triggerTurn: false });
	assert.match(sent[0]!.message.content, /"run":"aaaaaaaa","agent":"scout","status":"completed","done":"1\/3"/);

	session = "other";
	b.snapshot.status = "failed";
	registry.emit(b);
	assert.equal(sent.length, 1, "a replaced session gets no notices for the old one's runs");

	session = "s";
	c.snapshot.status = "completed";
	registry.emit(c);
	assert.equal(sent.length, 1, "the run that ends the job is left to the completion message");
});

test("a parallel background job notices the early finisher, then delivers its completion", async () => {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const messages: Array<{ message: any; options: any }> = [];
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: true,
		model: { provider: "p", id: "m" },
		thinkingLevel: "high",
		sessionManager: { getSessionId: () => "sess-n", getSessionFile: () => undefined },
		ui: { notify() {}, confirm: async () => true, setStatus() {}, setWidget() {}, onTerminalInput: () => () => {} },
	};
	const pi = {
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerMessageRenderer() {},
		sendMessage: (message: any, options: any) => messages.push({ message, options }),
	} as unknown as ExtensionAPI;
	register(pi);
	const emit = async (name: string) => {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx);
	};
	await emit("session_start");
	try {
		const dispatched = await tools.get("subagent").execute("s1", { tasks: [{ agent: "scout", task: "quick" }, { agent: "scout", task: "hang" }], async: true }, undefined, undefined, ctx);
		const deadline = Date.now() + 5000;
		while (!messages.some((m) => m.message.customType === NOTICE_TYPE)) {
			assert.ok(Date.now() < deadline, "no notice for the early finisher");
			await delay(10);
		}
		const notice = messages.find((m) => m.message.customType === NOTICE_TYPE)!;
		assert.match(notice.message.content, new RegExp(`"job":"${dispatched.details.jobId}".*"status":"completed","done":"1/2"`));
		assert.deepEqual(notice.options, { triggerTurn: false });

		await commands.get("subagent-jobs").handler(`cancel ${dispatched.details.jobId}`, ctx);
		while (!messages.some((m) => m.message.customType === "subagent-completion")) {
			assert.ok(Date.now() < deadline + 10_000, "no completion message");
			await delay(10);
		}
		assert.deepEqual(messages.map((m) => m.message.customType), [NOTICE_TYPE, "subagent-completion"], "no notice duplicates the completion");
	} finally {
		await emit("session_shutdown");
	}
});
