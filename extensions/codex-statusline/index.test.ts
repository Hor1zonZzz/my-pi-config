import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codexStatusline, { formatStatus } from "./index.ts";
import { REFRESH_MS } from "./cache.ts";

function token(account: string): string {
	return `header.${Buffer.from(JSON.stringify({
		email: `${account}@example.com`,
		"https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_user_id: `user-${account}` },
	})).toString("base64url")}.signature`;
}
const response = (used: number) => Response.json({ rate_limit: {
	secondary_window: { used_percent: used, limit_window_seconds: 604800 },
} });

async function fixture(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-statusline-test-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	});
	return root;
}

function harness(t: TestContext) {
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const statuses = new Map<string, string>([["codex-fast", "⚡ fast"]]);
	let access = token("first");
	const ctx = {
		mode: "tui",
		model: { provider: "openai-codex", id: "gpt-5.6-sol", baseUrl: "https://chatgpt.com/backend-api" },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: access }) },
		ui: { setStatus: (key: string, value: string | undefined) => {
			if (value === undefined) statuses.delete(key);
			else statuses.set(key, value);
		} },
	};
	codexStatusline({
		on: (name: string, handler: (event: any, ctx: any) => void) => handlers.set(name, handler),
		events: { on: (name: string, handler: () => void) => {
			handlers.set(name, handler);
			return () => { handlers.delete(name); };
		} },
	} as unknown as ExtensionAPI);
	const emit = (name: string) => handlers.get(name)?.({}, ctx);
	t.after(() => { emit("session_shutdown"); });
	return { ctx, emit, statuses, setAccount: (account: string) => { access = token(account); },
		get status() { return statuses.get("codex-quota"); } };
}

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!await predicate()) {
		if (Date.now() > deadline) throw new Error("Statusline test timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("factory/non-Codex/non-TUI do not query; Codex displays full account and shares cache", async (t) => {
	const root = await fixture(t);
	let requests = 0;
	t.mock.method(globalThis, "fetch", async () => { requests++; return response(18); });
	const a = harness(t);
	assert.equal(requests, 0);
	a.ctx.mode = "json";
	a.emit("session_start");
	assert.equal(a.status, undefined);
	a.ctx.mode = "tui";
	a.ctx.model.provider = "anthropic";
	a.emit("model_select");
	assert.equal(a.status, undefined);
	a.ctx.model.provider = "openai-codex";
	a.emit("model_select");
	await until(() => a.status === "first@example.com · weekly 82% left");
	assert.equal(a.statuses.get("codex-fast"), "⚡ fast");
	const b = harness(t);
	b.emit("session_start");
	await until(() => b.status === a.status);
	a.emit("agent_settled");
	b.emit("agent_start");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(requests, 1);
	const files = await readdir(join(root, "cache", "codex-statusline"));
	const data = await readFile(join(root, "cache", "codex-statusline", files.find((name) => name.endsWith(".json"))!), "utf8");
	assert.equal(data.includes("example.com"), false);
	assert.equal(data.includes(token("first")), false);
	a.ctx.model.provider = "anthropic";
	a.emit("model_select");
	assert.equal(a.status, undefined);
	assert.equal(a.statuses.get("codex-fast"), "⚡ fast");
});

test("account change aborts old request and its late result cannot overwrite the new status", async (t) => {
	const root = await fixture(t);
	let finishOld: (() => void) | undefined;
	let oldSignal: AbortSignal | undefined;
	t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
		if (new Headers(init.headers).get("chatgpt-account-id") === "first") {
			oldSignal = init.signal!;
			return new Promise<Response>((resolve) => { finishOld = () => resolve(response(1)); });
		}
		return response(60);
	});
	const h = harness(t);
	h.emit("session_start");
	await until(() => !!finishOld);
	h.setAccount("second");
	h.emit("codex-accounts:changed");
	await until(() => h.status === "second@example.com · weekly 40% left");
	assert.equal(oldSignal?.aborted, true);
	finishOld!();
	await until(async () => !(await readdir(join(root, "cache", "codex-statusline"))).some((name) => name.endsWith(".lock")));
	assert.equal(h.status, "second@example.com · weekly 40% left");
});

test("shutdown cancels quota work and never restores an old footer", async (t) => {
	const root = await fixture(t);
	let finish: (() => void) | undefined;
	let signal: AbortSignal | undefined;
	t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
		signal = init.signal!;
		return new Promise<Response>((resolve) => { finish = () => resolve(response(20)); });
	});
	const h = harness(t);
	h.emit("session_start");
	await until(() => !!finish);
	h.emit("session_shutdown");
	assert.equal(signal?.aborted, true);
	assert.equal(h.status, undefined);
	finish!();
	await until(async () => !(await readdir(join(root, "cache", "codex-statusline"))).some((name) => name.endsWith(".lock")));
	assert.equal(h.status, undefined);
});

