import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { getSharedQuota, REFRESH_MS } from "./cache.ts";

const key = "a".repeat(64);
const signal = new AbortController().signal;
async function temporary(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-quota-cache-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("cache shares success/failure cooldowns and keeps only stale quota on failure", async (t) => {
	const root = await temporary(t);
	let time = 1000;
	let calls = 0;
	let fail = false;
	const options = { root, key, signal, now: () => time, query: async () => {
		calls++;
		if (fail) throw new Error("sensitive backend diagnostic");
		return { remainingPercent: 82 };
	} };
	assert.equal((await getSharedQuota(options))?.quota?.remainingPercent, 82);
	await getSharedQuota(options);
	assert.equal(calls, 1);
	time += REFRESH_MS;
	fail = true;
	const failed = await getSharedQuota(options);
	assert.equal(failed?.state, "error");
	assert.equal(failed?.quota?.remainingPercent, 82);
	await getSharedQuota(options);
	assert.equal(calls, 2);
	assert.equal((await readFile(join(root, `${key}.json`), "utf8")).includes("sensitive"), false);
	assert.equal((await stat(join(root, `${key}.json`))).mode & 0o777, 0o600);
	time += REFRESH_MS;
	const noWindow = await getSharedQuota({ ...options, query: async () => undefined });
	assert.equal(noWindow?.state, "ok");
	assert.equal(noWindow?.quota, undefined);
});

test("different identities and agent roots have independent caches", async (t) => {
	const root = await temporary(t);
	let calls = 0;
	const options = { root, key, signal, query: async () => { calls++; return { remainingPercent: 20 }; } };
	await getSharedQuota(options);
	await getSharedQuota({ ...options, key: "b".repeat(64) });
	await getSharedQuota({ ...options, root: join(root, "another-agent") });
	assert.equal(calls, 3);
});

test("concurrent callers publish one pending attempt before making a query", async (t) => {
	const root = await temporary(t);
	let calls = 0;
	const options = { root, key, signal, query: async () => {
		calls++;
		assert.equal(JSON.parse(await readFile(join(root, `${key}.json`), "utf8")).state, "pending");
		await new Promise((resolve) => setTimeout(resolve, 30));
		return { remainingPercent: 30 };
	} };
	await Promise.all(Array.from({ length: 20 }, () => getSharedQuota(options)));
	assert.equal(calls, 1);
	assert.equal((await getSharedQuota(options))?.state, "ok");
	assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".lock") || name.startsWith(".claim-")), []);
});

test("corrupt cache recovers; aborted callers do not query; keys cannot escape the cache", async (t) => {
	const root = await temporary(t);
	await writeFile(join(root, `${key}.json`), "{invalid");
	let calls = 0;
	const options = { root, key, signal, query: async () => { calls++; return { remainingPercent: 10 }; } };
	const aborted = AbortSignal.abort();
	assert.equal(await getSharedQuota({ ...options, signal: aborted }), undefined);
	assert.equal(calls, 0);
	await getSharedQuota(options);
	assert.equal(calls, 1);
	await assert.rejects(getSharedQuota({ ...options, key: "../escape" }), /Invalid/);
});

test("separate Node processes share one quota request", async (t) => {
	const root = await temporary(t);
	const moduleUrl = new URL("./cache.ts", import.meta.url).href;
	const source = `
		import { getSharedQuota } from ${JSON.stringify(moduleUrl)};
		import { appendFile } from 'node:fs/promises';
		await getSharedQuota({ root: process.argv[1], key: '${key}', signal: new AbortController().signal,
			query: async () => {
				await appendFile(process.argv[1] + '/calls', 'request\\n');
				await new Promise(resolve => setTimeout(resolve, 80));
				return { remainingPercent: 40 };
			}
		});`;
	await Promise.all(Array.from({ length: 8 }, async () => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", source, root], { stdio: ["ignore", "ignore", "pipe"] });
		let errors = "";
		child.stderr.on("data", (data) => { errors += data; });
		const [code] = await once(child, "close");
		assert.equal(code, 0, errors);
	}));
	assert.equal(await readFile(join(root, "calls"), "utf8"), "request\n");
});

test("a killed owner leaves a shared cooldown and its lock is recovered after expiry", async (t) => {
	const root = await temporary(t);
	const moduleUrl = new URL("./cache.ts", import.meta.url).href;
	const source = `
		import { getSharedQuota } from ${JSON.stringify(moduleUrl)};
		await getSharedQuota({ root: process.argv[1], key: '${key}', now: () => 1000,
			signal: new AbortController().signal, query: async () => {
				console.log('started');
				await new Promise(resolve => setTimeout(resolve, 60000));
				return { remainingPercent: 90 };
			}
		});`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", source, root], { stdio: ["ignore", "pipe", "pipe"] });
	t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
	await once(child.stdout, "data");
	const closed = once(child, "close");
	child.kill("SIGKILL");
	await closed;
	let time = 1100;
	let calls = 0;
	const options = { root, key, signal, now: () => time, query: async () => {
		calls++; await appendFile(join(root, "recovered"), "ok"); return { remainingPercent: 80 };
	} };
	assert.equal((await getSharedQuota(options))?.state, "pending");
	assert.equal(calls, 0);
	time = 1000 + REFRESH_MS;
	await getSharedQuota(options); // Reap only the dead owner's marker.
	assert.equal((await getSharedQuota(options))?.state, "ok");
	assert.equal(calls, 1);
});
