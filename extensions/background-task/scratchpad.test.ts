import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pruneScratchpads, safeSessionDirName, sessionScratchpad } from "./scratchpad.ts";

test("session IDs become safe directory names", () => {
	assert.equal(safeSessionDirName("0198-abc_DEF.1"), "0198-abc_DEF.1");
	assert.equal(safeSessionDirName("../x/y"), "s.._x_y");
	assert.equal(sessionScratchpad("/agent", "id"), join("/agent", "scratchpad", "id"));
});

test("prunes only stale scratchpads of other sessions", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "bg-scratchpad-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const now = Date.now();
	const day = 24 * 60 * 60 * 1000;
	const old = new Date(now - 30 * day);
	for (const name of ["current", "stale", "fresh"]) await mkdir(join(root, name));
	await utimes(join(root, "current"), old, old);
	await utimes(join(root, "stale"), old, old);

	const removed = await pruneScratchpads(root, join(root, "current"), now, 14 * day);

	assert.deepEqual(removed, [join(root, "stale")]);
	assert.deepEqual((await readdir(root)).sort(), ["current", "fresh"]);
	assert.deepEqual(await pruneScratchpads(join(root, "missing"), "x"), []);
});
