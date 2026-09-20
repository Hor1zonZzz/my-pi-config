// Pi 0.86.0 hands providers a normalized `TranscriptContext`: the system prompt and
// tool declarations live in the transcript's system messages, not in `context.systemPrompt`
// or `context.tools`. Reading the old fields silently produces a placeholder prompt and no
// tools, so this test compares the vendored Codex request body against the installed Pi
// provider's own body for the same transcript.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { stream as officialCodexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";

const { createJiti } = createRequire(join(getPackageDir(), "package.json"))("jiti");
const { buildRequestBody } = (await createJiti(import.meta.url).import(
	"./vendor/howaboua/providers/openai-codex/request-body.ts",
)) as typeof import("./vendor/howaboua/providers/openai-codex/request-body.ts");

// Unsigned JWT carrying only the account id the Codex headers need. Not a credential.
const ACCOUNT_TOKEN =
	"eyJhbGciOiJub25lIn0." +
	"eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC0xMjMifX0.";

const model = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	provider: "openai-codex",
	api: "openai-codex-responses",
	reasoning: true,
	input: ["text"],
	baseUrl: "https://chatgpt.com/backend-api/codex",
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	contextWindow: 400_000,
	maxTokens: 128_000,
	thinkingLevelMap: {},
	compat: {},
} as unknown as Model<"openai-codex-responses">;

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant = (content: unknown[]) => ({
	role: "assistant",
	content,
	api: "openai-codex-responses",
	provider: "openai-codex",
	model: "gpt-5.6-sol",
	usage,
	stopReason: "stop",
	timestamp: 2,
});

const declaredTool = (name: string) => ({
	name,
	description: `${name} tool`,
	parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
});

const scenarios: Array<{ name: string; context: unknown; options: Record<string, unknown> }> = [
	{
		name: "prompt and tools come from the leading system message",
		options: { sessionId: "session", reasoningEffort: "medium" },
		context: {
			systemPrompt: "PROMPT",
			tools: [declaredTool("read")],
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		},
	},
	{
		name: "tool call and tool result replay unchanged",
		options: { sessionId: "session", reasoningEffort: "high" },
		context: {
			systemPrompt: "PROMPT",
			tools: [declaredTool("read"), declaredTool("bash")],
			messages: [
				{ role: "user", content: "go", timestamp: 1 },
				assistant([
					{ type: "text", text: "calling" },
					{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { x: "a" } },
				]),
				{
					role: "toolResult",
					toolCallId: "call_1|fc_1",
					toolName: "read",
					content: [{ type: "text", text: "out" }],
					isError: false,
					timestamp: 3,
				},
			],
		},
	},
	{
		name: "a mid-conversation prompt patch and tool addition fold into the prompt",
		options: { sessionId: "session" },
		context: {
			systemPrompt: "PROMPT",
			tools: [declaredTool("read")],
			messages: [
				{ role: "user", content: "a", timestamp: 1 },
				assistant([{ type: "text", text: "b" }]),
				{
					role: "system",
					content: "",
					sections: { skills: "<skills/>" },
					toolsAdded: [declaredTool("write")],
					timestamp: 3,
				},
				{ role: "user", content: "c", timestamp: 4 },
			],
		},
	},
	{
		name: "a tool removal drops the tool from the request",
		options: { sessionId: "session", reasoningEffort: "low" },
		context: {
			systemPrompt: "PROMPT",
			tools: [declaredTool("read"), declaredTool("write")],
			messages: [
				{ role: "user", content: "a", timestamp: 1 },
				{ role: "system", content: "", toolsRemoved: [{ name: "write" }], timestamp: 2 },
				{ role: "user", content: "b", timestamp: 3 },
			],
		},
	},
	{
		name: "a session without a leading system message replays the later one",
		options: { sessionId: "session" },
		context: {
			messages: [
				{ role: "user", content: "a", timestamp: 1 },
				assistant([{ type: "text", text: "b" }]),
				{ role: "system", content: "LATE PROMPT", toolsAdded: [declaredTool("read")], timestamp: 3 },
				{ role: "user", content: "c", timestamp: 4 },
			],
		},
	},
	{
		name: "an omitted reasoning effort still sends the model's Off effort",
		options: { sessionId: "session" },
		context: {
			systemPrompt: "PROMPT",
			tools: [declaredTool("read")],
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		},
	},
];

