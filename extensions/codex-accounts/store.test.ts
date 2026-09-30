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
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { AccountStore } from "./store.ts";
import { accountFromToken } from "../codex-statusline/quota.ts";
import { accountForCredential } from "./providers.ts";

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
const directLogin = (id: string, expires = Date.now() + 3_600_000): OAuthCredential => ({
	type: "oauth", access: `opaque-${id}`, refresh: `refresh-${id}`, expires,
	clientId: `registered-${id}`, scopes: ["openid", "profile", "email", "chatgpt.tokens.use.direct"],
});
const directKey = (id: string) => accountForCredential("openai", directLogin(id))!.key;
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

test("ChatGPT opaque authorizations have an isolated vault and stable keys across token rotation", async (t) => {
	const f = await fixture(t);
	await f.store.importCurrent(key("A"), signal);
	const legacyVault = await readFile(join(f.root, "codex-accounts.json"), "utf8");
	const auth = await f.readAuth(); auth.openai = directLogin("A");
	await writeFile(join(f.root, "auth.json"), JSON.stringify(auth));
	const store = new AccountStore(f.root, oauth, "openai");
	await store.importCurrent(directKey("A"), signal, "Personal");
	await store.add(directLogin("B"), signal, "Work");
	assert.equal((await f.readAuth()).openai.access, "opaque-A");
	await store.switchTo(directKey("B"), directKey("A"), signal);
	assert.deepEqual((await f.readAuth()).openai, directLogin("B", (await f.readAuth()).openai.expires));
	assert.equal((await store.list()).current?.label, "Work");
	const latest = await f.readAuth(); latest.openai.access = "rotated-opaque-B"; latest.openai.refresh = "rotated-refresh-B";
	await writeFile(join(f.root, "auth.json"), JSON.stringify(latest));
	assert.equal(await store.switchTo(directKey("B"), directKey("B"), signal), false);
	assert.equal((await f.readAuth()).openai.refresh, "rotated-refresh-B");
	await store.switchTo(directKey("A"), directKey("B"), signal);
	const vault = JSON.parse(await readFile(join(f.root, "openai-accounts.json"), "utf8"));
	assert.equal(vault.accounts[directKey("B")].credential.access, "rotated-opaque-B");
	assert.equal(vault.accounts[directKey("B")].label, "Work");
	assert.equal((await f.readAuth())["openai-codex"].access, token("A"));
	assert.equal(await readFile(join(f.root, "codex-accounts.json"), "utf8"), legacyVault);
	assert.equal((await stat(join(f.root, "openai-accounts.json"))).mode & 0o777, 0o600);
	await assert.rejects(store.add(login("C"), signal), /invalid/);
	await assert.rejects(f.store.add(directLogin("C"), signal), /invalid/);
});

test("switching ChatGPT grants detects API-key changes and rejects corrupt or foreign grants", async (t) => {
	const f = await fixture(t);
	const auth = await f.readAuth(); auth.openai = { type: "api_key", key: "synthetic-key-1" };
	await writeFile(join(f.root, "auth.json"), JSON.stringify(auth));
	const store = new AccountStore(f.root, oauth, "openai");
	await store.add(directLogin("B"), signal, "Work");
	const list = await store.list(); assert.equal(list.replacesApiKey, true); assert.equal(list.current, undefined);
	auth.openai.key = "synthetic-key-2"; await writeFile(join(f.root, "auth.json"), JSON.stringify(auth));
	await assert.rejects(store.switchTo(directKey("B"), list.currentKey, signal), /Another process/);
	assert.equal((await f.readAuth()).openai.key, "synthetic-key-2");
	await store.switchTo(directKey("B"), (await store.list()).currentKey, signal);
	assert.equal((await f.readAuth()).openai.type, "oauth");
	const before = await readFile(join(f.root, "auth.json"), "utf8");
	await store.add(directLogin("C"), signal);
	const vaultPath = join(f.root, "openai-accounts.json");
	const vault = JSON.parse(await readFile(vaultPath, "utf8"));
	vault.accounts[directKey("C")].credential.expires = 0;
	await writeFile(vaultPath, JSON.stringify(vault));
	const foreignRefresh = new AccountStore(f.root, { ...oauth, refresh: async () => directLogin("D") }, "openai");
	await assert.rejects(foreignRefresh.switchTo(directKey("C"), directKey("B"), signal), /did not match/);
	assert.equal(await readFile(join(f.root, "auth.json"), "utf8"), before);
	await writeFile(vaultPath, "{broken");
	await assert.rejects(store.list(), /safely/);
	assert.equal(await readFile(vaultPath, "utf8"), "{broken");
	assert.equal(await readFile(join(f.root, "auth.json"), "utf8"), before);
});

