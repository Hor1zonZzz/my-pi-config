import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAgents } from "./agents.ts";

const root = mkdtempSync(join(tmpdir(), "subagent-agents-"));
process.env.PI_CODING_AGENT_DIR = root;
cpSync(new URL("./agents", import.meta.url), join(root, "agents"), { recursive: true });
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

test("the bundled agents: worker is a plain Pi, the others list their tools", () => {
	const agents = Object.fromEntries(discoverAgents(root, "user").agents.map((agent) => [agent.name, agent]));
	assert.deepEqual(Object.keys(agents).sort(), ["planner", "reviewer", "scout", "worker"]);
	assert.equal(agents.worker!.extensions, false);
	assert.equal(agents.worker!.tools, undefined);
	for (const name of ["planner", "reviewer", "scout"]) {
		assert.equal(agents[name]!.extensions, undefined, name);
		assert.ok(agents[name]!.tools?.length && !agents[name]!.tools!.includes("subagent"), `${name} cannot start subagents`);
	}
	assert.equal(agents.scout!.model, "deepseek/deepseek-flash");
	assert.equal(agents.scout!.thinkingLevel, "high");
});