test("late auth resolution after switching away does not issue a quota request", async (t) => {
	await fixture(t);
	let requests = 0;
	t.mock.method(globalThis, "fetch", async () => { requests++; return response(0); });
	const h = harness(t);
	let finishAuth: (() => void) | undefined;
	h.ctx.modelRegistry.getApiKeyAndHeaders = () => new Promise((resolve) => {
		finishAuth = () => resolve({ ok: true, apiKey: token("first") });
	});
	h.emit("session_start");
	h.ctx.model.provider = "anthropic";
	h.emit("model_select");
	finishAuth!();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(requests, 0);
	assert.equal(h.status, undefined);
});

test("failed queries show unavailable, share cooldown, and unsupported endpoints never query", async (t) => {
	await fixture(t);
	let requests = 0;
	t.mock.method(globalThis, "fetch", async () => { requests++; return new Response("private diagnostic", { status: 401 }); });
	const h = harness(t);
	h.ctx.model.baseUrl = "https://proxy.test/backend-api";
	h.emit("session_start");
	await until(() => h.status === "Codex · weekly unavailable");
	assert.equal(requests, 0);
	h.ctx.model.baseUrl = "https://chatgpt.com/backend-api";
	h.emit("model_select");
	await until(() => h.status === "first@example.com · weekly unavailable");
	h.emit("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(requests, 1);
	assert.equal(h.status?.includes("private"), false);
});

test("status never pretends missing data is 0 or 100 percent, and marks expired/reset data stale", () => {
	const base = { version: 1 as const, attemptedAt: 1000, nextCheckAt: 1000 + REFRESH_MS, state: "ok" as const };
	assert.equal(formatStatus("account", undefined, 2000), "account · weekly loading");
	assert.equal(formatStatus("account", base, 2000), "account · weekly unavailable");
	const cached = { ...base, quota: { remainingPercent: 0 } };
	assert.equal(formatStatus("account", cached, 2000), "account · weekly 0% left");
	assert.match(formatStatus("account", cached, base.nextCheckAt), /\(stale\)$/);
	assert.match(formatStatus("account", { ...cached, state: "error" }, 2000), /\(stale\)$/);
	assert.match(formatStatus("account", { ...cached, quota: { remainingPercent: 82, resetAt: 1500 } }, 2000), /\(stale\)$/);
	assert.equal(formatStatus("account", { ...base, state: "pending" }, 20000), "account · weekly unavailable");
});

function chatgptToken(sub: string): string {
	return `h.${Buffer.from(JSON.stringify({ sub, client_id: "client-1", scope: "chatgpt.tokens.use.direct" })).toString("base64url")}.s`;
}

function chatgptHarness(t: TestContext, options: { codexAccount?: string; apiKey?: string } = {}) {
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const statuses = new Map<string, string>();
	let openaiKey = options.apiKey ?? chatgptToken("alice");
	const codexModel = { provider: "openai-codex", id: "gpt-6.1-sol", baseUrl: "https://chatgpt.com/backend-api" };
	const ctx = {
		mode: "tui",
		model: { provider: "openai", id: "gpt-6.1-sol", baseUrl: "https://api.openai.com/v1" },
		modelRegistry: {
			getAvailable: () => options.codexAccount ? [ctx.model, codexModel] : [ctx.model],
			getApiKeyAndHeaders: async (model: { provider: string }) => model.provider === "openai-codex"
				? { ok: true, apiKey: token(options.codexAccount!) }
				: { ok: true, apiKey: openaiKey },
		},
		ui: { setStatus: (key: string, value: string | undefined) => {
			if (value === undefined) statuses.delete(key);
			else statuses.set(key, value);
		} },
	};
	codexStatusline({
		on: (name: string, handler: (event: any, ctx: any) => void) => handlers.set(name, handler),
		events: { on: (name: string, handler: () => void) => {
			handlers.set(name, handler);
			return () => { handlers.delete(name); };
		} },
	} as unknown as ExtensionAPI);
	const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
	t.after(() => { emit("session_shutdown"); });
	return { ctx, emit, statuses, setUser: (sub: string) => { openaiKey = chatgptToken(sub); },
		get status() { return statuses.get("codex-quota"); } };
}

/** `/v1/me` answers `<sub>@example.com`; the Codex usage endpoint answers `used` percent. */
function mockBackends(t: TestContext, used = 18) {
	const calls = { me: 0, usage: 0 };
	t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
		if (url === "https://api.openai.com/v1/me") {
			calls.me++;
			const bearer = new Headers(init.headers).get("authorization")!.slice("Bearer ".length);
			const sub = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString("utf8")).sub;
			return Response.json({ id: `user-${sub}`, email: `${sub}@example.com` });
		}
		calls.usage++;
		return response(used);
	});
	return calls;
}

