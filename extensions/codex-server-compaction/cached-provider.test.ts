import assert from "node:assert/strict";
import test from "node:test";
import { buildCachedWebSocketRequestBody } from "./vendor/howaboua/providers/openai-codex/websocket-continuation.ts";

const base = {
	model: "gpt-5.6-luna",
	store: false,
	stream: true,
	instructions: "system",
	input: [{ role: "user", content: [{ type: "input_text", text: "first" }] }],
	text: { verbosity: "low" },
	include: ["reasoning.encrypted_content"],
	prompt_cache_key: "session",
	tool_choice: "auto" as const,
	parallel_tool_calls: true,
	reasoning: { effort: "high", summary: "auto" },
};
const assistant = {
	type: "message",
	id: "msg_1",
	status: "completed",
	role: "assistant",
	content: [{ type: "output_text", text: "answer", annotations: [] }],
};

test("live V2 compaction sends only previous_response_id plus trigger", () => {
	const result = buildCachedWebSocketRequestBody(
		{ lastRequestBody: base, lastResponseId: "resp_1", lastResponseItems: [assistant] },
		{ ...base, input: [...base.input, assistant, { type: "compaction_trigger" }] },
	);
	assert.equal(result.decision, "delta");
	assert.equal(result.body.previous_response_id, "resp_1");
	assert.deepEqual(result.body.input, [{ type: "compaction_trigger" }]);
});

test("V2 compaction sends full history without a live continuation", () => {
	const body = { ...base, input: [...base.input, assistant, { type: "compaction_trigger" }] };
	const result = buildCachedWebSocketRequestBody(undefined, body);
	assert.equal(result.decision, "no_continuation");
	assert.equal(result.body.previous_response_id, undefined);
	assert.deepEqual(result.body.input, body.input);
});
