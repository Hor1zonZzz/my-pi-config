import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionSelectorComponent, initTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import codexAccounts from "./index.ts";
import { ACCOUNT_PROVIDERS, type AccountProvider } from "./providers.ts";

function chatgptLogin(name: string): OAuthCredential {
	return { type: "oauth", access: `opaque-${name}`, refresh: `synthetic-${name}`, expires: Date.now() + 3600000,
		clientId: `client-${name}`, scopes: ["openid", "chatgpt.tokens.use.direct"] };
}

function login(name: string): OAuthCredential {
	return { type: "oauth", refresh: `synthetic-${name}`, expires: Date.now() + 3600000,
		access: `header.${Buffer.from(JSON.stringify({ email: `${name}@example.test`, "https://api.openai.com/auth": { chatgpt_account_id: name } })).toString("base64url")}.signature` };
}
async function setup(t: TestContext, managedProvider: AccountProvider = "openai-codex") {
	const root = await mkdtemp(join(tmpdir(), "pi-accounts-ui-test-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	});
	await writeFile(join(root, "auth.json"), JSON.stringify({ "openai-codex": login("A"), openai: chatgptLogin("A") }));
	let command: Parameters<ExtensionAPI["registerCommand"]>[1];
	const events: string[] = [];
	const handlers = new Map<string, () => void>();
	const notifications: string[] = [];
	let choice: string | undefined;
	let confirmed = true;
	let idle = true;
	let loginCalls = 0;
	let providerChoice: AccountProvider | undefined = managedProvider;
	let label: string | undefined = "Work ChatGPT";
	const prompts: string[] = [];
	const confirmations: string[] = [];
	const refreshed: string[][] = [];
	let deviceDialog: ExtensionSelectorComponent | undefined;
	const dialogReady = Promise.withResolvers<void>();
	initTheme("dark", false);
	const oauth: OAuthAuth = { name: "synthetic", login: async () => { loginCalls++; return managedProvider === "openai" ? chatgptLogin("B") : login("B"); },
		refresh: async (value) => value, toAuth: async (value) => ({ apiKey: value.access }) };
	const ctx = {
		mode: "tui", cwd: root, model: { provider: managedProvider, id: "gpt-5.6-sol" }, isIdle: () => idle,
		modelRegistry: { getProvider: (id: string) => ({ baseUrl: id === "openai" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api", auth: { oauth } }),
			getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
			refresh: async (options: { providers: string[] }) => { events.push("refresh"); refreshed.push(options.providers); return { aborted: false, errors: new Map() }; } },
		ui: { notify: (message: string) => notifications.push(message),
			select: async (title: string, options: string[], opts?: { signal?: AbortSignal }) => {
				if (title === "Account login type") return providerChoice ? ACCOUNT_PROVIDERS[providerChoice].label : undefined;
				if (!options.includes("Cancel login")) return options.find((option) => option.includes(choice ?? "not-selected"));
				return new Promise<string | undefined>((resolve) => {
					const finish = (value?: string) => {
						opts?.signal?.removeEventListener("abort", onAbort);
						deviceDialog?.dispose();
						deviceDialog = undefined;
						resolve(value);
					};
					const onAbort = () => finish();
					deviceDialog = new ExtensionSelectorComponent(title, options, finish, onAbort);
					opts?.signal?.addEventListener("abort", onAbort, { once: true });
					if (opts?.signal?.aborted) onAbort();
					dialogReady.resolve();
				});
			},
			input: async (title: string) => { prompts.push(title); return label; },
			confirm: async (_title: string, message: string) => { confirmations.push(message); return confirmed; } },
	};
	codexAccounts({ on: (event: string, handler: () => void) => handlers.set(event, handler),
		registerCommand: (name: string, value: typeof command) => { assert.equal(name, "codex-accounts"); command = value; },
		events: { emit: (event: string) => events.push(event) },
	} as unknown as ExtensionAPI);
	return { root, events, notifications, ctx, oauth, handlers, prompts, confirmations, refreshed,
		dialogReady: dialogReady.promise, get deviceDialog() { return deviceDialog; },
		choose: (value: string | undefined) => { choice = value; },
		chooseProvider: (value: AccountProvider | undefined) => { providerChoice = value; },
		name: (value: string | undefined) => { label = value; },
		confirm: (value: boolean) => { confirmed = value; }, idle: (value: boolean) => { idle = value; },
		run: (args = "") => command.handler(args, ctx as unknown as ExtensionCommandContext),
		get loginCalls() { return loginCalls; } };
}

test("native menu imports, adds without replacing active login, then switches globally without reload/model changes", async (t) => {
	const h = await setup(t);
	h.choose("Import current"); await h.run();
	h.choose("Add account"); await h.run();
	assert.equal(h.loginCalls, 1);
	assert.equal(JSON.parse(await readFile(join(h.root, "auth.json"), "utf8"))["openai-codex"].access, login("A").access);
	h.choose("B@example.test"); await h.run();
	assert.equal(JSON.parse(await readFile(join(h.root, "auth.json"), "utf8"))["openai-codex"].access, login("B").access);
	assert.deepEqual(h.events, ["codex-accounts:changed", "refresh"]);
});

test("cancel, busy, non-TUI and invalid arguments never mutate auth", async (t) => {
	const h = await setup(t);
	const before = await readFile(join(h.root, "auth.json"), "utf8");
	await h.run();
	h.choose("Import current"); h.confirm(false); await h.run();
	h.idle(false); h.choose("Add account"); await h.run();
	h.idle(true); h.ctx.mode = "json"; await h.run();
	h.ctx.mode = "tui"; await h.run("unexpected");
	assert.equal(h.loginCalls, 0);
	assert.equal(await readFile(join(h.root, "auth.json"), "utf8"), before);
});

test("shutdown during OAuth discards late login and never changes global auth", async (t) => {
	const h = await setup(t);
	const before = await readFile(join(h.root, "auth.json"), "utf8");
	let finish!: () => void;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	h.oauth.login = async () => { started(); await new Promise<void>((resolve) => { finish = resolve; }); return login("B"); };
	h.choose("Add account");
	const pending = h.run();
	await ready;
	h.handlers.get("session_shutdown")!();
	finish(); await pending;
	assert.equal(await readFile(join(h.root, "auth.json"), "utf8"), before);
	assert.deepEqual(h.events, []);
});

const deviceCode = { type: "device_code" as const, verificationUri: "https://example.test/device", userCode: "TEST-CODE" };

for (const [name, key] of [["Esc", "\u001b"], ["Cancel login", "\r"]]) {
	test(`device login ${name} aborts polling, saves nothing, and releases the menu`, { timeout: 5000 }, async (t) => {
		const h = await setup(t);
		const before = await readFile(join(h.root, "auth.json"), "utf8");
		let pollSignal: AbortSignal | undefined;
		h.oauth.login = async (interaction) => {
			pollSignal = interaction.signal;
			interaction.notify(deviceCode);
			return new Promise((_resolve, reject) => {
				interaction.signal.addEventListener("abort", () => reject(interaction.signal.reason), { once: true });
			});
		};
		h.choose("Add account");
		const pending = h.run();
		await h.dialogReady;
		const lines = h.deviceDialog!.render(32);
		assert.ok(lines.every((line) => visibleWidth(line) <= 32));
		assert.ok(lines.join("\n").includes("TEST-CODE"));
		h.deviceDialog!.handleInput(key);
		await pending;
		assert.equal(pollSignal?.aborted, true);
		assert.equal(h.deviceDialog, undefined);
		assert.equal(await readFile(join(h.root, "auth.json"), "utf8"), before);
		await assert.rejects(readFile(join(h.root, "codex-accounts.json")), { code: "ENOENT" });
		h.choose("Import current"); await h.run();
		assert.match(h.notifications.at(-1)!, /Current login saved/);
	});
}

for (const outcome of ["success", "failure", "shutdown"] as const) {
	test(`device login ${outcome} closes the waiting dialog`, { timeout: 5000 }, async (t) => {
		const h = await setup(t);
		const before = await readFile(join(h.root, "auth.json"), "utf8");
		const result = Promise.withResolvers<OAuthCredential>();
		let pollSignal: AbortSignal | undefined;
		h.oauth.login = async (interaction) => {
			pollSignal = interaction.signal;
			interaction.notify(deviceCode);
			return result.promise;
		};
		h.choose("Add account");
		const pending = h.run();
		await h.dialogReady;
		if (outcome === "shutdown") {
			h.handlers.get("session_shutdown")!();
			assert.equal(h.deviceDialog, undefined);
		}
		if (outcome === "failure") result.reject(new Error("Login failed"));
		else result.resolve(login("B"));
		await pending;
		assert.equal(h.deviceDialog, undefined);
		assert.equal(pollSignal?.aborted, outcome === "shutdown");
		assert.equal(await readFile(join(h.root, "auth.json"), "utf8"), before);
		if (outcome === "success") {
			assert.match(await readFile(join(h.root, "codex-accounts.json"), "utf8"), /synthetic-B/);
		} else {
			await assert.rejects(readFile(join(h.root, "codex-accounts.json")), { code: "ENOENT" });
		}
	});
}

test("ChatGPT menu imports and switches only openai; native login receives the stable Pi deviceId", async (t) => {
	const h = await setup(t, "openai");
	const originalModel = { ...h.ctx.model };
	h.name("Personal"); h.choose("Import current"); await h.run("openai");
	let deviceId: string | undefined;
	h.oauth.login = async (_interaction, options) => { deviceId = options?.getDeviceId?.(); return chatgptLogin("B"); };
	h.name("Work"); h.choose("Add account"); await h.run();
	assert.match(deviceId!, /^[0-9a-f-]{36}$/);
	assert.equal(JSON.parse(await readFile(join(h.root, "settings.json"), "utf8")).deviceId, deviceId);
	assert.equal(JSON.parse(await readFile(join(h.root, "auth.json"), "utf8")).openai.access, "opaque-A");
	h.choose("Work"); await h.run("openai");
	const auth = JSON.parse(await readFile(join(h.root, "auth.json"), "utf8"));
	assert.equal(auth.openai.access, "opaque-B");
	assert.equal(auth["openai-codex"].access, login("A").access);
	assert.deepEqual(h.ctx.model, originalModel);
	assert.deepEqual(h.events, ["openai-accounts:changed", "refresh"]);
	assert.deepEqual(h.refreshed, [["openai"]]);
	h.choose("Add account"); h.name("Another"); await h.run("openai");
	assert.equal(JSON.parse(await readFile(join(h.root, "settings.json"), "utf8")).deviceId, deviceId);
});

test("cancelling login-type selection or ChatGPT account naming saves no credentials", async (t) => {
	const h = await setup(t, "openai");
	const before = await readFile(join(h.root, "auth.json"), "utf8");
	h.chooseProvider(undefined); h.choose("Add account"); await h.run();
	assert.equal(h.loginCalls, 0);
	h.chooseProvider("openai"); h.name(undefined); await h.run();
	assert.equal(h.loginCalls, 1);
	assert.equal(await readFile(join(h.root, "auth.json"), "utf8"), before);
	await assert.rejects(readFile(join(h.root, "openai-accounts.json")), { code: "ENOENT" });
	h.choose("Import current"); await h.run("openai");
	await assert.rejects(readFile(join(h.root, "openai-accounts.json")), { code: "ENOENT" });
	assert.deepEqual(h.events, []);
});

test("ChatGPT API-key replacement requires confirmation; custom endpoints and runtime overrides are rejected", async (t) => {
	const h = await setup(t, "openai");
	h.choose("Add account"); await h.run("openai");
	const auth = JSON.parse(await readFile(join(h.root, "auth.json"), "utf8"));
	auth.openai = { type: "api_key", key: "synthetic-api-key" };
	await writeFile(join(h.root, "auth.json"), JSON.stringify(auth));
	h.choose("Work ChatGPT"); h.confirm(false); await h.run("openai");
	assert.match(h.confirmations.at(-1)!, /replaces the saved API key/);
	assert.equal(JSON.parse(await readFile(join(h.root, "auth.json"), "utf8")).openai.type, "api_key");
	h.confirm(true); await h.run("openai");
	assert.equal(JSON.parse(await readFile(join(h.root, "auth.json"), "utf8")).openai.type, "oauth");
	const before = await readFile(join(h.root, "auth.json"), "utf8");
	h.ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: true, source: "runtime" });
	h.choose("Add account"); await h.run("openai"); assert.equal(h.loginCalls, 1);
	h.ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: true, source: "stored" });
	h.ctx.modelRegistry.getProvider = () => ({ baseUrl: "https://proxy.example.test/v1", auth: { oauth: h.oauth } });
	await h.run("openai"); assert.equal(h.loginCalls, 1);
	assert.equal(await readFile(join(h.root, "auth.json"), "utf8"), before);
});
