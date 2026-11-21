import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("install preserves Pi's ChatGPT deviceId and the local default model, the subagent CLI link, and both credential vaults, and updates the latest-tracking packages", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-install-accounts-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, "repo"); const agent = join(root, "agent"); const bin = join(root, "bin");
	await Promise.all([mkdir(repo), mkdir(agent), mkdir(bin)]);
	const source = dirname(fileURLToPath(import.meta.url));
	for (const path of ["install.sh", "settings.json", "extensions", "prompts", "skills"]) {
		await cp(join(source, path), join(repo, path), { recursive: true });
	}
	// Stub both upstream repositories. Herdr falls back to its cache; mpl must not.
	await writeFile(join(bin, "git"), `#!/bin/sh
set -eu
[ "$*" = "clone --depth 1 --single-branch --branch main https://github.com/dmmulroy/.dotfiles.git $8" ] || exit 1
[ "$MPL_FAILURE" != fetch ] || exit 1
dir="$8/home/.pi/agent/extensions/mpl"
mkdir -p "$dir" "$8/unrelated"
printf '%s' '{"workspaces":["agent/extensions/*"]}' > "$8/home/.pi/package.json"
[ "$MPL_FAILURE" != missing ] || exit 0
printf '%s' '{"pi":{"extensions":["./index.ts"]}}' > "$dir/package.json"
printf '%s' 'latest mpl' > "$dir/index.ts"
`, { mode: 0o755 });
	await writeFile(join(bin, "npm"), `#!/bin/sh
set -eu
[ "$*" = 'install --omit=dev --engine-strict --no-audit --no-fund' ]
# npm must run outside the checkout's workspace so node_modules stays with mpl.
case "$PWD" in */.mpl.*/mpl) ;; *) exit 1 ;; esac
[ -f package.json ]
[ "$MPL_FAILURE" != npm ]
mkdir node_modules
touch node_modules/dependency-installed
`, { mode: 0o755 });
	const mplDir = join(agent, "extensions", "mpl");
	await mkdir(mplDir, { recursive: true });
	await writeFile(join(mplDir, "old.ts"), "previous mpl");
	// Record package updates instead of reaching npm or GitHub; one failure must not abort the install.
	const piLog = join(root, "pi.log");
	await writeFile(join(bin, "pi"), `#!/bin/sh\nprintf '%s |%s\\n' "\$PI_CODING_AGENT_DIR" "\$*" >> "${piLog}"\ncase "\$*" in *pi-voice*) exit 1;; esac\n`, { mode: 0o755 });
	const deviceId = "00000000-0000-4000-8000-000000000001";
	await writeFile(join(agent, "settings.json"), JSON.stringify({ deviceId, lastChangelogVersion: "0.99.1", defaultProvider: "openai", defaultModel: "gpt-6.1-sol" }));
	// The installer must leave local credentials and the user's models.json untouched.
	const secrets = ["auth.json", "models.json", "codex-accounts.json", "openai-accounts.json"];
	for (const path of secrets) await writeFile(join(agent, path), `synthetic untouched ${path}`, { mode: 0o600 });
	const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: agent, MPL_FAILURE: "" };
	const output = execFileSync("bash", [join(repo, "install.sh")], {
		cwd: repo, encoding: "utf8", env,
		stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
	});
	assert.match(output, /Installed mpl from .* \(main\)/);
	assert.deepEqual((await readdir(mplDir)).sort(), ["index.ts", "node_modules", "package.json"]);
	assert.equal(await readFile(join(mplDir, "index.ts"), "utf8"), "latest mpl");
	assert.equal(await readFile(join(mplDir, "node_modules", "dependency-installed"), "utf8"), "");
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
	assert.deepEqual((await readFile(piLog, "utf8")).trim().split("\n"), [
		"npm:@earendil-works/pi-voice",
		"git:github.com/badlogic/pi-subagent",
		"npm:@router-for-me/pi-cliproxyapi-provider",
		"git:github.com/johnlindquist/pi-emphasis",
	].map((source) => `${agent} |update --extension ${source} --no-approve`));
	const packages = installed.packages.map((entry: string | { source: string }) => typeof entry === "string" ? entry : entry.source);
	for (const source of ["npm:@earendil-works/pi-voice", "git:github.com/badlogic/pi-subagent", "npm:@router-for-me/pi-cliproxyapi-provider", "git:github.com/johnlindquist/pi-emphasis"]) assert.ok(packages.includes(source), source);

	for (const [failure, message] of [
		["fetch", /Error: Could not fetch the latest mpl extension/],
		["missing", /Error: The upstream mpl extension is missing its package.json/],
		["npm", /Error: Could not install mpl runtime dependencies/],
	] as const) {
		await t.test(`mpl ${failure} failure aborts without replacing the installed copy`, async () => {
			const failedAgent = join(root, `agent-${failure}`);
			const previous = join(failedAgent, "extensions", "mpl");
			await cp(mplDir, previous, { recursive: true });
			const result = spawnSync("bash", [join(repo, "install.sh")], {
				cwd: repo, encoding: "utf8", env: { ...env, PI_CODING_AGENT_DIR: failedAgent, MPL_FAILURE: failure },
				timeout: 30_000,
			});
			assert.equal(result.status, 1, result.stderr);
			assert.match(result.stderr, message);
			assert.doesNotMatch(result.stdout, /Installed Pi configuration/);
			assert.equal(await readFile(join(previous, "index.ts"), "utf8"), "latest mpl");
			assert.equal(await readFile(join(previous, "node_modules", "dependency-installed"), "utf8"), "");
			assert.ok((await readdir(failedAgent)).every((name) => !name.startsWith(".mpl.")));
		});
	}
});
