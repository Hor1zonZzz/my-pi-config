import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	ALL_COMPONENT_IDS,
	COMPONENTS,
	MANAGED_PACKAGE_SOURCES,
	displayWidth,
	mergeSettings,
	parseCliArgs,
	resolveNonInteractivePlan,
	truncateWidth,
} from "./install-cli.mjs";

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));

async function createTestHarness(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pi-install-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	const agent = join(root, "agent");
	const bin = join(root, "bin");
	await Promise.all([mkdir(repo), mkdir(agent), mkdir(bin)]);
	for (const path of ["install.sh", "install-cli.mjs", "settings.json", "extensions", "prompts", "skills"]) {
		await cp(join(REPO_ROOT, path), join(repo, path), {
			recursive: true,
			filter: (src) => !src.includes("/engine/target"),
		});
	}
	const gitLog = join(root, "git.log");
	await writeFile(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${gitLog}"\nexit 1\n`, { mode: 0o755 });
	const piLog = join(root, "pi.log");
	await writeFile(
		join(bin, "pi"),
		`#!/bin/sh\nprintf '%s |%s\\n' "$PI_CODING_AGENT_DIR" "$*" >> "${piLog}"\ncase "$*" in *pi-voice*) exit 1;; esac\n`,
		{ mode: 0o755 },
	);
	const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: agent };
	const runInstall = (args: string[] = []) =>
		execFileSync("bash", [join(repo, "install.sh"), ...args], {
			cwd: repo,
			encoding: "utf8",
			env,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
		});
	return { root, repo, agent, bin, gitLog, piLog, env, runInstall };
}

test("manifest covers every repo extension, prompt, and settings.json package", async () => {
	const extEntries = await readdir(join(REPO_ROOT, "extensions"));
	const manifestExtPaths = new Set(COMPONENTS.map((c) => c.extPath).filter(Boolean));
	for (const entry of extEntries) {
		assert.ok(manifestExtPaths.has(entry), `extensions/${entry} must be in install-cli.mjs COMPONENTS`);
	}

	const promptEntries = (await readdir(join(REPO_ROOT, "prompts"))).filter((f) => f.endsWith(".md"));
	const manifestPrompts = new Set(COMPONENTS.map((c) => c.promptFile).filter(Boolean));
	for (const entry of promptEntries) {
		assert.ok(manifestPrompts.has(entry), `prompts/${entry} must be in install-cli.mjs COMPONENTS`);
	}

	const repoSettings = JSON.parse(await readFile(join(REPO_ROOT, "settings.json"), "utf8"));
	const repoPackages = repoSettings.packages.map((entry: string | { source: string }) =>
		typeof entry === "string" ? entry : entry.source,
	);
	for (const pkg of repoPackages) {
		assert.ok(MANAGED_PACKAGE_SOURCES.has(pkg), `settings.json package ${pkg} must be in COMPONENTS`);
	}
	assert.equal(MANAGED_PACKAGE_SOURCES.size, repoPackages.length);
});

