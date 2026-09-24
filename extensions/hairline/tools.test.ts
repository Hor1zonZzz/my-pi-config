import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { setTrueColorOverride } from "./style.ts";
import { registerHairlineTools } from "./tools.ts";

setTrueColorOverride(true);
initTheme("dark");
// Pi hands its global theme to tool renderers; load that same module instance.
const { theme } = await import(
	new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
);
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "").trimEnd();
const SPIN = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]";

function setup(enabled = true) {
	const registered = new Map<string, any>();
	let clock = 10_000;
	let on = enabled;
	const api = { registerTool: (tool: any) => registered.set(tool.name, tool) } as unknown as ExtensionAPI;
	const handle = registerHairlineTools(api, { isEnabled: () => on, now: () => clock });
	return {
		registered,
		handle,
		enable: (value: boolean) => (on = value),
		advance: (ms: number) => (clock += ms),
	};
}

interface RowUpdate {
	args: any;
	started?: boolean;
	result?: any;
	partial?: boolean;
	error?: boolean;
	expanded?: boolean;
	width?: number;
}

/** Mirrors ToolExecutionComponent with a self-drawn shell: call renderer, then result renderer. */
function row(tool: any, cwd = "/repo") {
	const state: any = {};
	let call: any;
	let result: any;
	const update = (u: RowUpdate) => {
		const width = u.width ?? 80;
		const context = {
			args: u.args,
			toolCallId: "call-1",
			invalidate() {},
			state,
			cwd,
			executionStarted: !!u.started,
			argsComplete: true,
			isPartial: !!u.partial,
			expanded: !!u.expanded,
			showImages: false,
			isError: !!u.error,
		};
		// Pi runs both renderers during updateDisplay() and draws them on the next frame.
		call = tool.renderCall(u.args, theme, { ...context, lastComponent: call });
		if (u.result) {
			result = tool.renderResult(u.result, { expanded: !!u.expanded, isPartial: !!u.partial }, theme, { ...context, lastComponent: result });
		}
		const lines: string[] = [...call.render(width), ...(u.result ? result.render(width) : [])];
		for (const line of lines) assert.ok(visibleWidth(line) <= width, JSON.stringify(plain(line)));
		return lines.map(plain);
	};
	return { update, state };
}

const text = (value: string) => ({ content: [{ type: "text", text: value }] });

test("keeps each built-in tool's model-facing contract", () => {
	const { registered } = setup();
	const originals = {
		read: createReadToolDefinition(process.cwd()),
		bash: createBashToolDefinition(process.cwd()),
		edit: createEditToolDefinition(process.cwd()),
		write: createWriteToolDefinition(process.cwd()),
	} as Record<string, any>;
	assert.deepEqual([...registered.keys()], ["read", "bash", "edit", "write"]);
	for (const [name, original] of Object.entries(originals)) {
		const tool = registered.get(name);
		for (const key of ["name", "label", "description", "promptSnippet", "promptGuidelines", "parameters", "constrainedSampling", "executionMode"]) {
			assert.deepEqual(tool[key], original[key], `${name}.${key}`);
		}
		assert.equal(tool.prepareArguments, original.prepareArguments, `${name}.prepareArguments`);
		assert.equal(tool.renderShell, "self");
	}
});

