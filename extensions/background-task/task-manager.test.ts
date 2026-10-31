import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BackgroundTaskManager, type ExecFn } from "./task-manager.ts";

// A minimal stand-in for Pi's local bash operations: a detached shell whose process
// group is killed on abort, with signal exits reported as 128 + signal number.
const exec: ExecFn = (command, cwd, { onData, signal }) =>
	new Promise((resolve, reject) => {
		const child = spawn("bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const kill = () => {
			try {
				process.kill(-(child.pid ?? 0), "SIGKILL");
			} catch {}
		};
		signal?.addEventListener("abort", kill, { once: true });
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", reject);
		child.on("close", (code, signalCode) => {
			if (signal?.aborted) return reject(new Error("aborted"));
			resolve({ exitCode: code ?? 128 + (signalCode ? constants.signals[signalCode] : 0) });
		});
	});

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
