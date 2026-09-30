import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("install preserves Pi's ChatGPT deviceId, runtime switches, and both credential vaults", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-install-accounts-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, "repo"); const agent = join(root, "agent"); const bin = join(root, "bin");
	await Promise.all([mkdir(repo), mkdir(agent), mkdir(bin)]);
	const source = dirname(fileURLToPath(import.meta.url));
	for (const path of ["install.sh", "settings.json", "model-overrides.json", "extensions", "prompts", "skills"]) {
		await cp(join(source, path), join(repo, path), { recursive: true });
	}
	// Exercise the offline skill-cache fallback; never update the real skill cache.
	await writeFile(join(bin, "git"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	const deviceId = "00000000-0000-4000-8000-000000000001";
	await writeFile(join(agent, "settings.json"), JSON.stringify({ deviceId, lastChangelogVersion: "0.99.1", subagents: { enabled: false } }));
	const secrets = ["auth.json", "codex-accounts.json", "openai-accounts.json"];
	for (const path of secrets) await writeFile(join(agent, path), `synthetic untouched ${path}`, { mode: 0o600 });
	const output = execFileSync("bash", [join(repo, "install.sh")], {
		cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: agent },
		stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
	});
	const installed = JSON.parse(await readFile(join(agent, "settings.json"), "utf8"));
	assert.equal(installed.deviceId, deviceId);
	assert.equal(installed.lastChangelogVersion, "0.99.1");
	assert.equal(installed.subagents.enabled, false);
	assert.match(output, /backups\/my-pi-config-/);
	for (const path of secrets) assert.equal(await readFile(join(agent, path), "utf8"), `synthetic untouched ${path}`);
	assert.ok(!JSON.parse(await readFile(join(repo, "settings.json"), "utf8")).deviceId);
});
