import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BackgroundTaskManager, MAX_RUNNING_TASKS, promoteAfterMsFrom } from "./task-manager.ts";
import { exec } from "./test-exec.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "bg-task-"));
	const sent: { message: { content: string; details: Record<string, unknown> }; options: unknown }[] = [];
	const statuses: (string | undefined)[] = [];
	const manager = new BackgroundTaskManager(exec, (message, options) => sent.push({ message, options }));
	manager.startSession({ sessionId: "s1", scratchpad: root, setStatus: (text) => statuses.push(text) });
	t.after(async () => {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	});
	return { root, manager, sent, statuses };
}

test("runs a command in the background and wakes the model with its result", async (t) => {
	const { root, manager, sent, statuses } = await fixture(t);
	const task = await manager.start("printf 'one\\ntwo\\n'; echo oops >&2; exit 3", root);

	assert.equal(task.id, "bg-1");
	assert.ok(task.pgid && task.pgid > 0);
	assert.equal(task.logPath, join(root, "background", "bg-1.log"));
	await manager.whenDone(task.id);

	assert.equal(await readFile(task.logPath, "utf8"), "one\ntwo\noops\n");
	const meta = JSON.parse(await readFile(join(root, "background", "bg-1.json"), "utf8"));
	assert.equal(meta.status, "exited");
	assert.equal(meta.exitCode, 3);
	assert.equal(meta.lines, 3);
	await assert.rejects(stat(join(root, "background", "bg-1.pid")));

	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].options, { deliverAs: "steer", triggerTurn: true });
	assert.match(sent[0].message.content, /bg-1 exited with code 3/);
	assert.match(sent[0].message.content, /one\ntwo\noops/);
	assert.deepEqual(statuses.slice(-2), ["bg 1", undefined]);
});

test("a task killed through its process group is reported without a new turn", async (t) => {
	const { root, manager, sent } = await fixture(t);
	const task = await manager.start("echo ready; sleep 30", root);
	process.kill(-(task.pgid ?? 0), "SIGTERM");
	await manager.whenDone(task.id);

	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].options, { triggerTurn: false });
	assert.equal(sent[0].message.details.signal, "SIGTERM");
	assert.match(sent[0].message.content, /terminated by SIGTERM/);
});

test("a task stopped by the user is reported quietly", async (t) => {
	const { root, manager, sent } = await fixture(t);
	const task = await manager.start("sleep 30", root);
	assert.equal(manager.stop(task.id), true);
	assert.equal(manager.stop("bg-99"), false);
	await manager.whenDone(task.id);

	assert.deepEqual(sent[0].options, { triggerTurn: false });
	assert.match(sent[0].message.content, /stopped by the user/);
});

test("shutdown kills running tasks without notifying the model", async (t) => {
	const { root, manager, sent } = await fixture(t);
	const task = await manager.start("sleep 30", root);
	await manager.shutdown();

	assert.equal(sent.length, 0);
	const meta = JSON.parse(await readFile(join(root, "background", `${task.id}.json`), "utf8"));
	assert.equal(meta.status, "stopped");
	assert.equal(meta.stopReason, "shutdown");
	await assert.rejects(manager.start("true", root), /No active Pi session/);
});

test("task IDs continue after a resumed session's earlier tasks", async (t) => {
	const { root, manager } = await fixture(t);
	await manager.whenDone((await manager.start("true", root)).id);
	await manager.whenDone((await manager.start("true", root)).id);

	const resumed = new BackgroundTaskManager(exec, () => {});
	resumed.startSession({ sessionId: "s1", scratchpad: root });
	const task = await resumed.start("true", root);
	await resumed.whenDone(task.id);
	assert.equal(task.id, "bg-3");
});

test("rejects a missing working directory and an empty command", async (t) => {
	const { root, manager } = await fixture(t);
	await assert.rejects(manager.start("true", join(root, "missing")), /Working directory does not exist/);
	await assert.rejects(manager.start("  ", root), /must not be empty/);
});

async function backgroundFiles(root: string): Promise<string[]> {
	return (await readdir(join(root, "background")).catch(() => [] as string[])).sort();
}

test("a foreground command that finishes in time behaves like plain bash", async (t) => {
	const { root, manager, sent, statuses } = await fixture(t);
	const chunks: string[] = [];
	const result = await manager.runForeground('echo "hi $FOREGROUND_TEST"; exit 4', root, {
		onData: (data) => chunks.push(data.toString()),
		env: { ...process.env, FOREGROUND_TEST: "there" },
		promoteAfterMs: 5000,
	});

	assert.deepEqual(result, { promoted: false, exitCode: 4 });
	assert.equal(chunks.join(""), "hi there\n");
	assert.deepEqual(await backgroundFiles(root), []);
	assert.equal(sent.length, 0);
	assert.deepEqual(statuses, [undefined]);
});

test("a foreground command still running at the threshold becomes a background task", async (t) => {
	const { root, manager, sent, statuses } = await fixture(t);
	const chunks: string[] = [];
	const tool = new AbortController();
	const result = await manager.runForeground("echo early; sleep 0.4; echo late; exit 2", root, {
		onData: (data) => chunks.push(data.toString()),
		signal: tool.signal,
		promoteAfterMs: 150,
	});

	assert.equal(result.promoted, true);
	if (!result.promoted) return;
	assert.equal(result.task.id, "bg-1");
	assert.ok(result.task.pgid && result.task.pgid > 0);
	assert.ok((result.task.promotedAfterMs ?? 0) >= 150);
	assert.deepEqual(result.tail, ["early"]);
	assert.deepEqual(statuses.slice(-1), ["bg 1"]);
	// Esc on the finished tool call must not reach the background task.
	tool.abort();
	await manager.whenDone(result.task.id);

	assert.equal(chunks.join(""), "early\n");
	assert.equal(await readFile(result.task.logPath, "utf8"), "early\nlate\n");
	assert.deepEqual(await backgroundFiles(root), ["bg-1.json", "bg-1.log"]);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].options, { deliverAs: "steer", triggerTurn: true });
	assert.match(sent[0].message.content, /bg-1 exited with code 2/);
	assert.match(sent[0].message.content, /early\nlate/);
});

