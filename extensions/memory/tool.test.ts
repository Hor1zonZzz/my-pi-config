import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeMemoryCommand, resolveMemoryPath } from "./tool.ts";

async function root(t: test.TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "memory-tool-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return join(dir, "notes");
}

test("paths must stay inside /memories", () => {
	assert.equal(resolveMemoryPath("/r", "/memories/a.md"), "/r/a.md");
	assert.equal(resolveMemoryPath("/r", "/memories"), "/r");
	for (const bad of ["/etc/passwd", "/memories/../x", "/memories/%2e%2e/x", "/memoriesx/a", "/memories/a\\..\\b"]) {
		assert.throws(() => resolveMemoryPath("/r", bad), bad);
	}
});

test("create, view, str_replace, insert, rename, delete", async (t) => {
	const notes = await root(t);
	const created = await executeMemoryCommand(notes, { command: "create", path: "/memories/a.md", file_text: "---\nname: a\ndescription: first\n---\n\nhello\nworld\n" });
	assert.deepEqual([created.isError, created.wrote], [false, true]);
	assert.equal(await readFile(join(notes, "MEMORY.md"), "utf8"), "- [a](a.md) — first\n");

	const dirView = await executeMemoryCommand(notes, { command: "view", path: "/memories" });
	assert.match(dirView.text, /^Here're the files and directories up to 2 levels deep in \/memories/);
	assert.match(dirView.text, /\t\/memories\/a\.md/);

	const fileView = await executeMemoryCommand(notes, { command: "view", path: "/memories/a.md", view_range: [6, -1] });
	assert.equal(fileView.text, "Here's the content of /memories/a.md with line numbers:\n     6\thello\n     7\tworld");

	const replaced = await executeMemoryCommand(notes, { command: "str_replace", path: "/memories/a.md", old_str: "world", new_str: "there" });
	assert.match(replaced.text, /^The memory file has been edited\./);
	const missing = await executeMemoryCommand(notes, { command: "str_replace", path: "/memories/a.md", old_str: "nope", new_str: "x" });
	assert.equal(missing.isError, true);

	await executeMemoryCommand(notes, { command: "insert", path: "/memories/a.md", insert_line: 0, insert_text: "top\n" });
	assert.match(await readFile(join(notes, "a.md"), "utf8"), /^top\n---/);
	const badLine = await executeMemoryCommand(notes, { command: "insert", path: "/memories/a.md", insert_line: 99, insert_text: "x" });
	assert.match(badLine.text, /Invalid `insert_line`/);

	const renamed = await executeMemoryCommand(notes, { command: "rename", old_path: "/memories/a.md", new_path: "/memories/b.md" });
	assert.equal(renamed.text, "Successfully renamed /memories/a.md to /memories/b.md");
	const deleted = await executeMemoryCommand(notes, { command: "delete", path: "/memories/b.md" });
	assert.equal(deleted.text, "Successfully deleted /memories/b.md");
	assert.equal(await readFile(join(notes, "MEMORY.md"), "utf8"), "(no notes yet)\n");
});

test("the generated index and the root are protected", async (t) => {
	const notes = await root(t);
	for (const params of [
		{ command: "create" as const, path: "/memories/MEMORY.md", file_text: "x" },
		{ command: "delete" as const, path: "/memories" },
		{ command: "rename" as const, old_path: "/memories", new_path: "/memories/x" },
		{ command: "view" as const, path: "/memories/../../etc/passwd" },
	]) {
		const result = await executeMemoryCommand(notes, params);
		assert.equal(result.isError, true, JSON.stringify(params));
		assert.equal(result.wrote, false);
	}
});
