import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type Language, type RunOptions, runProgram } from "./runtime.ts";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "code-mode-runtime-")));
test.after(() => rmSync(cwd, { recursive: true, force: true }));

interface Call {
	tool: string;
	args: unknown;
}

function run(language: Language, code: string, extra: Partial<RunOptions> = {}) {
	const calls: Call[] = [];
	const result = runProgram({
		language,
		code,
		cwd,
		toolNames: ["echo", "fail", "slow"],
		async call(tool, args, signal) {
			calls.push({ tool, args });
			if (tool === "fail") throw new Error("boom from tool");
			if (tool === "slow") {
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, 10_000);
					signal.addEventListener("abort", () => {
						clearTimeout(timer);
						reject(new Error("aborted"));
					});
				});
			}
			return `echo:${JSON.stringify(args)}`;
		},
		...extra,
	});
	return { result, calls };
}

test("javascript: prints, awaits tools, and runs calls concurrently", async () => {
	const { result, calls } = run(
		"javascript",
		`const [a, b] = await Promise.all([tools.echo({ n: 1 }), tools.echo({ n: 2 })]);
console.log(a, b);
console.error("to stderr");
console.log(typeof require, process.cwd() === ${JSON.stringify(cwd)});`,
	);
	const { output, exitCode } = await result;
	assert.equal(exitCode, 0);
	assert.match(output, /echo:\{"n":1\} echo:\{"n":2\}/);
	assert.match(output, /to stderr/);
	assert.match(output, /undefined true/);
	assert.deepEqual(
		calls.map((call) => call.args),
		[{ n: 1 }, { n: 2 }],
	);
});

test("javascript: tool errors are catchable ToolErrors; uncaught errors exit 1", async () => {
	const caught = await run(
		"javascript",
		`try { await tools.fail({}); } catch (e) { console.log(e.name, e.tool, e.message, e instanceof ToolError); }
console.log(await tools.echo());`,
	).result;
	assert.equal(caught.exitCode, 0);
	assert.match(caught.output, /ToolError fail boom from tool true/);
	assert.match(caught.output, /echo:\{\}/);

	const uncaught = await run("javascript", `await tools.fail({ x: 1 });`).result;
	assert.equal(uncaught.exitCode, 1);
	assert.match(uncaught.output, /ToolError: boom from tool/);

	const badArgs = await run("javascript", `await tools.echo("nope");`).result;
	assert.equal(badArgs.exitCode, 1);
	assert.match(badArgs.output, /takes one object argument/);
});

test("javascript: supports static imports and exits once the program is done", async () => {
	const { output, exitCode } = await run(
		"javascript",
		`import { basename } from "node:path";
console.log(basename("/a/b.txt"));`,
	).result;
	assert.equal(exitCode, 0);
	assert.equal(output.trim(), "b.txt");
});

test("python: keyword and dict arguments, ToolError, and a traceback that starts at the program", async () => {
	const { result, calls } = run(
		"python",
		`print(tools.echo(path="a.txt", limit=2))
print(tools.echo({"n": 1}, extra=True))
try:
    tools.fail()
except ToolError as e:
    print("caught", e.tool, e)
import os
print(os.getcwd() == ${JSON.stringify(cwd)})
raise ValueError("bad value")`,
	);
	const { output, exitCode } = await result;
	assert.equal(exitCode, 1);
	assert.match(output, /echo:\{"path":"a.txt","limit":2\}/);
	assert.match(output, /echo:\{"n":1,"extra":true\}/);
	assert.match(output, /caught fail boom from tool/);
	assert.match(output, /True/);
	assert.match(output, /main\.py", line 9/);
	assert.match(output, /ValueError: bad value/);
	assert.doesNotMatch(output, /runpy|prelude\.py/);
	assert.equal(calls.length, 3);
});

test("timeout kills the program and aborts pending tool calls", async () => {
	let aborted = false;
	const started = Date.now();
	const result = await runProgram({
		language: "javascript",
		code: `console.log("started"); await tools.slow({});`,
		cwd,
		toolNames: ["slow"],
		timeoutSeconds: 0.5,
		call: (_tool, _args, signal) =>
			new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => {
					aborted = true;
					reject(new Error("aborted"));
				});
			}),
	});
	assert.equal(result.timedOut, true);
	assert.equal(aborted, true);
	assert.match(result.output, /started/);
	assert.ok(Date.now() - started < 5000);
});

test("abort signal stops a busy python program", async () => {
	const controller = new AbortController();
	const pending = run("python", `import time\nprint("tick", flush=True)\ntime.sleep(30)`, {
		signal: controller.signal,
		onOutput: () => controller.abort(),
	}).result;
	const result = await pending;
	assert.equal(result.aborted, true);
	assert.notEqual(result.exitCode, 0);
});

test("large output is truncated to the tail and saved in full", async () => {
	const { output, fullOutputPath, truncationNote, exitCode } = await run(
		"javascript",
		`for (let i = 0; i < 30000; i++) console.log("line " + i);`,
	).result;
	assert.equal(exitCode, 0);
	assert.ok(fullOutputPath && existsSync(fullOutputPath));
	assert.match(truncationNote ?? "", /Output truncated/);
	assert.match(output, /line 29999\s*$/);
	assert.doesNotMatch(output, /^line 0$/m);
	const full = readFileSync(fullOutputPath!, "utf8");
	assert.match(full, /^line 0$/m);
	assert.match(full, /line 29999/);
	rmSync(fullOutputPath!, { force: true });
});

test("a missing interpreter is reported clearly", async () => {
	await assert.rejects(
		run("python", "print(1)", { commands: { python: "definitely-not-python-xyz" } }).result,
		/python3` was not found on PATH/,
	);
});
