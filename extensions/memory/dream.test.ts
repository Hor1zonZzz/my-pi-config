import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { readCalls } from "./call-log.ts";
import { type AgentRun, type AgentTask, DREAM_WINDOW_MS, type DreamAgents, dream, dreamSince, WORK_DIR } from "./dream.ts";
import { listNotes, writeNote } from "./store.ts";
import { executeMemoryCommand } from "./tool.ts";

const usage = { input: 1000, output: 100, cacheRead: 0, cost: 0.01 };
const NOW = new Date("2026-11-10T09:00:00Z");
/** Session mtimes in tests are seconds after this point, one day before NOW, inside the dream window. */
const BASE = NOW.getTime() / 1000 - 24 * 60 * 60;
const at = (seconds: number) => (BASE + seconds) * 1000;

type Script = (task: AgentTask, transcript: string, notes: string) => Promise<Partial<AgentRun> | void>;

/** A fake agent runner that edits notes through the memory tool, as the real agents must. */
function agents(notes: string, analyze: Script, organize: Script = async () => {}, seen: AgentTask[] = []): DreamAgents {
	return {
		model: { provider: "deepseek", model: "deepseek-flash" },
		async run(task) {
			seen.push(task);
			const transcript = (await Promise.all((task.transcripts ?? []).map((t) => readFile(t.path, "utf8")))).join("\n");
			const extra = (await (task.role === "analyze" ? analyze : organize)(task, transcript, notes)) ?? {};
			return { ok: true, stopReason: "stop", confirmed: [], usage, toolCalls: 1, finalText: "done", sessionFile: "/dreams/x.jsonl", ...extra };
		},
	};
}

async function setup(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "memory-dream-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = join(root, "memory");
	const notes = join(dir, "notes");
	const sessionDir = join(root, "sessions");
	await mkdir(sessionDir, { recursive: true });
	/** `seconds` after BASE; negative values reach back before it. */
	const addSession = async (id: string, seconds: number, text: string) => {
		const path = join(sessionDir, `2026-11-10T00-00-00-000Z_${id}.jsonl`);
		await writeFile(
			path,
			[{ type: "session", timestamp: "2026-11-10T00:00:00Z" }, { type: "message", message: { role: "user", content: text } }].map((e) => JSON.stringify(e)).join("\n"),
		);
		await utimes(path, BASE + seconds, BASE + seconds);
	};
	return { root, dir, notes, sessionDir, addSession };
}

const input = (s: Awaited<ReturnType<typeof setup>>, a: DreamAgents, since = 0) => ({
	dir: s.dir,
	notes: s.notes,
	sessionDir: s.sessionDir,
	session: "current",
	since,
	agents: a,
	signal: new AbortController().signal,
	now: NOW,
});

test("no new sessions means nothing to do; no model means unavailable", async (t) => {
	const s = await setup(t);
	assert.equal((await dream(input(s, agents(s.notes, async () => {})))).status, "nothing");
	await s.addSession("a", 100, "x");
	const none: DreamAgents = { model: { unavailable: "DeepSeek is not logged in" }, run: async () => assert.fail("not called") };
	assert.deepEqual((await dream(input(s, none))).reason, "DeepSeek is not logged in");
});

test("one analyzer over every raw session copy, then one organizer; changes are measured on disk", async (t) => {
	const s = await setup(t);
	await writeNote(s.notes, "use-pnpm.md", { name: "use-pnpm", description: "pnpm", type: "feedback", source: "passive", unverifiedDreams: 0 }, "pnpm");
	await writeNote(s.notes, "pnpm-again.md", { name: "pnpm-again", description: "pnpm dup", type: "feedback" }, "pnpm");
	await s.addSession("a", 100, "use pnpm please");
	await s.addSession("b", 150, "run pnpm test");
	await s.addSession("current", 200, "running now");
	const seen: AgentTask[] = [];
	const result = await dream(
		input(
			s,
			agents(
				s.notes,
				async (task, transcript, notes) => {
					assert.deepEqual([...task.passiveCandidates], ["use-pnpm"]);
					assert.ok(transcript.includes("use pnpm please") && transcript.includes("pnpm test"));
					await executeMemoryCommand(notes, { command: "create", path: "/memories/test-cmd.md", file_text: "---\nname: test-cmd\ndescription: 测试命令\ntype: project\n---\n\npnpm test" }, { overwrite: false });
					return { confirmed: ["use-pnpm"] };
				},
				async (_task, _transcript, notes) => {
					await executeMemoryCommand(notes, { command: "delete", path: "/memories/pnpm-again.md" });
				},
				seen,
			),
		),
	);
	assert.equal(result.status, "done");
	assert.deepEqual(
		seen.map((task) => [task.role, task.transcripts?.map((t) => [t.session, relative(task.workDir, t.path)])]),
		[
			[
				"analyze",
				[
					["a", join("sessions", "01-a.jsonl")],
					["b", join("sessions", "02-b.jsonl")],
				],
			],
			["organize", undefined],
		],
	);
	assert.deepEqual([result.sessions, result.created, result.updated, result.deleted, result.confirmed], [2, 1, 1, 1, 1]);
	assert.equal(result.readUntil, at(150));
	const notes = await listNotes(s.notes);
	assert.deepEqual(
		notes.map((note) => note.name),
		["test-cmd", "use-pnpm"],
	);
	assert.equal(notes.find((note) => note.name === "use-pnpm")?.meta.verified, "2026-11-10");
	const snapshots = await readdir(join(s.dir, ".snapshots"));
	assert.deepEqual((await readdir(join(s.dir, ".snapshots", snapshots[0]))).sort(), ["pnpm-again.md", "use-pnpm.md"]);
	assert.deepEqual(
		(await readCalls(s.dir)).map((call) => [call.role, call.outcome, (call.output as { sessionFile: string }).sessionFile]),
		[
			["deepseek-analyze", "applied", "/dreams/x.jsonl"],
			["deepseek-organize", "applied", "/dreams/x.jsonl"],
		],
	);
	await assert.rejects(readdir(join(s.dir, WORK_DIR)), "the work directory is removed");
});