test("default non-TTY install preserves Pi's ChatGPT deviceId and local default model, retires mpl, installs inline-chart, and updates latest-tracking packages", async (t) => {
	const { repo, agent, piLog, runInstall } = await createTestHarness(t);
	const mplDir = join(agent, "extensions", "mpl");
	await mkdir(mplDir, { recursive: true });
	await writeFile(join(mplDir, "old.ts"), "previous mpl");

	const deviceId = "00000000-0000-4000-8000-000000000001";
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({
			deviceId,
			lastChangelogVersion: "0.99.1",
			defaultProvider: "openai",
			defaultModel: "gpt-6.1-sol",
			packages: ["npm:my-custom-third-party-plugin"],
		}),
	);
	// The installer must leave local credentials and the user's models.json untouched.
	const secrets = ["auth.json", "models.json", "codex-accounts.json", "openai-accounts.json"];
	for (const path of secrets) await writeFile(join(agent, path), `synthetic untouched ${path}`, { mode: 0o600 });

	const output = runInstall();

	// Retired mpl is backed up and removed; inline-chart is installed.
	const extNames = await readdir(join(agent, "extensions"));
	assert.ok(!extNames.includes("mpl"));
	assert.ok(extNames.includes("inline-chart"));
	const [backup] = await readdir(join(agent, "backups"));
	assert.equal(await readFile(join(agent, "backups", backup, "extensions", "mpl", "old.ts"), "utf8"), "previous mpl");

	const installed = JSON.parse(await readFile(join(agent, "settings.json"), "utf8"));
	assert.equal(installed.deviceId, deviceId);
	assert.equal(installed.lastChangelogVersion, "0.99.1");
	assert.equal(installed.defaultProvider, "openai");
	assert.equal(installed.defaultModel, "gpt-6.1-sol");
	assert.equal(installed.subagents, undefined);
	assert.equal(await readlink(join(agent, "bin", "subagent")), "../git/github.com/badlogic/pi-subagent/subagent.ts");
	assert.match(output, /backups\/my-pi-config-/);
	for (const path of secrets) assert.equal(await readFile(join(agent, path), "utf8"), `synthetic untouched ${path}`);

	const repoSettings = JSON.parse(await readFile(join(repo, "settings.json"), "utf8"));
	for (const key of ["deviceId", "defaultProvider", "defaultModel"]) assert.equal(repoSettings[key], undefined, key);

	assert.deepEqual(
		(await readFile(piLog, "utf8")).trim().split("\n"),
		[
			"npm:@earendil-works/pi-voice",
			"git:github.com/badlogic/pi-subagent",
			"npm:@router-for-me/pi-cliproxyapi-provider",
			"git:github.com/johnlindquist/pi-emphasis",
		].map((source) => `${agent} |update --extension ${source} --no-approve`),
	);
	const packages = installed.packages.map((entry: string | { source: string }) =>
		typeof entry === "string" ? entry : entry.source,
	);
	for (const source of [
		"npm:@earendil-works/pi-voice",
		"git:github.com/badlogic/pi-subagent",
		"npm:@router-for-me/pi-cliproxyapi-provider",
		"git:github.com/johnlindquist/pi-emphasis",
		"npm:my-custom-third-party-plugin",
	]) {
		assert.ok(packages.includes(source), source);
	}
});

test("--only installs selected items only, skips unrelated bundles/updates, and sync-removes unselected repo items", async (t) => {
	const { agent, gitLog, piLog, runInstall } = await createTestHarness(t);

	// First install everything
	runInstall(["--all"]);
	assert.ok(existsSync(join(agent, "extensions", "herdr")));
	assert.ok(existsSync(join(agent, "skills", "herdr", "SKILL.md")));
	assert.equal(await readlink(join(agent, "bin", "subagent")), "../git/github.com/badlogic/pi-subagent/subagent.ts");

	// Reset logs, then sync to only btw + notify + understand
	await rm(gitLog, { force: true });
	await rm(piLog, { force: true });
	runInstall(["--only", "btw,notify,understand"]);

	assert.deepEqual((await readdir(join(agent, "extensions"))).sort(), ["btw", "notify.ts"]);
	assert.deepEqual((await readdir(join(agent, "prompts"))).sort(), ["understand.md"]);
	assert.equal(existsSync(join(agent, "skills", "herdr")), false);
	assert.equal(existsSync(join(agent, "skills", "herdr-pi-reference")), false);
	assert.throws(() => lstatSync(join(agent, "bin", "subagent")));
	assert.equal(existsSync(gitLog), false, "herdr skill sync must not run when herdr is unselected");
	assert.equal(existsSync(piLog), false, "pi update must not run when no latest packages are selected");

	const settings = JSON.parse(await readFile(join(agent, "settings.json"), "utf8"));
	assert.deepEqual(settings.packages, []);
});

