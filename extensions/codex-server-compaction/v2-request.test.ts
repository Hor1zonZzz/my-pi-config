import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
const { createJiti } = createRequire(join(getPackageDir(), "package.json"))("jiti");
const jiti = createJiti(import.meta.url);
const { executeRemoteCompactionV2 } = await jiti.import("./vendor/howaboua/adapter/compaction/remote-v2-client.ts");
const { registerOpenAICodexCustomProvider, closeOpenAICodexWebSocketSessions } = await jiti.import("./vendor/howaboua/providers/openai-codex-custom-provider.ts");
const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.4", name: "GPT-5.4", provider: "openai-codex", api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text"],
	contextWindow: 272000, maxTokens: 32000, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;

test("production V2 path sends trigger/routing and validates outputs, failure, and cancellation", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-v2-request-test-"));
	const previous = process.env.CODEX_HOME;
	process.env.CODEX_HOME = root;
	t.after(async () => {
		closeOpenAICodexWebSocketSessions();
		if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
		await rm(root, { recursive: true, force: true });
	});
	let registration: any;
	registerOpenAICodexCustomProvider({ registerProvider: (_name: string, value: any) => { registration = value; } } as unknown as ExtensionAPI, {});
	let mode: "ok" | "none" | "two" | "incomplete" | "failed" | "cancel" = "ok";
	let tier: string | undefined = "priority";
	let sequence = 0;
	const controller = new AbortController();
	t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
		assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
		assert.equal(init.method, "POST");
		const headers = new Headers(init.headers);
		assert.equal(headers.get("chatgpt-account-id"), "test-account");
		assert.match(headers.get("x-codex-beta-features")!, /remote_compaction_v2/);
		assert.equal(headers.get("x-codex-routing-hint"), `model=gpt-5.4${tier ? `;tier=${tier}` : ""}`);
		const body = JSON.parse(headers.get("content-encoding") === "zstd"
			? zstdDecompressSync(init.body as Uint8Array).toString("utf8") : String(init.body));
		assert.deepEqual(body.input.at(-1), { type: "compaction_trigger" });
		assert.equal(body.service_tier, tier);
		assert.equal(body.store, false);
		assert.equal(body.stream, true);
		if (mode === "cancel") { controller.abort(); throw new Error("Request was aborted"); }
		const count = mode === "none" ? 0 : mode === "two" ? 2 : 1;
		const events: unknown[] = Array.from({ length: count }, (_, output_index) => ({
			type: "response.output_item.done", output_index, item: { type: "compaction", encrypted_content: "opaque" },
		}));
		if (mode === "failed") events.push({ type: "response.failed", response: { status: "failed", error: { code: "invalid_request", message: "invalid request" } } });
		else events.push({ type: mode === "incomplete" ? "response.incomplete" : "response.completed", response: {
			id: `resp-${sequence}`, status: mode === "incomplete" ? "incomplete" : "completed",
			incomplete_details: mode === "incomplete" ? { reason: "max_output_tokens" } : undefined,
			usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 },
		} });
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	});
	async function request() {
		return executeRemoteCompactionV2({
			runtime: { provider: model.provider, api: model.api, apiFamily: model.api, codexTransport: true,
				model: model.id, baseUrl: model.baseUrl, apiKey: token, currentModel: model },
			modelRegistry: { getRegisteredProviderConfig: () => registration },
			context: { messages: [], tools: [] }, promptInput: [{ role: "user", content: "visible history" }],
			promptInputSource: "reconstructed", requestOptions: { ...(tier ? { service_tier: tier } : {}) },
			tokensBefore: 20, sessionId: `v2-${++sequence}`, transport: "sse", signal: controller.signal,
		});
	}
	assert.equal((await request()).ok, true);
	tier = undefined;
	assert.equal((await request()).ok, true);
	for (const value of ["none", "two", "incomplete", "failed", "cancel"] as const) {
		mode = value;
		const result = await request();
		assert.equal(result.ok, false, value);
		if (value === "none" || value === "two") assert.equal(result.reason, "invalid-output");
		if (value === "cancel") assert.equal(result.reason, "aborted");
	}
});