test("executes through Pi's tools with the user's settings and project trust", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "hairline-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "hairline-cwd-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellCommandPrefix: "HAIRLINE_SOURCE=global" }));
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: "HAIRLINE_SOURCE=project" }));
		writeFileSync(join(cwd, "note.txt"), "alpha\nbeta\n");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const { registered } = setup();
		const bash = registered.get("bash");
		const sessionManager = { getSessionId: () => "test-session", getSessionFile: () => undefined };
		const run = async (trusted: boolean) => {
			const result = await bash.execute("id", { command: "echo $HAIRLINE_SOURCE" }, undefined, undefined, { cwd, isProjectTrusted: () => trusted, sessionManager });
			return result.content[0].text.trim();
		};
		assert.equal(await run(false), "global");
		assert.equal(await run(true), "project");
		const read = await registered.get("read").execute("id", { path: "note.txt" }, undefined, undefined, { cwd, isProjectTrusted: () => false, sessionManager });
		assert.match(read.content[0].text, /alpha\nbeta/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("renders read, edit, and write as one-line cards", () => {
	const { registered } = setup();
	const read = row(registered.get("read"));
	assert.match(read.update({ args: { path: "/repo/src/a.ts" } })[0]!, /^  ·  read  src\/a\.ts$/);
	assert.match(read.update({ args: { path: "/repo/src/a.ts" }, started: true })[0]!, new RegExp(`^  ${SPIN}  read  src/a\\.ts$`));
	const done = read.update({ args: { path: "/repo/src/a.ts" }, started: true, result: text("one\ntwo\nthree\n") });
	assert.deepEqual(done.length, 1);
	assert.match(done[0]!, /^  ●  read  src\/a\.ts +3 lines$/);
	assert.match(row(registered.get("read")).update({ args: { path: "a.ts", offset: 120, limit: 40 } })[0]!, /read  a\.ts:120-159/);

	const edit = row(registered.get("edit")).update({
		args: { path: "install.sh", edits: [] },
		started: true,
		result: { content: [{ type: "text", text: "ok" }], details: { diff: " 1 a\n-2 old\n+2 new\n+3 add" } },
	});
	assert.match(edit[0]!, /^  ●  edit  install\.sh +\+2 −1  ■■■■■$/);

	const write = row(registered.get("write")).update({ args: { path: "notes.md", content: "a\nb\nc\n" }, started: true, result: text("ok") });
	assert.match(write[0]!, /write notes\.md +3 lines$/);

	const failed = row(registered.get("read")).update({ args: { path: "missing.ts" }, started: true, error: true, result: text("ENOENT: no such file\nstack") });
	assert.match(failed[0]!, /^  ✕  read  missing\.ts +failed$/);
	assert.match(failed[1]!, /^     ╰ ENOENT: no such file$/);
});

test("renders running, failed, and finished bash commands", () => {
	const { registered, advance } = setup();
	const bash = row(registered.get("bash"));
	const args = { command: "bash -n install.sh\n  && git diff --check" };
	bash.update({ args, started: true });
	advance(1_500);
	const running = bash.update({ args, started: true, partial: true, result: text("checking\ninstall.sh ok\n") });
	assert.match(running[0]!, new RegExp(`^  ${SPIN}  bash  bash -n install\\.sh && git diff --check +running · 1\\.5s$`));
	assert.match(running[1]!, /╰ install\.sh ok$/);
	advance(500);
	const failed = bash.update({ args, started: true, error: true, result: text("line 88: syntax error\n\nCommand exited with code 2") });
	assert.match(failed[0]!, /^  ✕  bash .* exit 2 · 2\.0s$/);
	assert.match(failed[1]!, /╰ line 88: syntax error$/);

	const ok = row(registered.get("bash"));
	ok.update({ args: { command: "true" }, started: true });
	advance(1_200);
	assert.match(ok.update({ args: { command: "true" }, started: true, result: text("") })[0]!, /exit 0 · 1\.2s$/);
});

test("expanded view and disabled skin use Pi's own renderers", () => {
	const { registered, enable } = setup();
	const bash = row(registered.get("bash"));
	const expanded = bash.update({ args: { command: "echo hi" }, started: true, result: text("hi"), expanded: true });
	assert.equal(expanded[0], "  $ echo hi");
	assert.ok(expanded.includes("  hi"));

	enable(false);
	const off = row(registered.get("bash")).update({ args: { command: "echo hi" }, started: true, result: text("hi") });
	assert.equal(off[0], "$ echo hi");
});

test("stops Pi's bash refresh timer after collapsing a finished command", () => {
	const { registered } = setup();
	const bash = row(registered.get("bash"));
	const args = { command: "sleep 1" };
	bash.update({ args, started: true, partial: true, result: text(""), expanded: true });
	assert.ok(bash.state.builtIn.state.interval, "Pi's renderer starts its elapsed-time timer while partial");
	bash.update({ args, started: true, result: text("") });
	assert.equal(bash.state.builtIn.state.interval, undefined);
});