test("one analyzer run reads at most maxSessions, oldest first; the rest wait for the next dream", async (t) => {
	const s = await setup(t);
	for (let i = 0; i < 5; i++) await s.addSession(`s${i}`, 100 + i, "hi");
	const seen: AgentTask[] = [];
	const result = await dream({ ...input(s, agents(s.notes, async () => {}, async () => {}, seen)), maxSessions: 3 });
	assert.deepEqual(
		seen.filter((task) => task.role === "analyze").map((task) => task.transcripts?.map((t) => t.session)),
		[["s0", "s1", "s2"]],
	);
	assert.equal(result.readUntil, at(102));
});

test("a passive note no dream confirms is removed after two dreams", async (t) => {
	const s = await setup(t);
	await writeNote(s.notes, "guess.md", { name: "guess", description: "a guess", type: "project", source: "passive", unverifiedDreams: 0 }, "maybe");
	await s.addSession("a", 100, "hello");
	const first = await dream(input(s, agents(s.notes, async () => {})));
	assert.equal(first.removedPassive, 0);
	assert.equal((await listNotes(s.notes))[0].meta.unverifiedDreams, 1);
	await s.addSession("b", 300, "hello again");
	const second = await dream(input(s, agents(s.notes, async () => {}), first.readUntil));
	assert.equal(second.removedPassive, 1);
	assert.deepEqual(await listNotes(s.notes), []);
	assert.match(await readFile(join(s.dir, "log.md"), "utf8"), /removed passive note guess/);
});

test("a failed analysis is an error that reads nothing, so every session is read again next time", async (t) => {
	const s = await setup(t);
	await s.addSession("a", 100, "first");
	await s.addSession("b", 200, "second");
	const seen: AgentTask[] = [];
	const result = await dream(input(s, agents(s.notes, async () => ({ ok: false, error: "timeout" }), async () => {}, seen)));
	assert.deepEqual([result.status, result.reason, result.failedSessions, result.readUntil], ["error", "timeout", 2, undefined]);
	assert.deepEqual(
		seen.map((task) => task.role),
		["analyze"],
	);
	const crash: DreamAgents = { model: { provider: "deepseek", model: "deepseek-flash" }, run: async () => Promise.reject(new Error("down")) };
	const all = await dream(input(s, crash));
	assert.equal(all.status, "error");
	assert.equal((await readCalls(s.dir)).at(-1)?.error, "down");
});

test("a passive note keeps its count when a dream did not read its source session", async (t) => {
	const s = await setup(t);
	const meta = { name: "guess", description: "a guess", type: "project", source: "passive", sessions: ["later"], unverifiedDreams: 0 };
	await writeNote(s.notes, "guess.md", meta, "maybe");
	await s.addSession("a", 100, "older work");
	const first = await dream(input(s, agents(s.notes, async () => {})));
	assert.equal((await listNotes(s.notes))[0].meta.unverifiedDreams, 0);
	await s.addSession("later", 300, "where the guess came from");
	await dream(input(s, agents(s.notes, async () => {}), first.readUntil));
	assert.equal((await listNotes(s.notes))[0].meta.unverifiedDreams, 1);
});

test("the analyzer gets a byte-identical copy of the raw session file", async (t) => {
	const s = await setup(t);
	await s.addSession("a", 100, "raw please");
	const original = await readFile(join(s.sessionDir, "2026-11-10T00-00-00-000Z_a.jsonl"), "utf8");
	let copy = "";
	await dream(input(s, agents(s.notes, async (_task, transcript) => void (copy = transcript))));
	assert.equal(copy, original);
});

test("only sessions from the last three days are read, even after a long gap", async (t) => {
	const s = await setup(t);
	const day = 24 * 60 * 60;
	await s.addSession("old", -5 * day, "a week-old session");
	await s.addSession("recent", 100, "yesterday's session");
	const seen: AgentTask[] = [];
	const result = await dream(input(s, agents(s.notes, async () => {}, async () => {}, seen), 0));
	assert.deepEqual(
		seen.filter((task) => task.role === "analyze").map((task) => task.transcripts?.map((t) => t.session)),
		[["recent"]],
	);
	assert.equal(result.readUntil, at(100));
	assert.equal(dreamSince(undefined, NOW.getTime()), NOW.getTime() - DREAM_WINDOW_MS);
	assert.equal(dreamSince(at(100), NOW.getTime()), at(100));
});