test("openai ChatGPT login shows its account and borrows the matching Codex weekly quota through the shared cache", async (t) => {
	const root = await fixture(t);
	const calls = mockBackends(t);
	const h = chatgptHarness(t, { codexAccount: "alice" });
	h.emit("session_start");
	await until(() => h.status === "alice@example.com · plan weekly 82% left (via Codex)");
	// A Codex session for the same account reuses the cached quota instead of querying again.
	const codex = harness(t);
	codex.setAccount("alice");
	codex.emit("session_start");
	await until(() => codex.status === "alice@example.com · weekly 82% left");
	h.emit("agent_settled");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.deepEqual(calls, { me: 1, usage: 1 });
	for (const name of await readdir(join(root, "cache", "codex-statusline"))) {
		const data = await readFile(join(root, "cache", "codex-statusline", name), "utf8").catch(() => "");
		assert.equal(data.includes("example.com"), false);
	}
});

test("a Codex login for a different email is never borrowed; without one only the account shows", async (t) => {
	await fixture(t);
	const calls = mockBackends(t);
	const other = chatgptHarness(t, { codexAccount: "bob" });
	other.emit("session_start");
	await until(() => other.status === "alice@example.com");
	const none = chatgptHarness(t);
	none.emit("session_start");
	await until(() => none.status === "alice@example.com");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(calls.usage, 0);
});

test("API keys and non-TUI sessions do not query or show a ChatGPT status", async (t) => {
	await fixture(t);
	const calls = mockBackends(t);
	const key = chatgptHarness(t, { apiKey: "sk-proj-123" });
	key.emit("session_start");
	const json = chatgptHarness(t);
	json.ctx.mode = "json";
	json.emit("session_start");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(key.status, undefined);
	assert.equal(json.status, undefined);
	assert.deepEqual(calls, { me: 0, usage: 0 });
});

test("a usage-limit error shows the server's reset time until a request succeeds again", async (t) => {
	await fixture(t);
	mockBackends(t);
	const h = chatgptHarness(t, { codexAccount: "alice" });
	h.emit("session_start");
	await until(() => h.status?.includes("plan weekly") === true);
	const resetAt = Date.now() + 2 * 60 * 60 * 1000;
	const errorMessage = `OpenAI API error (429): {"error":{"code":"subscription_sharing_usage_limit_exceeded","resets_at":${Math.floor(resetAt / 1000)}}}`;
	h.emit("message_end", { message: { role: "assistant", provider: "openai-codex", stopReason: "error", errorMessage } });
	assert.equal(h.status?.includes("limit reached"), false);
	h.emit("message_end", { message: { role: "assistant", provider: "openai", stopReason: "error", errorMessage: "OpenAI API error (500): boom" } });
	assert.equal(h.status?.includes("limit reached"), false);
	h.emit("message_end", { message: { role: "assistant", provider: "openai", stopReason: "error", errorMessage } });
	assert.match(h.status!, /^alice@example\.com · limit reached · resets \d{2}:\d{2}$/);
	h.emit("after_provider_response", { status: 200, headers: {} });
	assert.equal(h.status, "alice@example.com · plan weekly 82% left (via Codex)");
});

test("switching the openai account drops the old email and its late /v1/me result", async (t) => {
	await fixture(t);
	let finishAlice: (() => void) | undefined;
	t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
		const bearer = new Headers(init.headers).get("authorization")!.slice("Bearer ".length);
		const sub = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString("utf8")).sub;
		if (sub === "alice") {
			return new Promise<Response>((resolve) => { finishAlice = () => resolve(Response.json({ email: "alice@example.com" })); });
		}
		return Response.json({ email: `${sub}@example.com` });
	});
	const h = chatgptHarness(t);
	h.emit("session_start");
	await until(() => !!finishAlice);
	h.setUser("carol");
	h.emit("codex-accounts:changed");
	await until(() => h.status === "carol@example.com");
	finishAlice!();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(h.status, "carol@example.com");
	h.emit("session_shutdown");
	assert.equal(h.status, undefined);
});
