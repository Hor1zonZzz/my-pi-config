import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { getPackageDir, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { buildRemoteCompactionDetails, reconstructRemoteCompactionStateFromBranch } from "./remote-compaction.ts";
import { accountFromToken } from "../codex-statusline/quota.ts";

// Match Pi's loader for the vendor's .js specifiers pointing at TypeScript sources.
const { createJiti } = createRequire(join(getPackageDir(), "package.json"))("jiti");
const jiti = createJiti(import.meta.url);
const { default: compaction } = await jiti.import("./index.ts") as typeof import("./index.ts");
const { recordCanonicalSessionResponse, canonicalCompactionPromptInput } = await jiti.import(
	"./vendor/howaboua/providers/openai-codex/session-continuity.ts",
) as typeof import("./vendor/howaboua/providers/openai-codex/session-continuity.ts");
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.signature`;
const accountKey = accountFromToken(token)!.key;
const model = {
	id: "gpt-5.4", name: "GPT-5.4", provider: "openai-codex", api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text"],
	contextWindow: 272000, maxTokens: 32000, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
} as Model<"openai-codex-responses">;
const details = () => ({ remoteCompaction: buildRemoteCompactionDetails(model,
	[{ type: "compaction", encrypted_content: "old-artifact" }], undefined, accountKey) });
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
const replay = (manager: SessionManager) => reconstructRemoteCompactionStateFromBranch({
	branchEntries: manager.getBranch(), model, accountKey,
});

test("context edits invalidate native history across resume/tree, and a new checkpoint restores reuse", () => {
	for (const replacement of [null, { content: "NEW_MARKER" }]) {
		const manager = SessionManager.inMemory();
		const retained = manager.appendMessage(user("OLD_MARKER"));
		manager.appendCompaction("summary", retained, 10, details());
		const tail = manager.appendMessage(user("TAIL_MARKER"));
		assert.ok(replay(manager));
		// Both retained history already inside the artifact and later messages are unsafe.
		for (const target of [retained, tail]) {
			manager.branch(tail);
			manager.appendContextEdit(target, replacement);
			assert.equal(replay(manager), undefined);
			const restored = SessionManager.inMemory(process.cwd(), {}, [manager.getHeader()!, ...manager.getBranch()]);
			assert.equal(replay(restored), undefined);
			manager.appendCompaction("fresh summary", null, 5, details());
			assert.ok(replay(manager));
		}
		manager.branch(tail);
		assert.ok(replay(manager));
	}
});

test("ordinary requests and V2 use edited projection and discard canonical history before replay", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-context-edit-"));
	const previous = process.env.CODEX_HOME;
	process.env.CODEX_HOME = root;
	t.after(async () => {
		if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
		await rm(root, { recursive: true, force: true });
	});
	for (const replacement of [null, { content: "NEW_MARKER" }]) {
		for (const withCheckpoint of [false, true]) {
			for (const path of ["ordinary", "v2"]) {
				const manager = SessionManager.inMemory();
				if (withCheckpoint) manager.appendCompaction("summary", null, 10, details());
				manager.appendCustomEntry("codex-account-context", { accountKey });
				const target = manager.appendMessage(user("OLD_MARKER"));
				manager.appendMessage(user("KEEP_MARKER"));
				const hooks = new Map<string, any>();
				let provider: any;
				let input: unknown;
				const sessionId = manager.getSessionId();
				const ctx: any = { model, sessionManager: manager, getSystemPrompt: () => "prompt",
					modelRegistry: {
						getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }),
						getRegisteredProviderConfig: () => ({ api: model.api, streamSimple: async function* (_model: unknown, _context: unknown, options: any) {
							assert.equal(canonicalCompactionPromptInput(sessionId, model.id), undefined);
							input = (await options.onPayload({ model: model.id, input: [], instructions: "prompt" })).input;
							options.onOutputItemDone({ type: "compaction", encrypted_content: "fresh-artifact" });
							yield { type: "done", reason: "stop", message: { role: "assistant", content: [], stopReason: "stop", responseId: "fresh",
								usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } };
						} }),
					} };
				compaction({ on: (name: string, fn: any) => hooks.set(name, fn),
					registerProvider: (_name: string, value: any) => { provider = value; },
					appendEntry: (name: string, data: unknown) => manager.appendCustomEntry(name, data),
					getThinkingLevel: () => "off", getAllTools: () => [], getActiveTools: () => [],
				} as unknown as ExtensionAPI);
				hooks.get("session_start")({}, ctx);
				try {
					recordCanonicalSessionResponse({ sessionId, accountId: "test", url: "wss://chatgpt.com/backend-api/codex/responses",
						requestBody: { model: model.id, input: [{ role: "user", content: "OLD_MARKER" }] } as any, responseItems: [] });
					assert.ok(canonicalCompactionPromptInput(sessionId, model.id));
					manager.appendContextEdit(target, replacement);
					if (path === "ordinary") {
						hooks.get("context")({}, ctx);
						assert.equal(canonicalCompactionPromptInput(sessionId, model.id), undefined);
						const mock = t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
							assert.equal(canonicalCompactionPromptInput(sessionId, model.id), undefined);
							const headers = new Headers(init.headers);
							const body = JSON.parse(headers.get("content-encoding") === "zstd"
								? zstdDecompressSync(init.body as Uint8Array).toString("utf8") : String(init.body));
							assert.equal(body.previous_response_id, undefined);
							input = body.input;
							return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
								id: "fresh", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0 },
							} })}\n\n`, { headers: { "content-type": "text/event-stream" } });
						});
						try {
							const result = await provider.streamSimple(model, normalizeContext({ messages: manager.buildSessionProjection().messages as any }),
								{ apiKey: token, sessionId, transport: "sse" }).result();
							assert.notEqual(result.stopReason, "error", result.errorMessage);
							assert.ok(canonicalCompactionPromptInput(sessionId, model.id), "edited request seeds new canonical history");
							hooks.get("context")({}, ctx);
							assert.ok(canonicalCompactionPromptInput(sessionId, model.id), "unchanged edit does not clear the new lane");
						} finally { mock.mock.restore(); }
					} else {
						// Intentionally invalid local-summary preparation fails before network;
						// the real V2 client still exercises the extension's input construction.
						const result = await hooks.get("session_before_compact")({ branchEntries: manager.getBranch(),
							preparation: { firstKeptEntryId: target, tokensBefore: 10 }, signal: new AbortController().signal }, ctx);
						assert.ok(result.compaction.details.remoteCompaction);
					}
					const serialized = JSON.stringify(input);
					assert.doesNotMatch(serialized, /OLD_MARKER|old-artifact/);
					assert.match(serialized, /KEEP_MARKER/);
					if (replacement) assert.match(serialized, /NEW_MARKER/);
					else assert.doesNotMatch(serialized, /NEW_MARKER/);
				} finally { hooks.get("session_shutdown")({}, ctx); }
			}
		}
	}
});
