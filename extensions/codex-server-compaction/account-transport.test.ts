import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { createRequire } from "node:module";
import { getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
// The vendor tree has upstream .js specifiers for .ts sources. Match Pi's jiti
// loading rather than requiring a build or changing unrelated vendor imports.
const { createJiti } = createRequire(join(getPackageDir(), "package.json"))("jiti");
const { default: compaction } = await createJiti(import.meta.url).import("./index.ts") as typeof import("./index.ts");
import { buildRemoteCompactionDetails } from "./remote-compaction.ts";
import { accountFromToken } from "../codex-statusline/quota.ts";

const token = (id: string) => `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": {
	chatgpt_account_id: id, chatgpt_user_id: id,
} })).toString("base64url")}.signature`;
const model: Model<"openai-codex-responses"> = {
	provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4", name: "GPT-5.4",
	baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text"],
	contextWindow: 272000, maxTokens: 32000, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};

test("real transport replay follows bound request auth, never a later global auth lookup", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-account-transport-"));
	const previous = process.env.CODEX_HOME;
	process.env.CODEX_HOME = root;
	t.after(async () => {
		if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
		await rm(root, { recursive: true, force: true });
	});
	const keyA = accountFromToken(token("A"))!.key;
	const keyB = accountFromToken(token("B"))!.key;
	const branch: any[] = [{ type: "compaction", id: "compaction-A", details: {
		remoteCompaction: buildRemoteCompactionDetails(model, [{ type: "compaction", encrypted_content: "owned-by-A" }], undefined, keyA),
	} }];
	const hooks = new Map<string, (event: any, ctx: any) => void>();
	let provider: any;
	let authLookups = 0;
	const ctx = { model, sessionManager: { getSessionId: () => "session", getBranch: () => branch },
		modelRegistry: { getApiKeyAndHeaders: async () => { authLookups++; return { ok: true, apiKey: token("B") }; } } };
	compaction({
		on: (name: string, callback: any) => hooks.set(name, callback),
		registerProvider: (id: string, value: any) => { assert.equal(id, "openai-codex"); provider = value; },
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", id: `entry-${branch.length}`, customType, data }),
	} as unknown as ExtensionAPI);
	hooks.get("session_start")!({}, ctx);
	t.after(() => { hooks.get("session_shutdown")!({}, ctx); });
	const bodies: any[] = [];
	const accounts: string[] = [];
	t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
		const headers = new Headers(init.headers);
		accounts.push(headers.get("chatgpt-account-id")!);
		const raw = headers.get("content-encoding") === "zstd"
			? zstdDecompressSync(init.body as Uint8Array).toString("utf8") : String(init.body);
		bodies.push(JSON.parse(raw));
		return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
			id: `response-${bodies.length}`, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0 },
		} })}\n\n`, { headers: { "content-type": "text/event-stream" } });
	});
	const request = async (id: string) => {
		const stream = provider.streamSimple(model, { messages: [] }, {
			apiKey: token(id), sessionId: "session", transport: "sse",
			onPayload: (body: any) => ({ ...body, service_tier: "priority", input: [
				{ type: "reasoning", encrypted_content: "possibly-foreign" },
				{ role: "user", content: "visible prompt" },
			] }),
		});
		const result = await stream.result();
		assert.notEqual(result.stopReason, "error", result.errorMessage);
	};
	await request("A");
	assert.equal(bodies[0].input[0].encrypted_content, "owned-by-A");
	assert.equal(authLookups, 0);
	branch.push({ type: "custom", id: "account-B", customType: "codex-account-context", data: { accountKey: keyB } });
	await request("B");
	assert.deepEqual(bodies[1].input, [{ role: "user", content: "visible prompt" }]);
	branch.push({ type: "message", id: "reply-B", message: { role: "assistant", provider: "openai-codex", api: model.api, model: model.id, content: [] } });
	await request("A");
	assert.deepEqual(bodies[2].input, [{ role: "user", content: "visible prompt" }]);
	assert.deepEqual(accounts, ["A", "B", "A"]);
	for (const body of bodies) {
		assert.equal(body.model, model.id);
		assert.equal(body.service_tier, "priority");
	}
});
