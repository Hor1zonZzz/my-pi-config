import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCalls } from "./call-log.ts";
import { type AgentRun, type AgentTask, type DreamAgents, dream, WORK_DIR } from "./dream.ts";
import { listNotes, writeNote } from "./store.ts";
import { executeMemoryCommand, insideRoots, realPath } from "./tool.ts";

const usage = { input: 1000, output: 100, cacheRead: 0, cost: 0.01 };

type Script = (task: AgentTask, transcript: string, notes: string) => Promise<Partial<AgentRun> | void>;

/** A fake agent runner that edits notes through the memory tool, as the real agents must. */
function agents(notes: string, analyze: Script, organize: Script = async () => {}, seen: AgentTask[] = []): DreamAgents {
	return {
		model: { provider: "deepseek", model: "deepseek-flash" },
		async run(task) {
			seen.push(task);
			const transcript = task.transcript ? await readFile(join(task.workDir, task.transcript), "utf8") : "";
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
	const addSession = async (id: string, seconds: number, text: string) => {
		const path = join(sessionDir, `2026-11-10T00-00-00-000Z_${id}.jsonl`);
		await writeFile(
			path,
			[{ type: "session", timestamp: "2026-11-10T00:00:00Z" }, { type: "message", message: { role: "user", content: text } }].map((e) => JSON.stringify(e)).join("\n"),
		);
		await utimes(path, seconds, seconds);
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
	now: new Date("2026-11-10T09:00:00Z"),
});

test("no new sessions means nothing to do; no model means unavailable", async (t) => {
	const s = await setup(t);
	assert.equal((await dream(input(s, agents(s.notes, async () => {})))).status, "nothing");
	await s.addSession("a", 100, "x");
	const none: DreamAgents = { model: { unavailable: "DeepSeek is not logged in" }, run: async () => assert.fail("not called") };
	assert.deepEqual((await dream(input(s, none))).reason, "DeepSeek is not logged in");
});

test("one analyzer per transcript, then one organizer; changes are measured on disk", async (t) => {
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
					if (transcript.includes("pnpm test")) {
						await executeMemoryCommand(notes, { command: "create", path: "/memories/test-cmd.md", file_text: "---\nname: test-cmd\ndescription: 测试命令\ntype: project\n---\n\npnpm test" }, { overwrite: false });
						return {};
					}
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
		seen.map((task) => [task.role, task.transcript]),
		[
			["analyze", "transcripts/01-a.txt"],
			["analyze", "transcripts/02-b.txt"],
			["organize", undefined],
		],
	);
	assert.deepEqual([result.sessions, result.created, result.updated, result.deleted, result.confirmed], [2, 1, 1, 1, 1]);
	assert.equal(result.readUntil, 150_000);
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
			["deepseek-analyze", "applied", "/dreams/x.jsonl"],
			["deepseek-organize", "applied", "/dreams/x.jsonl"],
		],
	);
	await assert.rejects(readdir(join(s.dir, WORK_DIR)), "the work directory is removed");
});

test("analyzers in a group run in parallel; groups run one after another", async (t) => {
	const s = await setup(t);
	for (let i = 0; i < 5; i++) await s.addSession(`s${i}`, 100 + i, "hi");
	let running = 0;
	let peak = 0;
	await dream({
		...input(
			s,
			agents(s.notes, async () => {
				running += 1;
				peak = Math.max(peak, running);
				await new Promise((resolve) => setTimeout(resolve, 10));
				running -= 1;
			}),
		),
		groupSize: 2,
	});
	assert.equal(peak, 2);
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

test("a failed transcript is read again next time; all failing is an error", async (t) => {
	const s = await setup(t);
	await s.addSession("a", 100, "first");
	await s.addSession("b", 200, "second");
	const failOnSecond = agents(s.notes, async (_task, transcript) => (transcript.includes("second") ? { ok: false, error: "timeout" } : {}));
	const result = await dream(input(s, failOnSecond));
	assert.equal(result.failedSessions, 1);
	assert.equal(result.readUntil, 200_000 - 1);
	const crash: DreamAgents = { model: { provider: "deepseek", model: "deepseek-flash" }, run: async () => Promise.reject(new Error("down")) };
	const all = await dream(input(s, crash));
	assert.equal(all.status, "error");
	assert.equal((await readCalls(s.dir)).at(-1)?.error, "down");
});

test("the read guard allows only the work and notes directories", async (t) => {
	const s = await setup(t);
	const work = join(s.root, "work");
	await mkdir(join(work, "transcripts"), { recursive: true });
	await mkdir(s.notes, { recursive: true });
	await symlink("/etc", join(work, "escape"));
	const allowed = [realPath(work), realPath(s.notes)];
	assert.equal(insideRoots(undefined, work, allowed), true);
	assert.equal(insideRoots("transcripts/01-a.txt", work, allowed), true);
	assert.equal(insideRoots(join(s.notes, "a.md"), work, allowed), true);
	assert.equal(insideRoots("../sessions", work, allowed), false);
	assert.equal(insideRoots("/etc/passwd", work, allowed), false);
	assert.equal(insideRoots("escape/passwd", work, allowed), false);
});
