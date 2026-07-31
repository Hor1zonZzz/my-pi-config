// @ts-nocheck

import { describe, expect, test } from "bun:test";
import { monitorHerdrTask } from "./monitor.ts";

function response(status: string, sequence: number) {
	return {
		code: 0,
		killed: false,
		stderr: "",
		stdout: JSON.stringify({
			result: {
				agent: {
					agent_status: status,
					focused: false,
					pane_id: "w1:p2",
					state_change_seq: sequence,
					tab_id: "w1:t1",
					workspace_id: "w1",
				},
			},
		}),
	};
}

function task(initialStatus = "idle", sequence = 1) {
	return {
		ownerSessionId: "session-1",
		paneId: "w1:p2",
		displayTarget: "reviewer",
		status: "starting",
		initialAgentStatus: initialStatus,
		baselineStateChangeSeq: sequence,
		observedWorking: initialStatus === "working",
		startedAt: Date.now(),
		generation: 1,
		submissions: [],
		omittedSubmissions: 0,
		controller: new AbortController(),
	};
}

describe("monitorHerdrTask", () => {
	test("waits for a new working lifecycle before accepting idle", async () => {
		const results = [
			response("idle", 1),
			response("working", 2),
			response("idle", 3),
		];
		const pi = { exec: async () => results.shift() ?? response("idle", 3) };
		const outcome = await monitorHerdrTask(pi, task());
		expect(outcome).toEqual({ status: "completed", agentStatus: "idle" });
	});

	test("accepts a fast done transition identified by Herdr's state sequence", async () => {
		const pi = { exec: async () => response("done", 2) };
		const outcome = await monitorHerdrTask(pi, task());
		expect(outcome).toEqual({ status: "completed", agentStatus: "done" });
	});

	test("retries transient failures and command timeouts", async () => {
		const results = [
			{ code: 1, killed: false, stderr: "connection closed", stdout: "" },
			{ code: null, killed: true, stderr: "", stdout: "" },
			response("done", 2),
		];
		const pi = { exec: async () => results.shift() ?? response("done", 2) };
		const outcome = await monitorHerdrTask(pi, task());
		expect(outcome).toEqual({ status: "completed", agentStatus: "done" });
	});

	test("fails immediately when Herdr reports a missing agent", async () => {
		const pi = {
			exec: async () => ({
				code: 1,
				killed: false,
				stderr: JSON.stringify({
					error: { code: "agent_not_found", message: "agent target not found" },
				}),
				stdout: "",
			}),
		};
		const outcome = await monitorHerdrTask(pi, task());
		expect(outcome).toEqual({
			status: "failed",
			error: "agent target not found",
		});
	});

	test("cancels without reporting a failure", async () => {
		const monitoredTask = task();
		monitoredTask.controller.abort();
		const pi = { exec: async () => response("idle", 1) };
		const outcome = await monitorHerdrTask(pi, monitoredTask);
		expect(outcome).toEqual({ status: "cancelled" });
	});
});
