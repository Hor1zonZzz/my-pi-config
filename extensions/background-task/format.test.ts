import assert from "node:assert/strict";
import test from "node:test";
import {
	boundedTail,
	completionMessage,
	firstLine,
	formatDuration,
	promotedMessage,
	signalFromExitCode,
	type TaskRecord,
	waitIdleMessage,
	waitInterruptedMessage,
	waitTimeoutMessage,
} from "./format.ts";

const base: TaskRecord = {
	id: "bg-1",
	command: "pnpm test",
	cwd: "/repo",
	sessionId: "s",
	logPath: "/scratch/background/bg-1.log",
	startedAt: 0,
	endedAt: 134_000,
	status: "exited",
	exitCode: 1,
	lines: 40,
};

test("formats durations", () => {
	assert.equal(formatDuration(4_400), "4s");
	assert.equal(formatDuration(134_000), "2m14s");
	assert.equal(formatDuration(3_720_000), "1h02m");
});

test("maps shell signal exit codes", () => {
	assert.equal(signalFromExitCode(143), "SIGTERM");
	assert.equal(signalFromExitCode(1), undefined);
});

test("shortens commands for listings", () => {
	assert.equal(firstLine("make\nmake test"), "make …");
	assert.equal(firstLine("x".repeat(10), 5), "xxxx…");
});

test("completion message reports the outcome, log size, and a safely fenced tail", () => {
	const message = completionMessage(base, ["ok", "```", "FAIL"]);
	assert.match(message, /^Background task bg-1 exited with code 1 after 2m14s\./);
	assert.match(message, /Log: \/scratch\/background\/bg-1\.log \(40 lines\)/);
	assert.match(message, /Last 3 lines \(from line 38\):\n````text\nok\n```\nFAIL\n````/);
	assert.match(completionMessage({ ...base, exitCode: 143, signal: "SIGTERM", lines: 0 }, []), /terminated by SIGTERM \(exit 143\)[\s\S]*produced no output/);
});

test("the tail is bounded in lines and bytes", () => {
	const lines = Array.from({ length: 100 }, (_, index) => `${index} ${"x".repeat(500)}`);
	const tail = boundedTail(lines);
	assert.ok(tail.length <= 30);
	assert.ok(Buffer.byteLength(tail.join("\n")) <= 4096);
	assert.match(tail.at(-1) ?? "", /^99 /);
});

test("promoted message distinguishes user interruption from timeout promotion", () => {
	const running: TaskRecord = {
		...base,
		status: "running",
		pgid: 4242,
		lines: 2,
		promotedAfterMs: 3_000,
	};
	const byUser = promotedMessage({ ...running, promotedBy: "user" }, ["building"]);
	assert.match(byUser, /moved to the background after 3s because a new user message arrived/);
	assert.match(byUser, /Read and address the new user message first\./);
	assert.match(byUser, /wait_background\(\{ id: "bg-1" \}\)/);
	assert.match(byUser, /kill -- -4242/);

	const byTimeout = promotedMessage({ ...running, promotedBy: "timeout", promotedAfterMs: 30_000 }, ["building"]);
	assert.match(byTimeout, /was still running after 30s, so it continues as background task bg-1/);
	assert.doesNotMatch(byTimeout, /new user message/);
});

test("wait messages format interrupted, timed-out, and idle states", () => {
	const running = [
		{
			id: "bg-1",
			command: "pnpm test",
			pgid: 1234,
			logPath: "/scratch/background/bg-1.log",
			elapsedMs: 65_000,
			lines: 12,
			newLines: 4,
			tail: ["PASS a.test.ts", "running b.test.ts"],
		},
	];
	const interrupted = waitInterruptedMessage(running, "user");
	assert.match(interrupted, /Stopped waiting because a new user message arrived/);
	assert.match(interrupted, /bg-1 \(running 1m05s, 12 lines, \+4 new lines, pgid 1234\)/);
	assert.match(interrupted, /wait_background/);

	const timedOut = waitTimeoutMessage(270_000, running);
	assert.match(timedOut, /Wait window elapsed after 4m30s; 1 background task is still running/);
	assert.match(timedOut, /PASS a\.test\.ts\nrunning b\.test\.ts/);

	assert.match(waitIdleMessage(), /No background tasks are currently running\./);
	assert.match(waitIdleMessage(base), /Most recent task: bg-1 exited with code 1/);
});
