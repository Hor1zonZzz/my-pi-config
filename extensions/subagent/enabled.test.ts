import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setSubagentsEnabled, subagentsEnabled, toggleSubagents } from "./enabled.ts";
import register from "./index.ts";

const root = mkdtempSync(join(tmpdir(), "subagent-enabled-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(agentDir, { recursive: true });
const settingsFile = join(agentDir, "settings.json");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

function load() {
	const tools: string[] = [];
	const commands = new Map<string, any>();
	const events = new Map<string, any>();
	const renderers: string[] = [];
	const pi = {
		on: (name: string, handler: any) => events.set(name, handler),
		registerTool: (tool: any) => tools.push(tool.name),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerMessageRenderer: (type: string) => renderers.push(type),
		sendMessage() {},
	} as unknown as ExtensionAPI;
	register(pi);
	return { tools, commands, events, renderers };
}

function commandContext(confirm = true) {
	const notes: string[] = [];
	let reloads = 0;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: { notify: (message: string) => notes.push(message), confirm: async () => confirm },
		reload: async () => {
			reloads++;
		},
	} as any;
	return { ctx, notes, reloads: () => reloads };
}

test("the switch defaults to on and keeps every other setting when changed", () => {
	rmSync(settingsFile, { force: true });
	assert.equal(subagentsEnabled(), true, "no settings file");
	writeFileSync(settingsFile, "{ broken");
	assert.equal(subagentsEnabled(), true, "unreadable settings do not turn subagents off");
	assert.throws(() => setSubagentsEnabled(false), /Cannot update .*settings\.json/);
	assert.equal(readFileSync(settingsFile, "utf8"), "{ broken", "a file it cannot parse is left alone");

	writeFileSync(settingsFile, JSON.stringify({ theme: "dark", subagents: { enabled: true, other: 1 } }));
	setSubagentsEnabled(false);
	assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), { theme: "dark", subagents: { enabled: false, other: 1 } });
	assert.equal(subagentsEnabled(), false);
});

test("while off, the extension registers no tools, prompts, panel, or notices", () => {
	writeFileSync(settingsFile, JSON.stringify({ subagents: { enabled: false } }));
	const off = load();
	assert.deepEqual(off.tools, []);
	assert.deepEqual([...off.commands.keys()], ["subagent"], "only the way back");
	assert.deepEqual([...off.events.keys()], [], "no session, context, or resource hooks");
	assert.deepEqual(off.renderers.sort(), ["subagent-completion", "subagent-status"], "old messages keep their look");

	writeFileSync(settingsFile, JSON.stringify({ subagents: { enabled: true } }));
	const on = load();
	assert.deepEqual(on.tools.sort(), ["subagent", "subagent_control"]);
	assert.ok(["subagent", "subagent-history", "subagent-jobs"].every((name) => on.commands.has(name)));
	const { promptPaths } = on.events.get("resources_discover")();
	assert.equal(promptPaths.length, 1);
	assert.deepEqual(readdirSync(promptPaths[0]).sort(), ["implement-and-review.md", "implement.md", "scout-and-plan.md", "scout.md"]);
});

test("/subagent off asks before stopping running subagents, then writes the switch and reloads", async () => {
	writeFileSync(settingsFile, JSON.stringify({ theme: "dark" }));
	const declined = commandContext(false);
	await toggleSubagents(false, declined.ctx, 2);
	assert.equal(subagentsEnabled(), true, "declining changes nothing");
	assert.equal(declined.reloads(), 0);

	const accepted = commandContext(true);
	await toggleSubagents(false, accepted.ctx, 2);
	assert.equal(subagentsEnabled(), false);
	assert.equal(accepted.reloads(), 1);
	assert.deepEqual(accepted.notes, ["Subagents off; reloading."]);

	const again = commandContext();
	await toggleSubagents(false, again.ctx);
	assert.deepEqual(again.notes, ["Subagents are already off."]);
	assert.equal(again.reloads(), 0);
});

test("while off, /subagent on turns them back on; other arguments only explain", async () => {
	writeFileSync(settingsFile, JSON.stringify({ subagents: { enabled: false } }));
	const off = load();
	const explain = commandContext();
	await off.commands.get("subagent").handler("", explain.ctx);
	assert.deepEqual(explain.notes, ["Subagents are off. /subagent on turns them on."]);
	const turnOn = commandContext();
	await off.commands.get("subagent").handler("on", turnOn.ctx);
	assert.equal(subagentsEnabled(), true);
	assert.equal(turnOn.reloads(), 1);
	assert.ok(existsSync(settingsFile));
});