test("the tool's abort signal stops a foreground command before promotion", async (t) => {
	const { root, manager, sent } = await fixture(t);
	const tool = new AbortController();
	setTimeout(() => tool.abort(), 50);
	await assert.rejects(
		manager.runForeground("sleep 30", root, { onData: () => {}, signal: tool.signal, promoteAfterMs: 5000 }),
		/^Error: aborted$/,
	);
	assert.deepEqual(await backgroundFiles(root), []);
	assert.equal(sent.length, 0);
});

test("a foreground timeout before promotion is rethrown", async (t) => {
	const { root, manager } = await fixture(t);
	await assert.rejects(
		manager.runForeground("sleep 30", root, { onData: () => {}, timeout: 0.1, promoteAfterMs: 5000 }),
		/^Error: timeout:0.1$/,
	);
});

test("the bash timeout still applies after promotion and wakes the model", async (t) => {
	const { root, manager, sent } = await fixture(t);
	const result = await manager.runForeground("sleep 30", root, { onData: () => {}, timeout: 0.3, promoteAfterMs: 50 });
	assert.equal(result.promoted, true);
	if (!result.promoted) return;
	await manager.whenDone(result.task.id);

	assert.deepEqual(sent[0].options, { deliverAs: "steer", triggerTurn: true });
	assert.match(sent[0].message.content, /killed by its 0.3-second timeout/);
	const meta = JSON.parse(await readFile(join(root, "background", "bg-1.json"), "utf8"));
	assert.equal(meta.stopReason, "timeout");
});

test("shutdown aborts foreground commands", async (t) => {
	const { root, manager, sent } = await fixture(t);
	const running = manager.runForeground("sleep 30", root, { onData: () => {}, promoteAfterMs: 5000 });
	await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	await manager.shutdown();
	await assert.rejects(running, /aborted/);
	assert.equal(sent.length, 0);
});

test("a foreground command is not promoted while the task limit is reached", async (t) => {
	const { root, manager } = await fixture(t);
	for (let index = 0; index < MAX_RUNNING_TASKS; index++) await manager.start("sleep 30", root);
	const result = await manager.runForeground("sleep 0.3; echo done", root, { onData: () => {}, promoteAfterMs: 50 });
	assert.deepEqual(result, { promoted: false, exitCode: 0 });
});

test("the promotion threshold comes from the environment", () => {
	assert.equal(promoteAfterMsFrom(undefined), 30_000);
	assert.equal(promoteAfterMsFrom(""), 30_000);
	assert.equal(promoteAfterMsFrom("5000"), 5000);
	assert.equal(promoteAfterMsFrom("0"), 0);
	assert.equal(promoteAfterMsFrom("-1"), 30_000);
	assert.equal(promoteAfterMsFrom("soon"), 30_000);
});

test("reminds the model to check a task at every interval while it runs", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "bg-task-"));
	const sent: { message: { content: string; details: Record<string, unknown> }; options: unknown }[] = [];
	const manager = new BackgroundTaskManager(exec, (message, options) => sent.push({ message, options }), Date.now, {
		checkIntervalMs: 300,
	});
	manager.startSession({ sessionId: "s1", scratchpad: root });
	t.after(async () => {
		await manager.shutdown();
		await rm(root, { recursive: true, force: true });
	});
	// Output only at the start, then silence across several intervals.
	const task = await manager.start("echo working; sleep 1.3", root);
	await manager.whenDone(task.id);

	// Timing varies under load, so only the shape of the reminders is checked, not their count.
	const checks = sent.filter((entry) => entry.message.details.kind === "check");
	assert.ok(checks.length >= 2, `expected at least 2 checks, got ${checks.length}`);
	for (const check of checks) assert.deepEqual(check.options, { deliverAs: "steer", triggerTurn: true });
	assert.match(checks[0].message.content, /^Background task bg-1 is still running after \d+s\.\n/);
	assert.match(checks[0].message.content, /stop it with `kill -- -\d+`/);
	assert.equal(checks[0].message.details.newLines, undefined);
	assert.ok(checks.slice(1).every((check) => typeof check.message.details.newLines === "number"));
	const stalled = checks.find((check) => check.message.details.newLines === 0);
	assert.match(stalled?.message.content ?? "", /no new output since the last check/);
	assert.ok(checks.some((check) => /```text\nworking\n```/.test(check.message.content)));
	// The exit report comes last, and no check follows it.
	assert.match(sent.at(-1)?.message.content ?? "", /bg-1 exited with code 0/);
	const count = checks.length;
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.equal(sent.filter((entry) => entry.message.details.kind === "check").length, count);
});

test("a task that ends before the interval gets no check", async (t) => {
	const { root, manager, sent } = await fixture(t);
	const task = await manager.start("echo quick", root);
	await manager.whenDone(task.id);
	assert.equal(sent.filter((entry) => entry.message.details.kind === "check").length, 0);
});
