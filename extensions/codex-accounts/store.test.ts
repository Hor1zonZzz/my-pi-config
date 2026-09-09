import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { AccountStore } from "./store.ts";
import { accountFromToken } from "../codex-statusline/quota.ts";

function token(id: string): string {
	return `header.${Buffer.from(JSON.stringify({ email: `${id}@example.test`, "https://api.openai.com/auth": {
		chatgpt_account_id: id, chatgpt_user_id: "user",
	} })).toString("base64url")}.signature`;
}
const login = (id: string, expires = Date.now() + 3_600_000): OAuthCredential => ({ type: "oauth", access: token(id), refresh: `refresh-${id}`, expires });
const key = (id: string) => accountFromToken(token(id))!.key;
const signal = new AbortController().signal;
const oauth: OAuthAuth = {
	name: "Synthetic Codex", login: async () => login("B"),
	refresh: async (old) => ({ ...old, refresh: `${old.refresh}-rotated`, expires: Date.now() + 3_600_000 }),
	toAuth: async (value) => ({ apiKey: value.access }),
};
async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pi-accounts-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "auth.json"), JSON.stringify({ "openai-codex": login("A"), other: { type: "api_key", key: "synthetic-other" } }));
	return { root, store: new AccountStore(root, oauth), readAuth: async () => JSON.parse(await readFile(join(root, "auth.json"), "utf8")),
		readVault: async () => JSON.parse(await readFile(join(root, "codex-accounts.json"), "utf8")) };
}

test("import, add, global switch and switch back retain provider/other credentials and real expiry", async (t) => {
	const f = await fixture(t);
	await f.store.importCurrent(key("A"), signal);
	await f.store.add(login("B"), signal);
	assert.equal((await f.readAuth())["openai-codex"].access, token("A"));
	assert.equal((await f.store.list()).accounts.length, 2);
	await f.store.switchTo(key("B"), key("A"), signal);
	assert.equal((await f.readAuth())["openai-codex"].access, token("B"));
	assert.ok((await f.readAuth())["openai-codex"].expires > Date.now());
	assert.deepEqual((await f.readAuth()).other, { type: "api_key", key: "synthetic-other" });
	await f.store.switchTo(key("A"), key("B"), signal);
	assert.equal((await f.readAuth())["openai-codex"].access, token("A"));
	assert.equal((await stat(join(f.root, "codex-accounts.json"))).mode & 0o777, 0o600);
	assert.equal((await stat(join(f.root, "auth.json"))).mode & 0o777, 0o600);
});

test("same-account switch never restores a stale snapshot, and concurrent selection is detected", async (t) => {
	const f = await fixture(t);
	await f.store.importCurrent(key("A"), signal);
	const auth = await f.readAuth();
	auth["openai-codex"].refresh = "latest-native-refresh";
	await writeFile(join(f.root, "auth.json"), JSON.stringify(auth));
	assert.equal(await f.store.switchTo(key("A"), key("A"), signal), false);
	assert.equal((await f.readAuth())["openai-codex"].refresh, "latest-native-refresh");
	await f.store.add(login("B"), signal);
	await f.store.switchTo(key("B"), key("A"), signal);
	assert.equal((await f.readVault()).accounts[key("A")].credential.refresh, "latest-native-refresh");
	await assert.rejects(f.store.switchTo(key("A"), key("A"), signal), /Another process/);
});

test("expired saved credentials refresh before commit; failure leaves active login untouched", async (t) => {
	const f = await fixture(t);
	await f.store.add(login("B"), signal);
	const vault = await f.readVault();
	vault.accounts[key("B")].credential.expires = 0;
	await writeFile(join(f.root, "codex-accounts.json"), JSON.stringify(vault));
	const before = await readFile(join(f.root, "auth.json"), "utf8");
	const failing = new AccountStore(f.root, { ...oauth, refresh: async () => { throw new Error("secret diagnostic"); } });
	await assert.rejects(failing.switchTo(key("B"), key("A"), signal), /refresh failed/);
	assert.equal(await readFile(join(f.root, "auth.json"), "utf8"), before);
	await f.store.switchTo(key("B"), key("A"), signal);
	assert.equal((await f.readAuth())["openai-codex"].refresh, "refresh-B-rotated");
});

