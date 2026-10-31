import assert from "node:assert/strict";
import test from "node:test";
import {
	boundedTail,
	completionMessage,
	firstLine,
	formatDuration,
	signalFromExitCode,
	type TaskRecord,
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
