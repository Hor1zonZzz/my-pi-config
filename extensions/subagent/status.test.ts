import assert from "node:assert/strict";
import test from "node:test";
import { REQUEST_LOCAL_STATUS_TAG } from "../codex-server-compaction/vendor/howaboua/providers/openai-codex/websocket-continuation.ts";
import { LiveRun, newSnapshot, RunRegistry } from "./runs.ts";
import { registerStatusInjection, STATUS_CLOSE, STATUS_OPEN, StatusTracker, statusText } from "./status.ts";

function run(id: string, agent = "scout", fields: Partial<ReturnType<typeof newSnapshot>> = {}): LiveRun {
	const live = new LiveRun(newSnapshot({
		id,
		parentSessionId: "s",
		agent,
		agentSource: "user",
		task: "find where tokens are refreshed",
		cwd: "/w",
		mode: "async",
		group: { kind: "single", index: 0, total: 1 },
		sessionDir: "/d",
		jobId: "subagent-1a2b3c4d",
	}));
	Object.assign(live.snapshot, { startedAt: 0 }, fields);
	return live;
}

test("the status names each run, its state, and the way to look closer", () => {
	const text = statusText([
		run("a3f9c2e1-x", "scout", { activity: "read src/auth.ts" }).snapshot,
		run("c02e9f17-y", "reviewer", { status: "completed", endedAt: 160_000, mode: "sync", jobId: undefined }).snapshot,
		run("d1d1d1d1-z", "worker", { status: "failed", endedAt: 5_000, errorMessage: "No API key" }).snapshot,
	], 72_000);
	assert.equal(text, [
		"<system_status>",
		"Subagents: 1 running, 2 just finished. This status is current for this request only and is not kept in the conversation.",
		"- a3f9c2e1 scout: running 1m 12s, background job subagent-1a2b3c4d, now: read src/auth.ts. Task: find where tokens are refreshed",
		"- c02e9f17 reviewer: completed in 2m 40s. Task: find where tokens are refreshed",
		"- d1d1d1d1 worker: failed after 5s, background job subagent-1a2b3c4d: No API key. Task: find where tokens are refreshed",
		"Use subagent_control to inspect, read, or wait for a run.",
		"</system_status>",
	].join("\n"));
	// codex-server-compaction keys on the same tag to skip continuation and retention.
	assert.equal(STATUS_OPEN, REQUEST_LOCAL_STATUS_TAG);
	assert.ok(text.startsWith(STATUS_OPEN) && text.endsWith(STATUS_CLOSE));
});

test("a status appears only while subagents are active, and a finished run is reported once", () => {
	const registry = new RunRegistry();
	const tracker = new StatusTracker();
	assert.equal(tracker.next(registry), undefined, "no runs, no block");

	const scout = run("a3f9c2e1-x");
	registry.add(scout);
	assert.match(tracker.next(registry, 1_000)!, /a3f9c2e1 scout: running/);
	assert.match(tracker.next(registry, 2_000)!, /a3f9c2e1 scout: running/, "running runs are in every request");

	Object.assign(scout.snapshot, { status: "completed", endedAt: 3_000 });
	assert.match(tracker.next(registry, 4_000)!, /Subagents: 0 running, 1 just finished[\s\S]*completed in 3s/);
	assert.equal(tracker.next(registry, 5_000), undefined, "after the final state was seen, nothing is injected");

	registry.add(run("b0b0b0b0-y", "worker"));
	const text = tracker.next(registry, 6_000)!;
	assert.match(text, /b0b0b0b0 worker: running/);
	assert.doesNotMatch(text, /a3f9c2e1/);

	tracker.reset();
	registry.reset();
	assert.equal(tracker.next(registry), undefined);
});

test("a background job dispatched but not yet started is reported as starting", () => {
	const registry = new RunRegistry();
	const tracker = new StatusTracker();
	const jobs = [{ id: "subagent-1a2b3c4d", task: "scout: find auth" }];
	const text = tracker.next(registry, 0, jobs)!;
	assert.match(text, /^<system_status>\nSubagents: 1 starting, 0 running, 0 just finished\./);
	assert.match(text, /- background job subagent-1a2b3c4d: starting\. Task: scout: find auth/);
	// Once its run is registered, the run line replaces the starting line.
	registry.add(run("a3f9c2e1-x"));
	const later = tracker.next(registry, 0, jobs)!;
	assert.doesNotMatch(later, /background job subagent-1a2b3c4d: starting/);
	assert.match(later, /^<system_status>\nSubagents: 1 running, 0 just finished\./);
	assert.match(later, /a3f9c2e1 scout: running/);
});

test("the context hook appends the block as a last user message without touching the history", async () => {
	let handler: ((event: any) => any) | undefined;
	const pi = { on: (name: string, fn: any) => name === "context" && (handler = fn) } as any;
	const registry = new RunRegistry();
	registerStatusInjection(pi, registry);
	const history = [{ role: "user", content: "u1", timestamp: 1 }];
	assert.equal(await handler!({ type: "context", messages: history }), undefined);

	registry.add(run("a3f9c2e1-x"));
	const result = await handler!({ type: "context", messages: history });
	assert.equal(result.messages.length, 2);
	assert.equal(result.messages[0], history[0]);
	assert.equal(result.messages[1].role, "user");
	assert.match(result.messages[1].content[0].text, /^<system_status>\n[\s\S]*<\/system_status>$/);
	assert.equal(history.length, 1, "the session's message list is not modified");
});
