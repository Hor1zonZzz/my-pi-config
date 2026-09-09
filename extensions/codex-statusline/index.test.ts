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
	codexStatusline({ on: (name: string, handler: (event: any, ctx: any) => void) => handlers.set(name, handler) } as unknown as ExtensionAPI);
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
	h.emit("agent_start");
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
