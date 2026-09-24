import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type Language, runProgram } from "./runtime.ts";
import { checkRoots, resolveInterpreter, sandboxCommand, sandboxEnv, sandboxUnavailable, seatbeltProfile } from "./sandbox.ts";

const unavailable = sandboxUnavailable();
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "code-mode-sandbox-")));
writeFileSync(join(cwd, "secret.txt"), "top secret\n");
test.after(() => rmSync(cwd, { recursive: true, force: true }));

test("the profile takes paths as parameters and closes the escape routes", () => {
	const profile = seatbeltProfile(2);
	for (const rule of [
		"(deny network*)",
		"(deny process-fork)",
		"(deny process-exec*)",
		"(deny signal)",
		"(allow signal (target self))",
		"(deny mach-lookup)",
		"(deny appleevent-send)",
		"(deny file-write*)",
	]) {
		assert.ok(profile.includes(rule), rule);
	}
	assert.match(profile, /\(allow process-exec \(subpath \(param "ROOT_0"\)\) \(subpath \(param "ROOT_1"\)\)\)/);
	assert.match(profile, /\(deny file-read-data file-read-xattr \(subpath "\/Users"\)/);
	assert.doesNotMatch(profile, /\/Users\/\w/, "no user paths are embedded");

	const { command, args } = sandboxCommand({ executable: "/opt/node/bin/node", roots: ["/opt/node"] }, "/private/tmp/work", ["a.mjs"]);
	assert.equal(command, "/usr/bin/sandbox-exec");
	assert.deepEqual(args.slice(-2), ["/opt/node/bin/node", "a.mjs"]);
	assert.ok(args.includes("WORK_DIR=/private/tmp/work"));
	assert.ok(args.includes("ROOT_0=/opt/node"));
});

test("interpreter roots may not expose the home directory", () => {
	const home = "/Users/me";
	assert.deepEqual(checkRoots(["/Users/me/.nvm/versions/node/v24", "/opt/homebrew/Cellar/python/3.14/"], home), [
		"/Users/me/.nvm/versions/node/v24",
		"/opt/homebrew/Cellar/python/3.14",
	]);
	for (const root of ["/", "/Users", "/Users/me", "/Users/me/"]) {
		assert.throws(() => checkRoots([root], home), /expose the home directory/, root);
	}
});

test("the sandbox fails closed off macOS or without sandbox-exec", () => {
	assert.match(sandboxUnavailable("linux", () => true)!, /only available on macOS \(this is linux\)/);
	assert.match(sandboxUnavailable("darwin", () => false)!, /sandbox-exec was not found/);
	assert.equal(sandboxUnavailable("darwin", () => true), undefined);
});

test("the sandboxed environment carries no host variables", () => {
	process.env.CODE_MODE_TEST_SECRET = "hunter2";
	const env = sandboxEnv("/private/tmp/work", { PI_CODE_MODE_TOOLS: "[]" });
	assert.equal(env.CODE_MODE_TEST_SECRET, undefined);
	assert.equal(env.HOME, "/private/tmp/work");
	assert.equal(env.TMPDIR, "/private/tmp/work");
	assert.equal(env.PI_CODE_MODE_TOOLS, "[]");
	delete process.env.CODE_MODE_TEST_SECRET;
});

test("resolved interpreters are real installations", { skip: unavailable }, async () => {
	for (const [language, command] of [
		["javascript", process.execPath],
		["python", "python3"],
	] as const) {
		const interpreter = await resolveInterpreter(language, command);
		assert.ok(existsSync(interpreter.executable), interpreter.executable);
		assert.ok(interpreter.roots.length > 0);
		assert.ok(interpreter.roots.every((root) => !realpathSync(homedir()).startsWith(root)));
	}
});

const PROBES: Record<Language, string> = {
	javascript: `import fs from "node:fs"; import net from "node:net"; import { execFileSync } from "node:child_process";
const t = async (name, f) => { try { await f(); console.log(name, "ALLOWED"); } catch (e) { console.log(name, "blocked"); } };
console.log(await tools.echo({ via: "tool" }));
await t("read-cwd", () => fs.readFileSync("secret.txt", "utf8"));
await t("list-home", () => fs.readdirSync(${JSON.stringify(homedir())}));
await t("write-cwd", () => fs.writeFileSync("pwn.txt", "x"));
await t("write-tmp", () => fs.writeFileSync(process.env.TMPDIR + "/scratch.txt", "ok"));
await t("network", () => new Promise((res, rej) => { const s = net.connect(443, "1.1.1.1", () => { s.destroy(); res(); }); s.on("error", rej); setTimeout(() => rej(new Error("timeout")), 3000).unref(); }));
await t("subprocess", () => execFileSync("/bin/echo", ["x"]));
await t("signal-parent", () => process.kill(process.ppid, "SIGCONT"));
console.log("secret-env", process.env.CODE_MODE_TEST_SECRET ?? "absent");`,
	python: `import os, socket, subprocess, signal
def t(name, f):
    try:
        f(); print(name, "ALLOWED")
    except Exception:
        print(name, "blocked")
print(tools.echo(via="tool"))
t("read-cwd", lambda: open("secret.txt").read())
t("list-home", lambda: os.listdir(${JSON.stringify(homedir())}))
t("write-cwd", lambda: open("pwn.txt", "w"))
t("write-tmp", lambda: open(os.path.join(os.environ["TMPDIR"], "scratch.txt"), "w").write("ok"))
t("network", lambda: socket.create_connection(("1.1.1.1", 443), timeout=3))
t("subprocess", lambda: subprocess.run(["/bin/echo", "x"], check=True, capture_output=True))
t("signal-parent", lambda: os.kill(os.getppid(), signal.SIGCONT))
print("secret-env", os.environ.get("CODE_MODE_TEST_SECRET", "absent"))`,
};

for (const language of ["javascript", "python"] as const) {
	test(`${language}: a sandboxed program reaches the host only through tools`, { skip: unavailable }, async () => {
		process.env.CODE_MODE_TEST_SECRET = "hunter2";
		try {
			const result = await runProgram({
				language,
				code: PROBES[language],
				cwd,
				sandbox: true,
				toolNames: ["echo"],
				call: async (_tool, args) => `echo:${JSON.stringify(args)}`,
			});
			assert.equal(result.exitCode, 0, result.output);
			const lines = result.output.trim().split("\n");
			assert.deepEqual(lines, [
				'echo:{"via":"tool"}',
				"read-cwd blocked",
				"list-home blocked",
				"write-cwd blocked",
				"write-tmp ALLOWED",
				"network blocked",
				"subprocess blocked",
				"signal-parent blocked",
				"secret-env absent",
			]);
			assert.equal(existsSync(join(cwd, "pwn.txt")), false);
		} finally {
			delete process.env.CODE_MODE_TEST_SECRET;
		}
	});
}

test("a sandboxed program cannot signal an unrelated process", { skip: unavailable }, async () => {
	const victim = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
	try {
		const result = await runProgram({
			language: "python",
			code: `import os, signal\ntry:\n    os.kill(${victim.pid}, signal.SIGTERM)\n    print("killed")\nexcept PermissionError:\n    print("blocked")`,
			cwd,
			sandbox: true,
			toolNames: [],
			call: async () => "",
		});
		assert.equal(result.output.trim(), "blocked");
		assert.equal(victim.exitCode, null);
		assert.equal(victim.signalCode, null);
	} finally {
		victim.kill();
	}
});

test("timeouts still stop a sandboxed program", { skip: unavailable }, async () => {
	const started = Date.now();
	const result = await runProgram({
		language: "javascript",
		code: "setInterval(() => {}, 1000);",
		cwd,
		sandbox: true,
		timeoutSeconds: 0.5,
		toolNames: [],
		call: async () => "",
	});
	assert.equal(result.timedOut, true);
	assert.ok(Date.now() - started < 5000);
});
