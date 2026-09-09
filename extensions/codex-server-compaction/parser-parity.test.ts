import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { processResponsesStream as official } from "@earendil-works/pi-ai/api/openai-responses-shared";

const { createJiti } = createRequire(join(getPackageDir(), "package.json"))("jiti");
const { processResponsesStream: local } = await createJiti(import.meta.url).import(
	"./vendor/howaboua/providers/openai-responses/stream.ts",
) as typeof import("./vendor/howaboua/providers/openai-responses/stream.ts");
const model = { id: "gpt-5.4", provider: "openai-codex", api: "openai-codex-responses",
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } as Model<"openai-codex-responses">;
const completed = { type: "response.completed", response: { id: "resp-1", status: "completed",
	usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } };

async function parse(events: unknown[], useOfficial: boolean) {
	const raw: unknown[] = [];
	const output = { role: "assistant", provider: model.provider, api: model.api, model: model.id,
		content: [], stopReason: "stop", timestamp: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	} as AssistantMessage;
	async function* source() {
		for (const value of events) {
			// Proposed minimal tap in front of Pi's public parser.
			const event = value as any;
			if (useOfficial && event.type === "response.output_item.done") raw.push(event.item);
			yield event;
		}
	}
	const stream = createAssistantMessageEventStream();
	const options = { onOutputItemDone: (item: unknown) => raw.push(item) };
	await (useOfficial ? official : local)(source(), output, stream, model, options);
	return { output, raw };
}

test("official parser plus a raw-item tap can preserve a V2 compaction output", async () => {
	const events = [{ type: "response.output_item.done", output_index: 0,
		item: { type: "compaction", encrypted_content: "opaque" } }, completed];
	const a = await parse(events, false), b = await parse(events, true);
	assert.deepEqual(b.raw, a.raw);
	assert.deepEqual(b.output.content, a.output.content);
	assert.equal(b.output.responseId, a.output.responseId);
});

test("replacement blocker: local raw callback reconstructs streamed custom tool input missing from done", async () => {
	const item = { type: "custom_tool_call", id: "tool-1", call_id: "call-1", name: "apply_patch" };
	const events = [
		{ type: "response.output_item.added", output_index: 0, item: { ...item, input: "" } },
		{ type: "response.custom_tool_call_input.delta", output_index: 0, item_id: "tool-1", delta: "patch contents" },
		{ type: "response.output_item.done", output_index: 0, item }, completed,
	];
	const a = await parse(events, false), b = await parse(events, true);
	assert.equal((a.raw[0] as any).input, "patch contents");
	assert.equal((b.raw[0] as any).input, undefined);
	// Raw history feeds cached continuation/V2, not just the visible assistant.
	assert.notDeepEqual(b.raw, a.raw);
});

test("replacement blocker: native web-search history is preserved locally but not by Pi's parser", async () => {
	const item = { type: "web_search_call", id: "search-1", status: "completed", action: { type: "search", query: "test" } };
	const events = [{ type: "response.output_item.done", output_index: 0, item }, completed];
	const a = await parse(events, false), b = await parse(events, true);
	assert.equal((a.output.content[0] as any)?.type, "web_search_call");
	assert.equal(b.output.content.length, 0);
});
