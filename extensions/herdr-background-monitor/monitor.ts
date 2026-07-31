// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	HerdrAgentEnvelope,
	HerdrAgentInfo,
	MonitorOutcome,
	MonitorTask,
} from "./types.ts";

const START_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 60 * 60_000;
const START_POLL_MS = 100;
const ACTIVE_POLL_MS = 500;
const COMMAND_TIMEOUT_MS = 2_000;
const MAX_CONSECUTIVE_QUERY_FAILURES = 3;

class AgentQueryError extends Error {
	constructor(
		message: string,
		readonly definitive: boolean,
	) {
		super(message);
		this.name = "AgentQueryError";
	}
}

function abortError(): Error {
	const error = new Error("Herdr background monitor cancelled");
	error.name = "AbortError";
	return error;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(done, ms);
		function done() {
			signal.removeEventListener("abort", cancelled);
			resolve();
		}
		function cancelled() {
			clearTimeout(timeout);
			signal.removeEventListener("abort", cancelled);
			reject(abortError());
		}
		signal.addEventListener("abort", cancelled, { once: true });
	});
}

function definitiveQueryFailure(code: string, message: string): boolean {
	if (/^(?:agent|pane)_(?:not_found|missing|closed)$/i.test(code)) return true;
	return /(?:agent|pane).*(?:not found|missing|closed)/i.test(message);
}

function parseEnvelope(output: string): HerdrAgentEnvelope | undefined {
	try {
		return JSON.parse(output) as HerdrAgentEnvelope;
	} catch {
		return undefined;
	}
}

function parseAgent(output: string): HerdrAgentInfo {
	const envelope = parseEnvelope(output);
	if (!envelope) {
		throw new AgentQueryError(
			"Herdr returned invalid JSON while reading agent state",
			false,
		);
	}
	if (envelope.error) {
		const code = envelope.error.code || "";
		const message =
			envelope.error.message || code || "Herdr agent query failed";
		throw new AgentQueryError(message, definitiveQueryFailure(code, message));
	}
	const agent = envelope.result?.agent;
	if (!agent?.pane_id || !agent.agent_status) {
		throw new AgentQueryError(
			"Herdr agent response did not include pane or status data",
			false,
		);
	}
	return agent;
}

async function getAgent(
	pi: ExtensionAPI,
	paneId: string,
	signal: AbortSignal,
): Promise<HerdrAgentInfo> {
	const result = await pi.exec("herdr", ["agent", "get", paneId], {
		signal,
		timeout: COMMAND_TIMEOUT_MS,
	});
	if (signal.aborted) throw abortError();
	if (result.killed) {
		throw new AgentQueryError("Herdr agent query timed out", false);
	}
	if (result.code !== 0) {
		const output = result.stderr.trim() || result.stdout.trim();
		const envelope = parseEnvelope(output);
		const code = envelope?.error?.code || "";
		const message =
			envelope?.error?.message ||
			code ||
			output ||
			`herdr agent get failed with exit code ${result.code}`;
		throw new AgentQueryError(message, definitiveQueryFailure(code, message));
	}
	return parseAgent(result.stdout.trim());
}

function terminalOutcome(
	task: MonitorTask,
	agent: HerdrAgentInfo,
): MonitorOutcome | undefined {
	if (agent.pane_id !== task.paneId) {
		return {
			status: "failed",
			error: `Herdr resolved ${task.paneId} to a different pane (${agent.pane_id})`,
		};
	}
	const sequenceAdvanced =
		typeof task.baselineStateChangeSeq === "number" &&
		typeof agent.state_change_seq === "number" &&
		agent.state_change_seq > task.baselineStateChangeSeq;
	const lifecycleAdvanced =
		sequenceAdvanced || agent.agent_status !== task.initialAgentStatus;
	if (
		agent.agent_status === "blocked" &&
		(task.observedWorking || lifecycleAdvanced)
	) {
		return { status: "blocked", agentStatus: "blocked" };
	}
	if (
		agent.agent_status === "done" &&
		(task.observedWorking || lifecycleAdvanced)
	) {
		return { status: "completed", agentStatus: "done" };
	}
	if (agent.agent_status === "working") {
		if (lifecycleAdvanced || task.initialAgentStatus !== "working") {
			task.observedWorking = true;
		}
		task.status = "working";
		return undefined;
	}
	if (
		agent.agent_status === "idle" &&
		(task.observedWorking || lifecycleAdvanced)
	) {
		return { status: "completed", agentStatus: "idle" };
	}
	return undefined;
}

export async function monitorHerdrTask(
	pi: ExtensionAPI,
	task: MonitorTask,
): Promise<MonitorOutcome> {
	const signal = task.controller.signal;
	let consecutiveQueryFailures = 0;
	let failureGeneration = task.generation;

	try {
		while (Date.now() < task.startedAt + TOTAL_TIMEOUT_MS) {
			const generation = task.generation;
			if (failureGeneration !== generation) {
				failureGeneration = generation;
				consecutiveQueryFailures = 0;
			}
			let agent: HerdrAgentInfo;
			try {
				agent = await getAgent(pi, task.paneId, signal);
				consecutiveQueryFailures = 0;
			} catch (error) {
				if (
					signal.aborted ||
					(error instanceof Error && error.name === "AbortError")
				) {
					throw error;
				}
				if (generation !== task.generation) {
					failureGeneration = task.generation;
					consecutiveQueryFailures = 0;
					continue;
				}
				if (error instanceof AgentQueryError && error.definitive) throw error;
				consecutiveQueryFailures += 1;
				if (consecutiveQueryFailures >= MAX_CONSECUTIVE_QUERY_FAILURES)
					throw error;
				await sleep(
					task.observedWorking ? ACTIVE_POLL_MS : START_POLL_MS,
					signal,
				);
				continue;
			}
			if (generation !== task.generation) continue;

			const outcome = terminalOutcome(task, agent);
			if (outcome) return outcome;

			if (
				!task.observedWorking &&
				Date.now() >= task.startedAt + START_TIMEOUT_MS
			) {
				return {
					status: "failed",
					agentStatus: agent.agent_status,
					error:
						"Herdr did not observe the submitted prompt start within 5 seconds",
				};
			}
			await sleep(
				task.observedWorking ? ACTIVE_POLL_MS : START_POLL_MS,
				signal,
			);
		}
		return {
			status: "failed",
			error: "Herdr background monitoring timed out after 60 minutes",
		};
	} catch (error) {
		if (
			signal.aborted ||
			(error instanceof Error && error.name === "AbortError")
		) {
			return { status: "cancelled" };
		}
		return {
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
