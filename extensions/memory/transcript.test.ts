import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sessionsSince } from "./transcript.ts";

test("sessions since a time, oldest first, without the running session", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "memory-sessions-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const files = [
		["2026-11-01T00-00-00-000Z_old.jsonl", 1000],
		["2026-11-02T00-00-00-000Z_b.jsonl", 3000],
		["2026-11-03T00-00-00-000Z_a.jsonl", 2000],
		["2026-11-04T00-00-00-000Z_current.jsonl", 4000],
	] as const;
	for (const [name, seconds] of files) {
		await writeFile(join(dir, name), "");
		await utimes(join(dir, name), seconds, seconds);
	}
	const found = await sessionsSince(dir, 1_500_000, "current");
	assert.deepEqual(
		found.map((session) => session.id),
		["a", "b"],
	);
	assert.deepEqual(await sessionsSince(join(dir, "missing"), 0), []);
});
