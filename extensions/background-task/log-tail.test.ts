import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readLogTail } from "./log-tail.ts";

test("reads the last lines of a log and cleans them", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "log-tail-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "x.log");

	assert.deepEqual(readLogTail(join(dir, "missing.log")), { lines: [], truncated: false });
	await writeFile(path, "");
	assert.deepEqual(readLogTail(path), { lines: [], truncated: false });

	await writeFile(path, "one\n\x1b[31mtwo\x1b[0m\tx\r\nthree");
	assert.deepEqual(readLogTail(path), { lines: ["one", "two  x", "three"], truncated: false });

	await writeFile(path, "aaaa\nbbbb\ncccc\n");
	// Reading 7 bytes starts inside "bbbb"; that partial line is dropped.
	assert.deepEqual(readLogTail(path, 7), { lines: ["cccc"], truncated: true });
});
