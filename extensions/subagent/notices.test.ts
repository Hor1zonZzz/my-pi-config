import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FAKE_RPC } from "./fake-rpc.ts";
import register from "./index.ts";
import { endsJob, NOTICE_TYPE, noticeText, watchRunNotices } from "./notices.ts";
import { finalAnswers } from "./tool.ts";
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
  if (task === 'boom') { process.stderr.write('boom failed'); process.exit(2); }
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

test("the run whose finish ends its job is left to the job's final message", () => {
	const chain = (index: number, status: RunSnapshot["status"] = "completed") => snapshot({ group: { kind: "chain", index, total: 3 }, status });
	assert.equal(endsJob(chain(0), []), false);
	assert.equal(endsJob(chain(2), []), true, "the last step");
	assert.equal(endsJob(chain(0, "failed"), []), true, "a failed step stops the chain");
	const part = (id: string, status: RunSnapshot["status"]) => snapshot({ id, group: { kind: "parallel", index: 0, total: 3 }, status });
	assert.equal(endsJob(part("b", "failed"), [part("a", "completed"), part("b", "failed"), part("c", "running")]), false);
	assert.equal(endsJob(part("c", "completed"), [part("a", "completed"), part("b", "failed"), part("c", "completed")]), true);
	assert.equal(endsJob(snapshot({ group: { kind: "single", index: 0, total: 1 } }), []), true);
});

test("a notice carries only the run and its status", () => {
	assert.equal(noticeText("a3f9c2e1", "cancelled"), '<subagent_notification>\n{"run":"a3f9c2e1","status":"stopped"}\n</subagent_notification>');
	assert.equal(noticeText("a3f9c2e1", "running"), '<subagent_notification>\n{"run":"a3f9c2e1","status":"running"}\n</subagent_notification>');
});

test("a parallel run that finishes early delivers its answer at once; starts, the job's end, and cancels send nothing", () => {
	const sent: Array<{ message: any; options: any }> = [];
	const pi = { sendMessage: (message: any, options: any) => sent.push({ message, options }) } as unknown as ExtensionAPI;
	const registry = new RunRegistry();
	let session = "s";
	watchRunNotices(pi, registry, { sessionId: () => session });
	// Five parallel tasks: four start together, the fifth waits for a slot.
	const live = (index: number) => {
		const run = new LiveRun(snapshot({ id: `run0000${index}-x`, status: "running", group: { kind: "parallel", index, total: 5 }, output: `answer ${index}` }));
		registry.add(run);
		return run;
	};
	const runs = [0, 1, 2, 3].map(live);
	registry.emit(runs[0]);
	assert.equal(sent.length, 0, "starting and activity send nothing");

	runs[0]!.snapshot.status = "completed";
	registry.emit(runs[0]);
	registry.emit(runs[0]);
	assert.equal(sent.length, 1, "delivered once");
	assert.equal(sent[0]!.message.customType, "subagent-completion");
	assert.equal(sent[0]!.message.content, '<subagent_result run="run00000" agent="scout" status="completed">\nanswer 0\n</subagent_result>');
	assert.deepEqual(sent[0]!.options, { deliverAs: "steer", triggerTurn: true }, "it wakes the main agent");
	assert.equal(runs[0]!.delivered, true);

	const fifth = live(4);
	assert.equal(sent.length, 1, "a queued task starting is not reported");

	session = "other";
	runs[1]!.snapshot.status = "failed";
	registry.emit(runs[1]);
	assert.equal(sent.length, 1, "a replaced session gets nothing for the old one's runs");
	session = "s";

	runs[2]!.stoppedBy = "user";
	runs[2]!.snapshot.status = "cancelled";
	registry.emit(runs[2]);
	assert.match(sent[1]!.message.content, /run="run00002" agent="scout" status="stopped"/, "a stop from the panel is news to the main agent");
	runs[3]!.stoppedBy = "agent";
	runs[3]!.snapshot.status = "cancelled";
	registry.emit(runs[3]);
	assert.equal(sent.length, 2, "the main agent's own stop is already in its tool result");

	fifth.snapshot.status = "completed";
	registry.emit(fifth);
	assert.equal(sent.length, 2, "the run that ends the job is left to the final message");
});

test("chain steps keep their one-line notices", () => {
	const sent: Array<{ message: any; options: any }> = [];
	const pi = { sendMessage: (message: any, options: any) => sent.push({ message, options }) } as unknown as ExtensionAPI;
	const registry = new RunRegistry();
	watchRunNotices(pi, registry, { sessionId: () => "s" });
	const step = (index: number) => {
		const run = new LiveRun(snapshot({ id: `step000${index}-x`, status: "running", group: { kind: "chain", index, total: 3 } }));
		registry.add(run);
		return run;
	};
	const first = step(0);
	first.snapshot.status = "completed";
	registry.emit(first);
	const second = step(1);
	second.snapshot.status = "completed";
	registry.emit(second);
	const last = step(2);
	last.snapshot.status = "completed";
	registry.emit(last);
	assert.deepEqual(sent.map((m) => JSON.parse(m.message.content.split("\n")[1])), [
		{ run: "step0000", status: "completed" },
		{ run: "step0001", status: "running" },
		{ run: "step0001", status: "completed" },
		{ run: "step0002", status: "running" },
	]);
	assert.ok(sent.every((m) => m.message.customType === NOTICE_TYPE && m.options.triggerTurn === false));
});