test("cancelled switch preserves a just-rotated snapshot but never changes the active login", async (t) => {
	const f = await fixture(t);
	await f.store.add(login("B"), signal);
	const vault = await f.readVault();
	vault.accounts[key("B")].credential.expires = 0;
	await writeFile(join(f.root, "codex-accounts.json"), JSON.stringify(vault));
	const controller = new AbortController();
	const store = new AccountStore(f.root, { ...oauth, refresh: async (value) => {
		controller.abort();
		return { ...value, refresh: "new-rotated-grant", expires: Date.now() + 3600000 };
	} });
	await assert.rejects(store.switchTo(key("B"), key("A"), controller.signal));
	assert.equal((await f.readAuth())["openai-codex"].access, token("A"));
	assert.equal((await f.readVault()).accounts[key("B")].credential.refresh, "new-rotated-grant");
});

test("corrupt files are never treated as empty stores or overwritten", async (t) => {
	const f = await fixture(t);
	await f.store.add(login("B"), signal);
	await writeFile(join(f.root, "auth.json"), "{broken");
	await assert.rejects(f.store.switchTo(key("B"), undefined, signal), /safely/);
	assert.equal(await readFile(join(f.root, "auth.json"), "utf8"), "{broken");
	await writeFile(join(f.root, "auth.json"), "{}");
	await writeFile(join(f.root, "codex-accounts.json"), "{broken");
	await assert.rejects(f.store.add(login("B"), signal), /safely/);
	assert.equal(await readFile(join(f.root, "codex-accounts.json"), "utf8"), "{broken");
});

test("switch uses the SAME lock as real Pi OAuth refresh and snapshots its latest rotated grant", async (t) => {
	const f = await fixture(t);
	await f.store.add(login("B"), signal);
	const auth = await f.readAuth();
	auth["openai-codex"].expires = 0;
	await writeFile(join(f.root, "auth.json"), JSON.stringify(auth));
	const runtime = await ModelRuntime.create({ authPath: join(f.root, "auth.json"), modelsPath: null,
		modelsStorePath: join(f.root, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
	let entered!: () => void;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	runtime.registerNativeProvider({ ...openaiCodexProvider(), auth: { oauth: { ...oauth,
		refresh: async (value) => {
			entered();
			await new Promise((resolve) => setTimeout(resolve, 100));
			return { ...value, refresh: "native-rotated-A", expires: Date.now() + 3600000 };
		},
	} } });
	const refreshing = runtime.getAuth("openai-codex");
	await started;
	await f.store.switchTo(key("B"), key("A"), signal);
	await refreshing;
	assert.equal((await f.readVault()).accounts[key("A")].credential.refresh, "native-rotated-A");
	assert.equal((await f.readAuth())["openai-codex"].access, token("B"));
	// The already-created runtime re-reads the atomic replacement, no expires:0/reload hack.
	assert.equal((await runtime.getAuth("openai-codex"))?.auth.apiKey, token("B"));
});

test("another already-running Pi auth runtime observes the global switch without reload", async (t) => {
	const f = await fixture(t);
	await f.store.add(login("B"), signal);
	const source = `
		import { ModelRuntime } from '@earendil-works/pi-coding-agent';
		import { createInterface } from 'node:readline';
		const runtime = await ModelRuntime.create({ authPath: process.argv[1] + '/auth.json',
			modelsPath: null, modelsStorePath: process.argv[1] + '/child-models.json', refreshOnCreate: false });
		async function report() {
			const auth = await runtime.getAuth('openai-codex');
			const payload = JSON.parse(Buffer.from(auth.auth.apiKey.split('.')[1], 'base64url'));
			console.log(payload['https://api.openai.com/auth'].chatgpt_account_id);
		}
		await report();
		for await (const line of createInterface({ input: process.stdin })) { await report(); }
	`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", source, f.root], {
		cwd: fileURLToPath(new URL(".", import.meta.url)), stdio: ["pipe", "pipe", "pipe"],
	});
	t.after(() => { child.kill(); });
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	assert.equal((await lines.next()).value, "A");
	await f.store.switchTo(key("B"), key("A"), signal);
	child.stdin.write("read\n");
	assert.equal((await lines.next()).value, "B");
	child.stdin.end();
});
