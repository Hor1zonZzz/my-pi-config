import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai";
import {
	buildRemoteCompactionDetails,
	buildRemoteCompactionHeaders,
	buildRemoteCompactionRequestBody,
	buildRemoteCompactionV2History,
	callRemoteCompactionEndpoint,
	combineUsage,
	extractRemoteCompactionDetails,
	messagesToResponseItems,
	parseRemoteCompactionV2Events,
	reconstructRemoteCompactionStateFromBranch,
	remoteCompactionV2EndpointUrl,
	resolveCodexInstallationId,
} from "./remote-compaction.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
	contextWindow: 372_000,
	maxTokens: 128_000,
};

function fakeCodexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function usage(value: number): Usage {
	return {
		input: value,
		output: value,
		cacheRead: value,
		cacheWrite: value,
		totalTokens: value * 4,
		cost: {
			input: value,
			output: value,
			cacheRead: value,
			cacheWrite: value,
			total: value * 4,
		},
	};
}

test("Codex v2 endpoint, request shape, and installation identity", () => {
	const oldCodexHome = process.env.CODEX_HOME;
	const codexHome = mkdtempSync(join(tmpdir(), "pi-codex-compaction-test-"));
	process.env.CODEX_HOME = codexHome;
	try {
		const installationId = resolveCodexInstallationId();
		assert.match(installationId, /^[0-9a-f-]{36}$/);
		assert.equal(readFileSync(join(codexHome, "installation_id"), "utf8"), installationId);
		assert.equal(resolveCodexInstallationId(), installationId);

		const endpoint = remoteCompactionV2EndpointUrl(model);
		assert.equal(endpoint, "https://chatgpt.com/backend-api/codex/responses");

		const body = buildRemoteCompactionRequestBody({
			model,
			input: [{ type: "message", role: "user", content: "hello" }],
			instructions: "system",
			tools: [],
			parallelToolCalls: true,
			serviceTier: "priority",
			sessionId: "session-123",
		});
		assert.equal(body.service_tier, "priority");
		assert.equal(body.store, false);
		assert.equal(body.stream, true);
		assert.deepEqual((body.input as unknown[]).at(-1), {
			type: "compaction_trigger",
		});

		const headers = buildRemoteCompactionHeaders({
			model,
			apiKey: fakeCodexToken("account-123"),
			sessionId: "session-123",
			serviceTier: "priority",
		});
		assert.equal(headers["chatgpt-account-id"], "account-123");
		assert.equal(headers["x-codex-installation-id"], installationId);
		assert.equal(headers["x-codex-beta-features"], "remote_compaction_v2");
		assert.equal(
			headers["x-codex-routing-hint"],
			"model=gpt-5.6-sol;tier=priority",
		);

		writeFileSync(join(codexHome, "installation_id"), "invalid");
		const replacementId = resolveCodexInstallationId();
		assert.notEqual(replacementId, installationId);
		assert.match(replacementId, /^[0-9a-f-]{36}$/);
	} finally {
		if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = oldCodexHome;
		rmSync(codexHome, { recursive: true, force: true });
	}
});

test("message conversion keeps one real output per tool call", () => {
	const callId = "call-1|fc_1";
	const assistant = {
		role: "assistant",
		provider: "openai-codex",
		api: "openai-codex-responses",
		model: "gpt-5.6-sol",
		content: [
			{
				type: "toolCall",
				id: callId,
				name: "read",
				arguments: { path: "README.md" },
			},
		],
		usage: usage(0),
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as AgentMessage;
	const result = {
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: [{ type: "text", text: "REAL_OUTPUT" }],
		isError: false,
		timestamp: Date.now(),
	} as AgentMessage;
	const items = messagesToResponseItems([assistant, result], model);
	const call = items.find((item) => item.type === "function_call");
	assert.equal(call?.id, "fc_1");
	const outputs = items.filter((item) => item.type === "function_call_output");
	assert.equal(outputs.length, 1);
	assert.match(JSON.stringify(outputs[0]), /REAL_OUTPUT/);
	assert.doesNotMatch(JSON.stringify(outputs), /aborted/);
});

test("assistant conversion preserves Responses identities for cached continuation", () => {
	const assistant = {
		role: "assistant",
		provider: "openai-codex",
		api: "openai-codex-responses",
		model: "gpt-5.6-sol",
		content: [
			{
				type: "text",
				text: "continuation reply",
				textSignature: JSON.stringify({
					v: 1,
					id: "msg_response_1",
					phase: "final_answer",
				}),
			},
		],
		usage: usage(0),
		stopReason: "stop",
		timestamp: Date.now(),
	} as AgentMessage;
	assert.deepEqual(messagesToResponseItems([assistant], model), [
		{
			type: "message",
			role: "assistant",
			content: [
				{
					type: "output_text",
					text: "continuation reply",
					annotations: [],
				},
			],
			status: "completed",
			id: "msg_response_1",
			phase: "final_answer",
		},
	]);
});

test("v2 stream parsing retains recent user input plus one opaque artifact", () => {
	const parsed = parseRemoteCompactionV2Events([
		{
			type: "response.output_item.done",
			item: { type: "compaction", encrypted_content: "encrypted" },
		},
		{
			type: "response.completed",
			response: {
				usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
			},
		},
	]);
	const history = buildRemoteCompactionV2History(
		[
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "retain me" }],
			},
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "compact me" }],
			},
		],
		parsed.compactionItem,
	);
	assert.deepEqual(
		history.map((item) => item.type),
		["message", "compaction"],
	);
	assert.equal(history[0].role, "user");
});

