import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildWindow, type LooseEntry, messagesFromEntries, renderTurn, sessionsSince, splitTurns } from "./transcript.ts";

const entry = (message: Record<string, unknown>): LooseEntry => ({ type: "message", message: message as LooseEntry["message"] });

const entries: LooseEntry[] = [
	{ type: "session", timestamp: "2026-11-10T00:00:00Z" },
	entry({ role: "system", content: "" }),
	entry({ role: "user", content: "install deps" }),
	entry({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "secret plan" },
			{ type: "text", text: "Running npm." },
			{ type: "toolCall", name: "bash", arguments: { command: "npm install" } },
		],
	}),
	entry({ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "npm ERR! use pnpm" }] }),
	entry({ role: "user", content: [{ type: "text", text: "this project uses pnpm" }] }),
	entry({ role: "assistant", content: [{ type: "text", text: "Got it." }] }),
	{ type: "custom", id: "x" },
];

test("turns start at user messages and drop thinking", () => {
	const turns = splitTurns(messagesFromEntries(entries));
	assert.equal(turns.length, 2);
	assert.equal(
		renderTurn(turns[0]),
		'USER: install deps\nAGENT: Running npm.\nTOOL CALL bash: {"command":"npm install"}\nTOOL RESULT (bash) ERROR: npm ERR! use pnpm',
	);
	assert.doesNotMatch(renderTurn(turns[0]), /secret plan/);
});

test("tool results are clipped, errors less", () => {
	const long = "x".repeat(1000);
	const ok = renderTurn([{ role: "user", content: "q" }, { role: "toolResult", toolName: "read", content: long }]);
	const err = renderTurn([{ role: "user", content: "q" }, { role: "toolResult", toolName: "read", isError: true, content: long }]);
	assert.match(ok, /x{300}… \[700 more chars\]/);
	assert.match(err, /x{800}… \[200 more chars\]/);
});

test("the window keeps the focus turn and drops the oldest turns first", () => {
	const turns = Array.from({ length: 5 }, (_, i) => [{ role: "user", content: `turn ${i} ${"y".repeat(100)}` }]);
	const window = buildWindow(turns, 3, 10_000);
	assert.ok(window);
	assert.equal(window.earlier.length, 2);
	assert.match(window.focus, /^USER: turn 4/);
	const tight = buildWindow(turns, 3, 250);
	assert.ok(tight);
	assert.equal(tight.earlier.length, 1);
	assert.match(tight.earlier[0], /turn 3/);
	assert.equal(buildWindow([], 3, 100), undefined);
});

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
