import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DreamResult } from "./dream.ts";
import { type DreamStatus, isDreamRunning, pendingReport, readDreamStatus, STATUS_FILE, summarize, writeDreamStatus } from "./dream-status.ts";

const alive = () => true;
const dead = () => false;
const base: DreamStatus = { state: "running", pid: 4242, trigger: "auto", startedAt: 1 };

test("the status file round-trips, and a missing or broken file reads as no status", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "memory-status-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	assert.equal(await readDreamStatus(dir), undefined);
	await writeDreamStatus(dir, { ...base, state: "done", summary: "ok" });
	assert.deepEqual(await readDreamStatus(dir), { ...base, state: "done", summary: "ok" });
	await writeFile(join(dir, STATUS_FILE), "{not json");
	assert.equal(await readDreamStatus(dir), undefined);
});

test("running means the status says so and the worker process is alive", () => {
	assert.equal(isDreamRunning(base, alive), true);
	assert.equal(isDreamRunning(base, dead), false);
	assert.equal(isDreamRunning({ ...base, state: "done" }, alive), false);
	assert.equal(isDreamRunning(undefined, alive), false);
	assert.equal(isDreamRunning({ ...base, pid: process.pid }), true);
});

test("the next session reports a finished or dead dream once, but not a quiet auto dream", () => {
	assert.equal(pendingReport(base, alive), undefined, "still running: nothing to report yet");
	assert.match(pendingReport(base, dead) ?? "", /中途退出/);
	assert.equal(pendingReport({ ...base, state: "done", summary: "上次 Dream 完成" }, alive), "上次 Dream 完成");
	assert.equal(pendingReport({ ...base, state: "done", summary: "x", reported: true }, alive), undefined);
	assert.equal(pendingReport({ ...base, state: "nothing", summary: "nothing" }, alive), undefined);
	assert.equal(pendingReport({ ...base, state: "nothing", trigger: "manual", summary: "nothing" }, alive), "nothing");
});

test("summaries name the outcome", () => {
	const done: DreamResult = {
		status: "done",
		sessions: 5,
		failedSessions: 0,
		created: 5,
		updated: 1,
		deleted: 0,
		organizeFailed: false,
	};
	assert.match(summarize(done), /读取 5 个会话 · 新增 5 · 修改 1/);
	assert.match(summarize({ ...done, status: "error", reason: "timeout" }), /失败：timeout/);
	assert.match(summarize({ ...done, status: "aborted" }), /被停止/);
});