test("a parallel background job delivers the early finisher's answer, then the rest with the job's end", async () => {
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
		while (!messages.some((m) => m.message.customType === "subagent-completion")) {
			assert.ok(Date.now() < deadline, "no early answer");
			await delay(10);
		}
		const [quickId, hangId] = dispatched.details.runIds as string[];
		const [quickFile, hangFile] = dispatched.details.sessionFiles as string[];
		assert.match(dispatched.content[0].text, /^Started background job subagent-[0-9a-f]{8}\. Each run's answer arrives as a <subagent_result> message when it finishes; do not repeat or poll this work\./);
		// The dispatch result names each run, its first state, and its session file.
		assert.equal(dispatched.content[0].text.split("\n").slice(1).join("\n"), `${quickId} scout running ${quickFile}\n${hangId} scout running ${hangFile}`);
		assert.ok(existsSync(quickFile!) && existsSync(hangFile!), "the files exist as soon as the result is returned");
		const early = messages[0]!;
		assert.equal(early.message.content, `<subagent_result run="${quickId}" agent="scout" status="completed">\ndone quick\n</subagent_result>`);
		assert.deepEqual(early.options, { deliverAs: "steer", triggerTurn: true });

		await commands.get("subagent-jobs").handler(`cancel ${dispatched.details.jobId}`, ctx);
		while (messages.length < 2) {
			assert.ok(Date.now() < deadline + 10_000, "no final message");
			await delay(10);
		}
		assert.equal(messages.length, 2);
		assert.match(messages[1]!.message.content, new RegExp(`Background job ${dispatched.details.jobId} cancelled\\.$`));
		assert.doesNotMatch(messages[1]!.message.content, /done quick/, "the early answer is not repeated");
	} finally {
		await emit("session_shutdown");
	}
});

test("a background job's final message gives every task's status and answer", () => {
	const reserved = ["aaaaaaaa-1", "bbbbbbbb-2", "cccccccc-3"].map((id) => ({ id, sessionFile: `/d/${id.slice(0, 8)}.jsonl` }));
	const runs = [
		snapshot({ id: "aaaaaaaa-1", group: { kind: "chain", index: 0, total: 3 }, output: "found it" }),
		snapshot({ id: "bbbbbbbb-2", agent: "worker", group: { kind: "chain", index: 1, total: 3 }, status: "failed", output: "No API key" }),
	];
	assert.equal(finalAnswers(runs, [{ agent: "scout" }, { agent: "worker" }, { agent: "reviewer" }], reserved), [
		'<subagent_result run="aaaaaaaa" agent="scout" status="completed">',
		"found it",
		"</subagent_result>",
		'<subagent_result run="bbbbbbbb" agent="worker" status="failed">',
		"No API key",
		"</subagent_result>",
		'<subagent_result run="cccccccc" agent="reviewer" status="not started"/>',
	].join("\n"));
	assert.equal(finalAnswers(runs, [{ agent: "scout" }, { agent: "worker" }, { agent: "reviewer" }], reserved, new Set(["aaaaaaaa-1"])).split("\n")[0], '<subagent_result run="bbbbbbbb" agent="worker" status="failed">', "an answer delivered early is not repeated");
	const long = finalAnswers([snapshot({ id: "aaaaaaaa-1", group: { kind: "single", index: 0, total: 1 }, output: "x".repeat(20_000), sessionFile: "/d/aaaaaaaa.jsonl" })], [{ agent: "scout" }], reserved);
	assert.match(long, /Output truncated: \d+ bytes omitted\. The full text is in \/d\/aaaaaaaa\.jsonl\./);
});

test("a stopped chain names the transcript it wrote and leaves no files for steps that never ran", async () => {
	const tools = new Map<string, any>();
	const pi = { on() {}, registerCommand() {}, registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer() {}, sendMessage() {} } as unknown as ExtensionAPI;
	register(pi);
	const ctx = { cwd, mode: "tui", hasUI: true, model: { provider: "p", id: "m" }, thinkingLevel: "high", sessionManager: { getSessionId: () => "sess-chain" }, ui: { notify() {}, confirm: async () => true, setStatus() {} } };
	const result = await tools.get("subagent").execute("c", { chain: [{ agent: "scout", task: "boom" }, { agent: "scout", task: "after" }] }, undefined, undefined, ctx);
	assert.equal(result.isError, true);
	const [first, second] = result.details.sessionFiles as string[];
	assert.match(result.content[0].text, new RegExp(`Chain stopped at step 1[\\s\\S]*Transcripts:\\n[0-9a-f]{8} scout ${first!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
	assert.equal(existsSync(first!), true);
	assert.equal(existsSync(second!), false, "the step that never ran leaves no empty file");
});
