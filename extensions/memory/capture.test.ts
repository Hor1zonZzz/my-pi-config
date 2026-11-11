import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCalls, summarizeCalls } from "./call-log.ts";
import { capture, pickRelated } from "./capture.ts";
import type { ModelPort } from "./port.ts";
import { listNotes, parseNote, writeNote } from "./store.ts";

const window = { earlier: ["USER: use npm\nAGENT: ok"], focus: "USER: no, this project uses pnpm\nAGENT: Switched to pnpm." };
const usage = { input: 100, output: 10, cacheRead: 0, cost: 0.001 };

/** The writer's save_memory arguments, plain text (no tool call), or a thrown error. */
type WriterReply = Record<string, unknown> | string | Error;

function port(durable: number, reply: WriterReply, writes: string[] = []): ModelPort {
	return {
		judge: { provider: "openrouter", model: "~typesafe/jev-latest" },
		writer: { provider: "deepseek", model: "deepseek-flash" },
		classify: async () => ({ answers: { durable: { type: "bool", probability: durable }, kind: { type: "choice", choice: "feedback" } }, usage, stopReason: "stop" }),
		write: async (_system, user) => {
			writes.push(user);
			if (reply instanceof Error) throw reply;
			if (typeof reply === "string") return { text: reply, usage, stopReason: "stop" };
			return { text: "", toolArgs: reply, usage, stopReason: "toolUse" };
		},
	};
}

async function setup(t: test.TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "memory-capture-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return { dir, notes: join(dir, "notes") };
}

const base = (dir: string, notes: string, p: ModelPort) => ({
	dir,
	notes,
	session: "s1",
	judgeWindow: window,
	writerWindow: window,
	port: p,
	signal: new AbortController().signal,
	now: new Date("2026-11-10T08:00:00Z"),
});

test("below the threshold, DeepSeek is not called", async (t) => {
	const { dir, notes } = await setup(t);
	const writes: string[] = [];
	const outcome = await capture(base(dir, notes, port(0.5, { action: "skip" }, writes)));
	assert.deepEqual(outcome, { status: "below-threshold", durable: 0.5 });
	assert.equal(writes.length, 0);
	const calls = await readCalls(dir);
	assert.deepEqual(
		calls.map((call) => [call.role, call.outcome]),
		[["jev-judge", "below-threshold"]],
	);
	assert.deepEqual(calls[0].usage, usage);
});

test("a passing turn becomes a passive note with its session", async (t) => {
	const { dir, notes } = await setup(t);
	const reply = { action: "create", name: "use-pnpm", description: "本项目用 pnpm", type: "feedback", body: "用 pnpm。\nWhy: 用户纠正。", reason: "correction" };
	const outcome = await capture(base(dir, notes, port(0.9, reply)));
	assert.deepEqual(outcome, { status: "written", action: "create", name: "use-pnpm", durable: 0.9 });
	const { meta, body } = parseNote(await readFile(join(notes, "use-pnpm.md"), "utf8"));
	assert.equal(meta.source, "passive");
	assert.deepEqual(meta.sessions, ["s1"]);
	assert.equal(meta.unverifiedDreams, 0);
	assert.equal(meta.updated, "2026-11-10");
	assert.match(body, /^用 pnpm。/);
	assert.equal(await readFile(join(notes, "MEMORY.md"), "utf8"), "- [use-pnpm](use-pnpm.md) — 本项目用 pnpm\n");
	assert.match(await readFile(join(dir, "log.md"), "utf8"), /passive create use-pnpm \(durable 0\.90, session s1\)/);
	const summary = summarizeCalls(await readCalls(dir));
	assert.deepEqual(
		summary.roles.map((role) => [role.role, role.outcomes]),
		[
			["jev-judge", { passed: 1 }],
			["deepseek-capture", { create: 1 }],
		],
	);
});

test("an update keeps the note's source and adds the session", async (t) => {
	const { dir, notes } = await setup(t);
	await writeNote(notes, "use-pnpm.md", { name: "use-pnpm", description: "pnpm", type: "feedback", source: "active", sessions: ["s0"] }, "old");
	const writes: string[] = [];
	const reply = { action: "update", name: "use-pnpm", description: "pnpm only", type: "feedback", body: "new", reason: "r" };
	await capture(base(dir, notes, port(0.8, reply, writes)));
	assert.match(writes[0], /"related_notes"/);
	assert.match(writes[0], /"use-pnpm"/);
	const [note] = await listNotes(notes);
	assert.equal(note.meta.source, "active");
	assert.deepEqual(note.meta.sessions, ["s0", "s1"]);
	assert.equal(note.body.trim(), "new");
});

test("skip, no tool call, an invalid call, and errors write nothing but are logged", async (t) => {
	const { dir, notes } = await setup(t);
	assert.equal((await capture(base(dir, notes, port(0.9, { action: "skip", reason: "known" })))).status, "skip");
	// A JSON note written as text, as DeepSeek did before the tool, is not accepted.
	assert.deepEqual(await capture(base(dir, notes, port(0.9, '{"action":"create","name":"x","body":"y"}'))), {
		status: "writer-error",
		error: "no save_memory call",
	});
	assert.deepEqual(await capture(base(dir, notes, port(0.9, { action: "delete", name: "use-pnpm" }))), {
		status: "writer-error",
		error: "invalid note operation",
	});
	assert.deepEqual(await capture(base(dir, notes, port(0.9, { action: "create", name: "Bad Name", body: "x" }))), {
		status: "writer-error",
		error: "invalid note operation",
	});
	assert.equal((await capture(base(dir, notes, port(0.9, new Error("boom"))))).status, "writer-error");
	assert.equal((await listNotes(notes)).length, 0);
	const outcomes = (await readCalls(dir)).filter((call) => call.role === "deepseek-capture").map((call) => [call.outcome, call.error]);
	assert.deepEqual(outcomes, [
		["skip", null],
		["no-call", null],
		["invalid-call", null],
		["invalid-call", null],
		["error", "boom"],
	]);
});

test("unavailable models stop before any call", async (t) => {
	const { dir, notes } = await setup(t);
	const p = { ...port(0.9, { action: "skip" }), judge: { unavailable: "OpenRouter is not logged in" } };
	assert.deepEqual(await capture(base(dir, notes, p)), { status: "unavailable", reason: "OpenRouter is not logged in" });
	assert.deepEqual(await readCalls(dir), []);
});

test("related notes are chosen by shared terms, including Chinese", () => {
	const note = (name: string, description: string) => ({ path: `${name}.md`, name, description, meta: {}, body: "", size: 0 });
	const picked = pickRelated([note("deploy-steps", "部署前先生成代码"), note("use-pnpm", "本项目用 pnpm"), note("auth", "登录模块")], "这个项目用 pnpm 安装");
	assert.deepEqual(
		picked.map((n) => n.name),
		["use-pnpm"],
	);
});