test("Pi's actual ChatGPT OAuth login and refresh preserve issued clientId and direct-token scopes", async (t) => {
	const f = await fixture(t);
	const flow = openaiProvider().auth.oauth!;
	const originalFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	const calls: URLSearchParams[] = [];
	globalThis.fetch = async (url, options) => {
		assert.equal(String(url), "https://auth.openai.com/api/accounts/oauth/token");
		const body = new URLSearchParams(String(options?.body)); calls.push(body);
		assert.equal(body.get("resource"), "https://api.openai.com/v1");
		assert.equal(body.get("client_id"), "issued-test-client");
		return new Response(JSON.stringify({ access_token: `opaque-${calls.length}`, refresh_token: `refresh-${calls.length}`,
			expires_in: 3600, scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct", id_token: "synthetic-id-token" }));
	};
	let authUrl: URL | undefined;
	const granted = await flow.login({ signal, notify: (event) => { if (event.type === "auth_url") authUrl = new URL(event.url); },
		prompt: async () => {
			const callback = new URL("http://127.0.0.1:1455/auth/callback");
			callback.search = new URLSearchParams({ code: "synthetic-code", state: authUrl!.searchParams.get("state")!, client_id: "issued-test-client" }).toString();
			return callback.toString();
		},
	}, { getDeviceId: () => "00000000-0000-4000-8000-000000000001" });
	assert.equal(authUrl!.searchParams.get("ext_agent_host_id"), "urn:uuid:00000000-0000-4000-8000-000000000001");
	assert.equal(calls[0].get("grant_type"), "authorization_code");
	assert.equal(granted.clientId, "issued-test-client");
	assert.ok((granted.scopes as string[]).includes("chatgpt.tokens.use.direct"));
	const store = new AccountStore(f.root, flow, "openai");
	await store.add(granted, signal, "Native login");
	const identity = accountForCredential("openai", granted)!;
	const vaultPath = join(f.root, "openai-accounts.json");
	const vault = JSON.parse(await readFile(vaultPath, "utf8")); vault.accounts[identity.key].credential.expires = 0;
	await writeFile(vaultPath, JSON.stringify(vault));
	await store.switchTo(identity.key, undefined, signal);
	assert.equal(calls[1].get("grant_type"), "refresh_token");
	assert.equal(calls[1].get("refresh_token"), "refresh-1");
	assert.equal((await f.readAuth()).openai.access, "opaque-2");
	assert.equal((await f.readAuth()).openai.clientId, "issued-test-client");
	assert.deepEqual((await f.readAuth()).openai.scopes, granted.scopes);
});

test("ChatGPT global switch shares Pi's real auth lock and is observed by an existing runtime", async (t) => {
	const f = await fixture(t);
	const auth = await f.readAuth(); auth.openai = directLogin("A", 0);
	await writeFile(join(f.root, "auth.json"), JSON.stringify(auth));
	const store = new AccountStore(f.root, oauth, "openai"); await store.add(directLogin("B"), signal, "Work");
	const runtime = await ModelRuntime.create({ authPath: join(f.root, "auth.json"), modelsPath: null,
		modelsStorePath: join(f.root, "direct-models.json"), refreshOnCreate: false, allowModelNetwork: false });
	let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
	runtime.registerNativeProvider({ ...openaiProvider(), auth: { oauth: { ...oauth, refresh: async (value) => {
		entered(); await new Promise((resolve) => setTimeout(resolve, 100));
		return { ...value, access: "native-rotated-A", refresh: "native-refresh-A", expires: Date.now() + 3600000 };
	} } } });
	const refreshing = runtime.getAuth("openai"); await started;
	await store.switchTo(directKey("B"), directKey("A"), signal); await refreshing;
	const vault = JSON.parse(await readFile(join(f.root, "openai-accounts.json"), "utf8"));
	assert.equal(vault.accounts[directKey("A")].credential.refresh, "native-refresh-A");
	assert.equal((await runtime.getAuth("openai"))?.auth.apiKey, "opaque-B");
	assert.equal((await f.readAuth())["openai-codex"].access, token("A"));
});
