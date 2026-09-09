import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { buildRemoteCompactionDetails, extractRemoteCompactionDetails, reconstructRemoteCompactionStateFromBranch } from "./remote-compaction.ts";
import { ACCOUNT_CONTEXT_ENTRY, hasForeignAccountHistory, latestHistoryAccount, stripOpaqueAccountInput } from "./account-history.ts";

const model = { id: "gpt-5.4", api: "openai-codex-responses", provider: "openai-codex" } as Model<"openai-codex-responses">;
const marker = (accountKey: string) => ({ type: "custom", id: `account-${accountKey}`, customType: ACCOUNT_CONTEXT_ENTRY, data: { accountKey } });
const assistant = { type: "message", id: "assistant", message: {
	role: "assistant" as const, provider: "openai-codex", api: model.api, model: model.id, content: [],
} } as any;
const artifact = (accountKey?: string) => ({ type: "compaction", id: "compact", details: {
	remoteCompaction: buildRemoteCompactionDetails(model, [{ type: "compaction", encrypted_content: "opaque-A" }], undefined, accountKey),
} });

test("native artifacts require the same account; legacy unknown ownership uses text fallback", () => {
	const a = artifact("A");
	assert.equal(extractRemoteCompactionDetails(a.details)?.accountKey, "A");
	assert.ok(reconstructRemoteCompactionStateFromBranch({ branchEntries: [a], model, accountKey: "A" }));
	assert.equal(reconstructRemoteCompactionStateFromBranch({ branchEntries: [a], model, accountKey: "B" }), undefined);
	assert.equal(reconstructRemoteCompactionStateFromBranch({ branchEntries: [artifact()], model, accountKey: "A" }), undefined);
});

test("A -> B -> A cannot revive A's old native artifact after intervening account use", () => {
	assert.equal(reconstructRemoteCompactionStateFromBranch({
		branchEntries: [artifact("A"), marker("B"), assistant, marker("A")], model, accountKey: "A",
	}), undefined);
});

test("account provenance protects ordinary encrypted reasoning and resets at a new compaction", () => {
	assert.equal(hasForeignAccountHistory([], "A"), false);
	assert.equal(hasForeignAccountHistory([assistant], "A"), true);
	assert.equal(hasForeignAccountHistory([marker("A"), assistant], "A"), false);
	assert.equal(hasForeignAccountHistory([marker("A"), assistant, marker("B"), assistant], "B"), true);
	assert.equal(hasForeignAccountHistory([marker("A"), assistant, artifact("B"), assistant], "B"), false);
	assert.equal(latestHistoryAccount([marker("A"), artifact("B")]), "B");
});

test("foreign opaque items and response references are removed without changing visible history or Fast", () => {
	const input = [{ type: "reasoning", encrypted_content: "private-A" }, { type: "compaction", encrypted_content: "opaque-A" },
		{ type: "message", role: "assistant", content: "visible" }, { type: "function_call_output", output: "tool result" }];
	const body = { input, previous_response_id: "response-A", model: "gpt-5.4", service_tier: "priority" };
	const clean = stripOpaqueAccountInput(body);
	assert.deepEqual(clean.input, input.slice(2));
	assert.equal(clean.service_tier, "priority");
	assert.equal(clean.previous_response_id, undefined);
	assert.equal(body.previous_response_id, "response-A");
	assert.equal(body.input.length, 4);
});
