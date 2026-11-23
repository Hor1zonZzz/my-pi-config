import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	acquireDreamLock,
	formatIndex,
	indexForPrompt,
	listNotes,
	parseNote,
	projectKey,
	readConfig,
	rebuildIndex,
	SNAPSHOTS_KEPT,
	serializeNote,
	snapshot,
	writeConfig,
	writeNote,
} from "./store.ts";

async function tempDir(t: test.TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "memory-store-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

test("project keys match Pi's session directory names", () => {
	assert.equal(projectKey("/Users/me/workspace/learn-xinfo"), "--Users-me-workspace-learn-xinfo--");
	assert.equal(projectKey("C:\\work\\app"), "--C--work-app--");
});

test("a missing config means every switch is on", async (t) => {
	const dir = await tempDir(t);
	assert.deepEqual(await readConfig(dir), { enabled: true, dreamAuto: true });
	await writeConfig(dir, { enabled: false, dreamAuto: false, lastDreamAt: 5 });
	assert.deepEqual(await readConfig(dir), { enabled: false, dreamAuto: false, lastDreamAt: 5 });
});

test("notes round-trip through frontmatter", () => {
	const text = serializeNote(
		{ name: "pnpm-only", description: "Use pnpm: never npm", type: "feedback", sessions: ["a", "b"], count: 1 },
		"Use pnpm.\nWhy: the user said so.",
	);
	const { meta, body } = parseNote(text);
	assert.equal(meta.name, "pnpm-only");
	assert.equal(meta.description, "Use pnpm: never npm");
	assert.deepEqual(meta.sessions, ["a", "b"]);
	assert.equal(meta.count, 1);
	assert.equal(body, "Use pnpm.\nWhy: the user said so.\n");
});

test("the index is sorted, byte-stable, and skips MEMORY.md and hidden files", async (t) => {
	const notes = await tempDir(t);
	await writeFile(join(notes, "b.md"), serializeNote({ name: "b", description: "second" }, "x"));
	await writeFile(join(notes, "a.md"), "# Plain note\nno frontmatter");
	await writeFile(join(notes, ".hidden.md"), "secret");
	const first = await rebuildIndex(notes);
	assert.equal(first, "- [a](a.md) — Plain note\n- [b](b.md) — second\n");
	assert.equal(await readFile(join(notes, "MEMORY.md"), "utf8"), first);
	assert.equal(await rebuildIndex(notes), first);
	assert.equal((await listNotes(notes)).length, 2);
	assert.equal(formatIndex([]), "(no notes yet)\n");
});

test("the index groups typed notes by priority (User & Feedback first) while staying byte-stable", async (t) => {
	const notes = await tempDir(t);
	await writeNote(notes, "z-ref.md", { name: "z-ref", description: "ref note", type: "reference" }, "ref");
	await writeNote(notes, "a-proj.md", { name: "a-proj", description: "proj note", type: "project" }, "proj");
	await writeNote(notes, "u-pref.md", { name: "u-pref", description: "user pref", type: "user" }, "pref");
	await writeNote(notes, "b-fb.md", { name: "b-fb", description: "feedback", type: "feedback" }, "fb");
	const index = await rebuildIndex(notes);
	assert.equal(
		index,
		[
			"## User & Feedback",
			"- [b-fb](b-fb.md) — feedback",
			"- [u-pref](u-pref.md) — user pref",
			"",
			"## Project",
			"- [a-proj](a-proj.md) — proj note",
			"",
			"## Reference",
			"- [z-ref](z-ref.md) — ref note",
			"",
		].join("\n"),
	);
	assert.equal(await rebuildIndex(notes), index);
});

test("the injected index stops at 200 lines", () => {
	const index = `${Array.from({ length: 250 }, (_, i) => `- [n${i}](n${i}.md) — d`).join("\n")}\n`;
	const out = indexForPrompt(index);
	assert.equal(out.split("\n").length, 201);
	assert.match(out, /index truncated/);
	assert.equal(indexForPrompt("- [a](a.md) — x\n"), "- [a](a.md) — x");
});

test("snapshots keep only the newest copies", async (t) => {
	const dir = await tempDir(t);
	await rebuildIndex(join(dir, "notes"));
	for (let i = 0; i < SNAPSHOTS_KEPT + 2; i++) await snapshot(dir, new Date(Date.UTC(2026, 0, 1, 0, i)));
	const kept = (await readdir(join(dir, ".snapshots"))).sort();
	assert.equal(kept.length, SNAPSHOTS_KEPT);
	assert.match(kept[0], /T00-02-00/);
});

test("the dream lock is exclusive and recovers from a dead owner", async (t) => {
	const dir = await tempDir(t);
	const release = await acquireDreamLock(dir);
	assert.ok(release);
	assert.equal(await acquireDreamLock(dir), undefined);
	await release();
	await writeFile(join(dir, ".dream.lock"), JSON.stringify({ pid: 999_999_999, at: Date.now() }));
	const again = await acquireDreamLock(dir);
	assert.ok(again);
	await again();
});