/** Capture the body the installed Pi provider would send, then abort before any request. */
async function officialRequestBody(
	context: unknown,
	options: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
	let captured: Record<string, unknown> | undefined;
	const controller = new AbortController();
	const stream = officialCodexStream(model, context as never, {
		apiKey: ACCOUNT_TOKEN,
		signal: controller.signal,
		transport: "sse",
		...options,
		onPayload: async (payload: unknown) => {
			captured = payload as Record<string, unknown>;
			controller.abort();
			return undefined;
		},
	} as never);
	try {
		for await (const _event of stream) {
			// Drained only so the abort propagates; no request completes.
		}
	} catch {
		// The abort surfaces as a stream error.
	}
	return captured;
}

test("the Codex request body matches Pi's own provider for normalized transcripts", async () => {
	for (const scenario of scenarios) {
		const context = normalizeContext(scenario.context as never);
		const local = buildRequestBody(model, context, scenario.options as never) as unknown as Record<
			string,
			unknown
		>;
		const official = await officialRequestBody(context, scenario.options);
		assert.ok(official, `${scenario.name}: Pi's provider produced no payload`);
		for (const field of ["instructions", "tools", "input", "reasoning"]) {
			// Compare the serialized form: the payload is JSON, so an explicitly
			// undefined property and an omitted one are the same request.
			assert.equal(
				JSON.stringify(local[field] ?? null),
				JSON.stringify(official[field] ?? null),
				`${scenario.name}: ${field} diverges from Pi's provider`,
			);
		}
	}
});

test("the prompt and tools are never read from the retired context fields", async () => {
	const context = normalizeContext({
		systemPrompt: "PROMPT MARKER",
		tools: [declaredTool("read")],
		messages: [{ role: "user", content: "hi", timestamp: 1 }],
	} as never);
	// A provider still reading `context.systemPrompt`/`context.tools` sees neither field.
	assert.equal((context as unknown as { systemPrompt?: string }).systemPrompt, undefined);
	assert.equal((context as unknown as { tools?: unknown[] }).tools, undefined);

	const body = buildRequestBody(model, context, { sessionId: "session" } as never) as unknown as {
		instructions: string;
		tools?: Array<{ name: string }>;
	};
	assert.equal(body.instructions, "PROMPT MARKER");
	assert.deepEqual(body.tools?.map((tool) => tool.name), ["read"]);
});

test("reconstructed compaction history numbers messages like the provider", async () => {
	const { messagesToResponseItems } = (await createJiti(import.meta.url).import(
		"./remote-compaction.ts",
	)) as typeof import("./remote-compaction.ts");
	// A foreign assistant turn carries no text signature, so the fallback
	// `msg_pi_<n>` id is what both paths have to agree on.
	const messages = [
		{ role: "system", content: "PROMPT", toolsAdded: [], timestamp: 1 },
		{ role: "user", content: "hi", timestamp: 2 },
		{
			role: "assistant",
			content: [{ type: "text", text: "yo" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "other",
			usage,
			stopReason: "stop",
			timestamp: 3,
		},
	];
	const assistantIds = (items: Array<Record<string, unknown>>) =>
		items.filter((item) => item.type === "message" && item.role === "assistant").map((item) => item.id);

	const reconstructed = messagesToResponseItems(messages as never, model as never) as Array<
		Record<string, unknown>
	>;
	const sent = buildRequestBody(model, normalizeContext({ messages } as never), {
		sessionId: "session",
	} as never).input as unknown as Array<Record<string, unknown>>;

	assert.deepEqual(assistantIds(reconstructed), ["msg_pi_1"]);
	assert.deepEqual(assistantIds(reconstructed), assistantIds(sent));
});