test("bundled components install and remove their coupled artifacts together", async (t) => {
	const { agent, piLog, runInstall } = await createTestHarness(t);

	// Install herdr + pi-subagent bundles only
	runInstall(["--only", "herdr,pi-subagent"]);

	assert.deepEqual(await readdir(join(agent, "extensions")), ["herdr"]);
	assert.ok(existsSync(join(agent, "skills", "herdr", "SKILL.md")));
	assert.ok(existsSync(join(agent, "skills", "herdr-pi-reference", "SKILL.md")));
	assert.equal(await readlink(join(agent, "bin", "subagent")), "../git/github.com/badlogic/pi-subagent/subagent.ts");

	const settings = JSON.parse(await readFile(join(agent, "settings.json"), "utf8"));
	assert.deepEqual(settings.packages, ["npm:@ogulcancelik/pi-herdr", "git:github.com/badlogic/pi-subagent"]);
	assert.deepEqual((await readFile(piLog, "utf8")).trim().split("\n"), [
		`${agent} |update --extension git:github.com/badlogic/pi-subagent --no-approve`,
	]);

	// Incrementally --add memory + prompts without disturbing herdr or pi-subagent
	await rm(piLog, { force: true });
	runInstall(["--add", "memory,prompts"]);

	assert.deepEqual((await readdir(join(agent, "extensions"))).sort(), ["herdr", "memory"]);
	assert.deepEqual((await readdir(join(agent, "prompts"))).sort(), ["explore-understand.md", "understand.md"]);
	assert.ok(existsSync(join(agent, "skills", "herdr", "SKILL.md")));
	assert.equal(await readlink(join(agent, "bin", "subagent")), "../git/github.com/badlogic/pi-subagent/subagent.ts");
	assert.equal(existsSync(piLog), false);

	// --remove herdr removes all coupled herdr pieces while keeping memory, prompts, and pi-subagent
	runInstall(["--remove", "herdr"]);
	assert.deepEqual(await readdir(join(agent, "extensions")), ["memory"]);
	assert.equal(existsSync(join(agent, "skills", "herdr")), false);
	assert.equal(existsSync(join(agent, "skills", "herdr-pi-reference")), false);
	const afterRemove = JSON.parse(await readFile(join(agent, "settings.json"), "utf8"));
	assert.deepEqual(afterRemove.packages, ["git:github.com/badlogic/pi-subagent"]);
	assert.equal(await readlink(join(agent, "bin", "subagent")), "../git/github.com/badlogic/pi-subagent/subagent.ts");
});

test("--list and --help exit cleanly without modifying agent dir or creating backups", async (t) => {
	const { agent, runInstall } = await createTestHarness(t);

	const listOut = runInstall(["--list"]);
	assert.match(listOut, /herdr/);
	assert.match(listOut, /\[套装\]/);
	assert.match(listOut, /pi-subagent/);

	const helpOut = runInstall(["--help"]);
	assert.match(helpOut, /--only/);
	assert.match(helpOut, /--add/);

	assert.deepEqual(await readdir(agent), []);
});

test("CLI parsing, plan resolution, settings merge, and display width unit checks", () => {
	const p1 = parseCliArgs(["--all", "--exclude", "herdr,prompts"]);
	const plan1 = resolveNonInteractivePlan(p1, { isTTY: true, installedIds: new Set(["herdr", "btw"]) });
	assert.ok(plan1);
	assert.equal(plan1.mode, "sync");
	assert.ok(!plan1.install.includes("herdr"));
	assert.ok(!plan1.install.includes("understand"));
	assert.ok(!plan1.install.includes("explore-understand"));
	assert.ok(plan1.install.includes("btw"));
	assert.deepEqual(plan1.removingInstalled, ["herdr"]);

	// Interactive TTY with no flags defers to TUI (returns null)
	const pEmpty = parseCliArgs([]);
	assert.equal(resolveNonInteractivePlan(pEmpty, { isTTY: true, installedIds: new Set() }), null);
	// Non-TTY with no flags installs all
	const nonTtyPlan = resolveNonInteractivePlan(pEmpty, { isTTY: false, installedIds: new Set() });
	assert.deepEqual(nonTtyPlan?.install, ALL_COMPONENT_IDS);

	assert.throws(() => parseCliArgs(["--only", "nonexistent"]), /未知组件或分组/);
	assert.throws(() => parseCliArgs(["--add", "btw", "--only", "memory"]), /不能与/);

	const merged = mergeSettings(
		{ defaultThinkingLevel: "medium", theme: "dark", packages: ["npm:pi-annotate"] },
		{ theme: "light", packages: ["npm:custom-user-pkg"] },
		{ mode: "add", install: ["pi-annotate"], remove: [] },
	);
	assert.equal(merged.theme, "light");
	assert.deepEqual(merged.packages, ["npm:custom-user-pkg", "npm:pi-annotate"]);

	assert.equal(displayWidth("ab中文"), 6);
	assert.equal(displayWidth("\x1b[32m✓\x1b[0m 中文"), 6);
	assert.equal(displayWidth(truncateWidth("中文测试内容很长", 7)), 7);
});
