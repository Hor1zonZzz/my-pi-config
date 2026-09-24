import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runProgram } from "./runtime.ts";
import { BUILTIN_TOOLS, callLabel, createBuiltinTools, describeApi, describeTool, ToolBridge } from "./tools.ts";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "code-mode-tools-")));
test.after(() => rmSync(cwd, { recursive: true, force: true }));

// A 1×1 transparent PNG.
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

function context(): ExtensionContext {
	const sessionManager = { getSessionId: () => "test-session", getSessionFile: () => undefined };
	return { cwd, isProjectTrusted: () => false, sessionManager } as unknown as ExtensionContext;
}

test("the built-in set matches Pi's own tool definitions", () => {
	const tools = createBuiltinTools(cwd);
	assert.deepEqual([...tools.keys()], [...BUILTIN_TOOLS]);
	const expected = {
		read: createReadToolDefinition(cwd),
		bash: createBashToolDefinition(cwd),
		edit: createEditToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
	};
	for (const [name, tool] of tools) {
		const pi = expected[name];
		assert.equal(tool.name, pi.name);
		assert.equal(tool.description, pi.description);
		assert.deepEqual(tool.parameters, pi.parameters);
	}
});

test("the API reference documents every tool from its schema", () => {
	const description = describeApi(createBuiltinTools(cwd));
	assert.match(description, /^tools\.read\(\{ path, offset\?, limit\? \}\) → string$/m);
	assert.match(description, /^tools\.bash\(\{ command, timeout\? \}\) → string$/m);
	assert.match(description, /^tools\.ls\(\{ path\?, limit\? \}\) → string$/m);
	assert.match(description, /^ {2}- edits: \{ oldText: string; newText: string \}\[\] — /m);
	assert.match(description, /^ {4}- oldText: string — Exact text/m);
	for (const name of BUILTIN_TOOLS) assert.match(description, new RegExp(`^tools\\.${name}\\(`, "m"));

	const noArgs = describeTool("ping", { description: "Ping.", parameters: { type: "object" } as any });
	assert.equal(noArgs, "tools.ping() → string\n  Ping.");
});

test("call labels summarize arguments", () => {
	assert.equal(callLabel("bash", { command: "npm test\nnpm run lint" }, cwd), "npm test");
	assert.equal(callLabel("read", { path: join(cwd, "src/a.ts") }, cwd), "src/a.ts");
	assert.equal(callLabel("grep", { pattern: "TODO", path: "src" }, cwd), "TODO in src");
	assert.equal(callLabel("ls", {}, cwd), ".");
	assert.equal(callLabel("write", "not an object", cwd), "");
});

test("the bridge runs real built-in tools, validates arguments, and records calls", async () => {
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src", "a.txt"), "alpha\nbeta\n");
	let changes = 0;
	const bridge = new ToolBridge(createBuiltinTools(cwd), context(), "call-1", () => changes++);
	const signal = new AbortController().signal;

	assert.match(await bridge.call("read", { path: "src/a.txt" }, signal), /alpha\nbeta/);
	await bridge.call("write", { path: "src/b.txt", content: "one\ntwo\n" }, signal);
	await bridge.call("edit", { path: "src/b.txt", edits: [{ oldText: "two", newText: "three" }] }, signal);
	assert.equal(readFileSync(join(cwd, "src", "b.txt"), "utf8"), "one\nthree\n");
	assert.match(await bridge.call("ls", { path: "src" }, signal), /a\.txt[\s\S]*b\.txt/);
	assert.match(await bridge.call("bash", { command: "echo hi" }, signal), /hi/);

	await assert.rejects(bridge.call("read", {}, signal), /path/);
	await assert.rejects(bridge.call("bash", { command: "exit 3" }, signal), /code 3/);
	await assert.rejects(bridge.call("nope", {}, signal), /Unknown tool "nope"/);

	assert.equal(bridge.callCount, 7);
	assert.deepEqual(
		bridge.calls.map((call) => [call.tool, call.status]),
		[
			["read", "ok"],
			["write", "ok"],
			["edit", "ok"],
			["ls", "ok"],
			["bash", "ok"],
			["read", "error"],
			["bash", "error"],
		],
	);
	assert.ok(bridge.calls.every((call) => typeof call.durationMs === "number"));
	assert.equal(changes, 14);
});

test("images read through the bridge are collected for the execute_code result", async () => {
	writeFileSync(join(cwd, "dot.png"), PNG);
	const bridge = new ToolBridge(createBuiltinTools(cwd), context(), "call-2");
	const text = await bridge.call("read", { path: "dot.png" }, new AbortController().signal);
	assert.match(text, /image\/png image attached/);
	assert.equal(bridge.images.length, 1);
	assert.equal(bridge.images[0]!.mimeType, "image/png");
});

test("a program drives the real tools end to end", async () => {
	writeFileSync(join(cwd, "notes.md"), "# Notes\nTODO one\nTODO two\n");
	const tools = createBuiltinTools(cwd);
	const bridge = new ToolBridge(tools, context(), "call-3");
	for (const language of ["javascript", "python"] as const) {
		const code =
			language === "javascript"
				? `const text = await tools.read({ path: "notes.md" });
console.log(text.split("\\n").filter((l) => l.includes("TODO")).length);`
				: `text = tools.read(path="notes.md")
print(len([l for l in text.splitlines() if "TODO" in l]))`;
		const result = await runProgram({
			language,
			code,
			cwd,
			toolNames: [...tools.keys()],
			call: (tool, args, signal) => bridge.call(tool, args, signal),
		});
		assert.equal(result.exitCode, 0, result.output);
		assert.equal(result.output.trim(), "2");
	}
});
