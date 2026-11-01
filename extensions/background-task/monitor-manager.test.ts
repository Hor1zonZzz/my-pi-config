import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MonitorManager } from "./monitor-manager.ts";
import { clampTimeout, DEFAULT_TIMEOUT_MS, eventMessage, MAX_TIMEOUT_MS, type MonitorRecord } from "./monitor-format.ts";
import { exec } from "./test-exec.ts";

type Sent = { message: { content: string; details: Record<string, unknown> }; options: unknown };

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "monitor-"));
	const sent: Sent[] = [];
	const statuses: (string | undefined)[] = [];
	const manager = new MonitorManager(exec, (message, options) => sent.push({ message, options }));
	manager.startSession({ sessionId: "s1", scratchpad: root, setStatus: (text) => statuses.push(text) });
	t.after(async () => {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	});
	const start = (command: string, timeoutMs?: number) =>
		manager.start({ command, description: "test watch", cwd: root, timeoutMs });
	const events = () => sent.filter((entry) => entry.message.details.kind === "event");
	const ends = () => sent.filter((entry) => entry.message.details.kind === "end");
	return { root, manager, sent, statuses, start, events, ends };
}

const WAKE = { deliverAs: "steer", triggerTurn: true };
const QUIET = { triggerTurn: false };

test("delivers batched stdout lines as events and reports the exit", async (t) => {
	const { root, manager, statuses, start, events, ends } = await fixture(t);
	const monitor = await start("echo a; echo b; sleep 0.5; echo c; echo hidden >&2; sleep 0.5");
	assert.equal(monitor.id, "mon-1");
	assert.ok(monitor.pgid && monitor.pgid > 0);
	assert.equal(monitor.timeoutMs, DEFAULT_TIMEOUT_MS);
	await manager.whenDone(monitor.id);

	assert.deepEqual(
		events().map((entry) => [entry.message.details.firstLine, entry.message.details.lines, entry.options]),
		[
			[1, 2, WAKE],
			[3, 1, WAKE],
		],
	);
	assert.match(events()[0].message.content, /^Monitor mon-1 \(test watch\) event:\n```text\na\nb\n```$/);
	assert.doesNotMatch(events()[1].message.content, /hidden/);

	assert.equal(ends().length, 1);
	assert.deepEqual(ends()[0].options, WAKE);
	assert.match(ends()[0].message.content, /mon-1 \(test watch\) exited with code 0 after \d+s: 2 events, 3 lines\./);
	assert.doesNotMatch(ends()[0].message.content, /stderr/);

	const dir = join(root, "monitor");
	assert.equal(await readFile(join(dir, "mon-1.log"), "utf8"), "a\nb\nc\n");
	assert.equal(await readFile(join(dir, "mon-1.stderr.log"), "utf8"), "hidden\n");
	const meta = JSON.parse(await readFile(join(dir, "mon-1.json"), "utf8"));
	assert.equal(meta.status, "exited");
	assert.equal(meta.events, 2);
	await assert.rejects(stat(join(dir, "mon-1.pid")));
	assert.deepEqual(statuses.slice(-2), ["mon 1", undefined]);
});

test("a failing script reports unflushed lines and its stderr tail", async (t) => {
	const { manager, start, events, ends } = await fixture(t);
	const monitor = await start("echo last; echo 'boom: no such file' >&2; exit 2");
	await manager.whenDone(monitor.id);

	assert.equal(events().length, 0);
	const content = ends()[0].message.content;
	assert.deepEqual(ends()[0].options, WAKE);
	assert.match(content, /exited with code 2/);
	assert.match(content, /Final events:\n```text\nlast\n```/);
	assert.match(content, /Last stderr lines .*\n```text\nboom: no such file\n```/);
});

test("a monitor expires at its timeout and asks to be re-armed", async (t) => {
	const { manager, start, ends } = await fixture(t);
	const monitor = await start("sleep 30", 1000);
	assert.equal(monitor.timeoutMs, 1000);
	await manager.whenDone(monitor.id);

	assert.deepEqual(ends()[0].options, WAKE);
	assert.equal(ends()[0].message.details.stopReason, "timeout");
	assert.match(ends()[0].message.content, /mon-1 \(test watch\) expired after 1s: 0 events, 0 lines\./);
	assert.match(ends()[0].message.content, /Start a new monitor/);
});

test("a monitor that floods the session is stopped", async (t) => {
	const { manager, start, events, ends } = await fixture(t);
	const monitor = await start("while true; do echo spam; done");
	await manager.whenDone(monitor.id);

	assert.ok(events().length <= 1);
	assert.deepEqual(ends()[0].options, WAKE);
	assert.equal(ends()[0].message.details.stopReason, "flood");
	assert.match(ends()[0].message.content, /stopped for producing too many events/);
	assert.match(ends()[0].message.content, /more lines omitted/);
});

test("a monitor killed through its process group or by the user is reported quietly", async (t) => {
	const { manager, start, ends } = await fixture(t);
	const killed = await start("sleep 30");
	process.kill(-(killed.pgid ?? 0), "SIGTERM");
	await manager.whenDone(killed.id);
	const stopped = await start("sleep 30");
	assert.equal(manager.stop(stopped.id), true);
	assert.equal(manager.stop("mon-99"), false);
	await manager.whenDone(stopped.id);

	assert.deepEqual(ends()[0].options, QUIET);
	assert.match(ends()[0].message.content, /terminated by SIGTERM/);
	assert.doesNotMatch(ends()[0].message.content, /stderr/);
	assert.deepEqual(ends()[1].options, QUIET);
	assert.match(ends()[1].message.content, /stopped by the user/);
});

test("shutdown kills monitors without notifying the model", async (t) => {
	const { root, manager, sent, start } = await fixture(t);
	const monitor = await start("echo early; sleep 30");
	await manager.shutdown();

	assert.equal(sent.length, 0);
	const meta = JSON.parse(await readFile(join(root, "monitor", `${monitor.id}.json`), "utf8"));
	assert.equal(meta.stopReason, "shutdown");
	await assert.rejects(start("true"), /No active Pi session/);
});

test("rejects empty commands and descriptions", async (t) => {
	const { root, manager } = await fixture(t);
	await assert.rejects(manager.start({ command: " ", description: "x", cwd: root }), /command must not be empty/);
	await assert.rejects(manager.start({ command: "true", description: " ", cwd: root }), /description must not be empty/);
});

test("timeouts are clamped and long events are bounded", () => {
	assert.equal(clampTimeout(undefined), DEFAULT_TIMEOUT_MS);
	assert.equal(clampTimeout(10), 1000);
	assert.equal(clampTimeout(3_600_000), MAX_TIMEOUT_MS);

	const record = { id: "mon-1", description: "d", logPath: "/x/mon-1.log" } as MonitorRecord;
	const lines = Array.from({ length: 100 }, (_, index) => `line ${index}`);
	const content = eventMessage(record, { firstLine: 11, lines });
	assert.match(content, /line 39\n```/);
	assert.match(content, /60 more lines omitted; see \/x\/mon-1\.log lines 11–110\./);
});