test("exact-model details survive model switches that produce no foreign reply", () => {
	const details = buildRemoteCompactionDetails(
		model,
		[{ type: "compaction", encrypted_content: "encrypted" }],
		usage(1),
	);
	assert.equal(
		extractRemoteCompactionDetails({ remoteCompaction: details })?.implementation,
		"responses_compaction_v2",
	);
	const targetAssistant = {
		role: "assistant",
		provider: "openai-codex",
		api: "openai-codex-responses",
		model: "gpt-5.6-sol",
		content: [{ type: "text", text: "KEEP_REPLY" }],
		usage: usage(0),
		stopReason: "stop",
		timestamp: Date.now(),
	} as AgentMessage;
	const user = (text: string) =>
		({ role: "user", content: text, timestamp: Date.now() }) as AgentMessage;
	const compactionEntry = {
		type: "compaction",
		id: "cmp-1",
		details: { remoteCompaction: details },
	};

	assert.equal(
		reconstructRemoteCompactionStateFromBranch({
			model: { ...model, id: "gpt-5.6-luna" },
			branchEntries: [compactionEntry],
		}),
		undefined,
	);
	const state = reconstructRemoteCompactionStateFromBranch({
		model,
		branchEntries: [
			compactionEntry,
			{ type: "model_change", id: "switch-to-luna" },
			{ type: "model_change", id: "switch-back-to-sol" },
			{ type: "message", id: "user-1", message: user("KEEP_USER") },
			{ type: "message", id: "assistant-1", message: targetAssistant },
			{
				type: "custom_message",
				id: "custom-1",
				parentId: "assistant-1",
				timestamp: new Date().toISOString(),
				customType: "test",
				content: "KEEP_CUSTOM_TAIL",
				display: false,
			} as never,
			{ type: "message", id: "user-2", message: user("KEEP_PENDING_USER") },
		],
	});
	assert.ok(state);
	const serialized = JSON.stringify(state.explicitHistory);
	assert.match(serialized, /KEEP_USER/);
	assert.match(serialized, /KEEP_REPLY/);
	assert.match(serialized, /KEEP_CUSTOM_TAIL/);
	assert.match(serialized, /KEEP_PENDING_USER/);
});

test("a foreign assistant turn invalidates the older exact-model artifact", () => {
	const details = buildRemoteCompactionDetails(model, [
		{ type: "compaction", encrypted_content: "encrypted" },
	]);
	const targetAssistant = {
		role: "assistant",
		provider: "openai-codex",
		api: "openai-codex-responses",
		model: "gpt-5.6-sol",
		content: [{ type: "text", text: "SOL_REPLY" }],
		usage: usage(0),
		stopReason: "stop",
		timestamp: Date.now(),
	} as AgentMessage;
	const user = {
		role: "user",
		content: "LUNA_USER",
		timestamp: Date.now(),
	} as AgentMessage;
	const foreignAssistants = [
		{
			...targetAssistant,
			model: "gpt-5.6-luna",
			content: [{ type: "text", text: "LUNA_REPLY" }],
		},
		{
			...targetAssistant,
			api: "openai-responses",
			content: [{ type: "text", text: "WRONG_API_REPLY" }],
		},
		{
			...targetAssistant,
			provider: "anthropic",
			api: "anthropic-messages",
			model: "claude-sonnet-4-6",
			content: [{ type: "text", text: "CLAUDE_REPLY" }],
		},
	] as AgentMessage[];

	for (const [index, foreignAssistant] of foreignAssistants.entries()) {
		assert.equal(
			reconstructRemoteCompactionStateFromBranch({
				model,
				branchEntries: [
					{
						type: "compaction",
						id: "cmp-1",
						details: { remoteCompaction: details },
					},
					{ type: "message", id: "user-1", message: user },
					{
						type: "message",
						id: `assistant-${index}`,
						message: foreignAssistant,
					},
				],
			}),
			undefined,
		);
	}
});

test("a stalled remote request is aborted independently of the Pi compaction signal", async () => {
	const oldCodexHome = process.env.CODEX_HOME;
	const codexHome = mkdtempSync(join(tmpdir(), "pi-codex-timeout-test-"));
	process.env.CODEX_HOME = codexHome;
	try {
		const stalledFetch: typeof fetch = async (_input, init) =>
			new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) return;
				if (signal.aborted) reject(signal.reason);
				else {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}
			});
		await assert.rejects(
			callRemoteCompactionEndpoint({
				model,
				apiKey: fakeCodexToken("account-123"),
				sessionId: "session-timeout",
				input: [{ type: "message", role: "user", content: "hello" }],
				tools: [],
				parallelToolCalls: true,
				timeoutMs: 10,
				fetchFn: stalledFetch,
			}),
			(error: unknown) =>
				error instanceof DOMException && error.name === "TimeoutError",
		);
	} finally {
		if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = oldCodexHome;
		rmSync(codexHome, { recursive: true, force: true });
	}
});

test("local and remote compaction usage is counted once as one combined result", () => {
	assert.deepEqual(combineUsage(usage(1), usage(2)), usage(3));
});
