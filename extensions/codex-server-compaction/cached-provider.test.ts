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

test("a request-local status in the previous request forces full input", () => {
	const status = (text: string) => ({ role: "user", content: [{ type: "input_text", text: `<system_status>\n${text}\n</system_status>` }] });
	const call = { type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" };
	const output = { type: "function_call_output", call_id: "call_1", output: "ok" };
	const previous = { ...base, input: [...base.input, status("1 running")] };
	// Next request: the old status is dropped, the tool output and a new status appended.
	const next = { ...base, input: [...base.input, call, output, status("1 finished")] };
	const withStatus = buildCachedWebSocketRequestBody({ lastRequestBody: previous, lastResponseId: "resp_1", lastResponseItems: [call] }, next);
	assert.equal(withStatus.decision, "input_prefix_mismatch");
	assert.equal(withStatus.body.previous_response_id, undefined);
	assert.deepEqual(withStatus.body.input, next.input);

	// Without a status the pending tool output still continues the response.
	const plain = buildCachedWebSocketRequestBody(
		{ lastRequestBody: base, lastResponseId: "resp_1", lastResponseItems: [call] },
		{ ...base, input: [...base.input, { role: "user", content: [{ type: "input_text", text: "other" }] }, call, output] },
	);
	assert.equal(plain.decision, "delta");
	assert.equal(plain.body.previous_response_id, "resp_1");
	assert.deepEqual(plain.body.input, [output]);
});
