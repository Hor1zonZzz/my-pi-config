// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.ts";
import { getExecutionMode, makeSubagentDetails } from "./execution.ts";
import { truncateSubagentOutput } from "./output.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import { MAX_PARALLEL_TASKS, SubagentParams } from "./schema.ts";
import type { ManagedSubagentTask } from "./task-manager.ts";
import type { SubagentTaskManager } from "./task-manager.ts";

export function createSubagentToolRegistrar(
	pi: ExtensionAPI,
	taskManager: SubagentTaskManager,
): (cwd: string) => void {
	let registeredAgentNamesKey: string | undefined;
	const subagentTool = {
		name: "subagent",
		label: "Subagent",
		description: "",
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (params.action === undefined) {
				const legacyMode = getExecutionMode(params);
				if (!legacyMode) {
					const discovery = discoverAgents(ctx.cwd);
					const available =
						discovery.agents
							.map((agent) => `${agent.name} (${agent.source})`)
							.join(", ") || "none";
					return {
						content: [
							{
								type: "text",
								text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
							},
						],
						details: makeSubagentDetails(
							"single",
							discovery.projectAgentsDir,
							[],
						),
					};
				}
				params.action = "block";
			}

			const hasExecutionFields =
				params.agent !== undefined ||
				params.task !== undefined ||
				params.tasks !== undefined ||
				params.chain !== undefined ||
				params.cwd !== undefined;
			const managementAction =
				params.action === "list" ||
				params.action === "status" ||
				params.action === "cancel";
			if (managementAction && hasExecutionFields) {
				throw new Error(
					`action=${params.action} does not accept agent, task, tasks, chain, or cwd.`,
				);
			}
			if (
				(params.action === "block" || params.action === "background") &&
				params.taskId !== undefined
			) {
				throw new Error(`action=${params.action} does not accept taskId.`);
			}
			if (params.action === "list" && params.taskId !== undefined) {
				throw new Error("action=list does not accept taskId.");
			}

			if (params.action === "list") {
				const statuses = taskManager.listStatuses(ctx.cwd);
				const text =
					statuses.length === 0
						? "No subagent tasks in the current session."
						: statuses
								.map(
									(status) =>
										`${status.taskId}  ${status.status}  ${status.mode}/${status.execution}  ${status.processes.completed}/${status.processes.total} complete\n  ${status.resultPath}`,
								)
								.join("\n");
				return {
					content: [{ type: "text", text: truncateSubagentOutput(text) }],
					details: makeSubagentDetails("single", null, []),
				};
			}

			if (params.action === "status" || params.action === "cancel") {
				if (!params.taskId) {
					throw new Error(`action=${params.action} requires taskId.`);
				}
				const task = taskManager.findTask(ctx.cwd, params.taskId);
				if (!task) {
					return {
						content: [
							{
								type: "text",
								text: `Unknown subagent task: ${params.taskId}`,
							},
						],
						details: makeSubagentDetails("single", null, []),
					};
				}

				if (params.action === "cancel") {
					if (
						task.status.status !== "queued" &&
						task.status.status !== "running"
					) {
						return {
							content: [
								{
									type: "text",
									text: `Task ${task.status.taskId} is already ${task.status.status}.`,
								},
							],
							details: makeSubagentDetails(task.status.mode, null, []),
						};
					}
					task.controller?.abort();
					return {
						content: [
							{
								type: "text",
								text: `Cancellation requested for subagent task ${task.status.taskId}.`,
							},
						],
						details: makeSubagentDetails(task.status.mode, null, []),
					};
				}

				const { request: _request, ...statusSummary } = task.status;
				return {
					content: [
						{
							type: "text",
							text: truncateSubagentOutput(
								JSON.stringify(
									{
										...statusSummary,
										statusPath: path.join(
											task.paths.relativeDirectory,
											"status.json",
										),
									},
									null,
									2,
								),
							),
						},
					],
					details: makeSubagentDetails(task.status.mode, null, []),
				};
			}

			const mode = getExecutionMode(params);
			if (!mode) {
				throw new Error(
					"action=block/background requires exactly one execution mode: agent+task, tasks, or chain.",
				);
			}
			const invalidModeFields =
				(mode === "single" &&
					(params.tasks !== undefined || params.chain !== undefined)) ||
				(mode === "parallel" &&
					(params.agent !== undefined ||
						params.task !== undefined ||
						params.chain !== undefined ||
						params.cwd !== undefined)) ||
				(mode === "chain" &&
					(params.agent !== undefined ||
						params.task !== undefined ||
						params.tasks !== undefined ||
						params.cwd !== undefined));
			if (invalidModeFields) {
				throw new Error(
					`Invalid fields for ${mode} mode. Single accepts agent/task/cwd; parallel accepts only tasks; chain accepts only chain.`,
				);
			}
			if (mode === "parallel" && params.tasks.length > MAX_PARALLEL_TASKS) {
				return {
					content: [
						{
							type: "text",
							text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
						},
					],
					details: makeSubagentDetails(mode, null, []),
				};
			}

			const discovery = discoverAgents(ctx.cwd);
			const agents = discovery.agents;
			const demand = mode === "parallel" ? params.tasks.length : 1;
			let reservation;
			try {
				reservation = taskManager.reserve(demand);
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: error instanceof Error ? error.message : String(error),
						},
					],
					details: makeSubagentDetails(mode, discovery.projectAgentsDir, []),
				};
			}

			let task: ManagedSubagentTask;
			try {
				task = taskManager.createTask(params.action, mode, params, ctx.cwd);
			} catch (error) {
				reservation.release();
				throw error;
			}

			let unlinkParentAbort: (() => void) | undefined;
			if (params.action === "block" && signal) {
				const abort = () => task.controller?.abort();
				if (signal.aborted) abort();
				else {
					signal.addEventListener("abort", abort, { once: true });
					unlinkParentAbort = () => signal.removeEventListener("abort", abort);
				}
			}

			const execution = taskManager.runTask(
				task,
				params,
				agents,
				discovery.projectAgentsDir,
				reservation,
				params.action === "block" ? onUpdate : undefined,
			);

			if (params.action === "background") {
				return {
					content: [
						{
							type: "text",
							text: `Background subagent task started.\n\nTask ID: ${task.status.taskId}\nStatus: ${task.status.status}\nDirectory: ${task.paths.relativeDirectory}`,
						},
					],
					details: {
						...makeSubagentDetails(mode, discovery.projectAgentsDir, []),
						taskId: task.status.taskId,
						taskStatus: task.status.status,
						resultPath: task.status.resultPath,
					},
				};
			}

			try {
				const plan = await execution;
				if (!plan) {
					throw new Error(
						`Subagent task ${task.status.taskId} ${task.status.status}: ${task.status.error ?? "no result"}\nComplete result: ${task.status.resultPath}\nStructured details: ${task.status.detailsPath}`,
					);
				}
				if (plan.failed || task.status.status !== "completed") {
					throw new Error(
						`Subagent task ${task.status.taskId} ${task.status.status}. ${task.status.error ?? plan.content}\nComplete result: ${task.status.resultPath}\nStructured details: ${task.status.detailsPath}`,
					);
				}
				return {
					content: [{ type: "text", text: plan.content }],
					details: {
						...makeSubagentDetails(mode, discovery.projectAgentsDir, []),
						taskId: task.status.taskId,
						taskStatus: task.status.status,
						resultPath: task.status.resultPath,
					},
				};
			} finally {
				unlinkParentAbort?.();
			}
		},

		renderCall: renderSubagentCall,
		renderResult: renderSubagentResult,
	};

	return (cwd: string): void => {
		const agentNames = discoverAgents(cwd)
			.agents.map((agent) => agent.name)
			.sort((left, right) => left.localeCompare(right));
		const agentNamesKey = agentNames.join("\0");
		if (registeredAgentNamesKey === agentNamesKey) return;
		registeredAgentNamesKey = agentNamesKey;
		subagentTool.description = [
			"Run and manage isolated subagent tasks.",
			"Actions: block waits, background returns a task ID, list/status inspect current-session tasks, cancel stops one.",
			"Action is optional: a valid single/parallel/chain request defaults to block; otherwise the tool lists available agents.",
			"Execution modes: single (agent + task), parallel (tasks array), chain (sequential with full {previous} output).",
			"User-level and nearest project-level agents are always merged; project agents override same-named user agents.",
			`Available agents: ${agentNames.join(", ") || "none"}.`,
			"Every subagent contributes at most 50KB to the parent; complete results are written under .pi/subagent-tasks/<sessionId>/<taskId>/.",
		].join(" ");
		pi.registerTool(subagentTool);
	};
}
