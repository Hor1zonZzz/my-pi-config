// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import type { AgentConfig } from "./agents.ts";
import { truncateSubagentOutput } from "./output.ts";
import {
	createRejectedResult,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	runSingleAgent,
} from "./runner.ts";
import { MAX_PARALLEL_TASKS } from "./schema.ts";
import type { ScheduleHooks, SchedulerReservation } from "./scheduler.ts";
import type { ProcessScheduler } from "./scheduler.ts";
import type {
	ExecutionMode,
	ExecutionRequest,
	OnUpdateCallback,
	PlanExecution,
	RunProcess,
	SingleResult,
	SubagentDetails,
} from "./types.ts";

interface PlanProgressHooks {
	createScheduleHooks?: () => ScheduleHooks;
	onResult?: (result: SingleResult) => void;
}

export function getExecutionMode(
	params: ExecutionRequest,
): ExecutionMode | undefined {
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	return Number(hasChain) + Number(hasTasks) + Number(hasSingle) === 1
		? hasChain
			? "chain"
			: hasTasks
				? "parallel"
				: "single"
		: undefined;
}

export function makeSubagentDetails(
	mode: ExecutionMode,
	projectAgentsDir: string | null,
	results: SingleResult[],
): SubagentDetails {
	return { mode, projectAgentsDir, results };
}

export function formatPlanContent(
	mode: ExecutionMode,
	results: SingleResult[],
	resultPath: string,
): { content: string; failed: boolean } {
	if (mode === "chain") {
		const failedIndex = results.findIndex(isFailedResult);
		if (failedIndex >= 0) {
			const result = results[failedIndex];
			return {
				content: `Chain stopped at step ${failedIndex + 1} (${result.agent}): ${truncateSubagentOutput(getResultOutput(result), resultPath)}`,
				failed: true,
			};
		}
		const finalResult = results[results.length - 1];
		return {
			content: truncateSubagentOutput(
				finalResult ? getResultOutput(finalResult) : "(no output)",
				resultPath,
			),
			failed: false,
		};
	}

	if (mode === "parallel") {
		const successCount = results.filter(
			(result) => !isFailedResult(result),
		).length;
		const summaries = results.map((result) => {
			const status = isFailedResult(result)
				? `failed${result.stopReason && result.stopReason !== "end" ? ` (${result.stopReason})` : ""}`
				: "completed";
			return `### [${result.agent}] ${status}\n\n${truncateSubagentOutput(getResultOutput(result), resultPath)}`;
		});
		return {
			content: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
			failed: successCount !== results.length,
		};
	}

	const result = results[0];
	return {
		content: result
			? truncateSubagentOutput(
					isFailedResult(result)
						? `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}`
						: getResultOutput(result),
					resultPath,
				)
			: "(no output)",
		failed: !result || isFailedResult(result),
	};
}

export async function executePlan(options: {
	defaultCwd: string;
	agents: AgentConfig[];
	request: ExecutionRequest;
	mode: ExecutionMode;
	projectAgentsDir: string | null;
	signal: AbortSignal | undefined;
	onUpdate: OnUpdateCallback | undefined;
	scheduler: ProcessScheduler;
	initialReservation: SchedulerReservation;
	resultPath: string;
	progress?: PlanProgressHooks;
}): Promise<PlanExecution> {
	const {
		defaultCwd,
		agents,
		request,
		mode,
		projectAgentsDir,
		signal,
		onUpdate,
		scheduler,
		initialReservation,
		resultPath,
		progress,
	} = options;
	const details = (results: SingleResult[]) =>
		makeSubagentDetails(mode, projectAgentsDir, results);
	const runWithReservation =
		(reservation: SchedulerReservation): RunProcess =>
		(runner) =>
			reservation.run(signal, runner, progress?.createScheduleHooks?.());

	if (mode === "chain") {
		const results: SingleResult[] = [];
		let previousOutput = "";
		for (let index = 0; index < (request.chain?.length ?? 0); index += 1) {
			const step = request.chain![index];
			const reservation =
				index === 0 ? initialReservation : scheduler.reserve(1);
			try {
				const result = await runSingleAgent(
					defaultCwd,
					agents,
					step.agent,
					step.task.replace(/\{previous\}/g, previousOutput),
					step.cwd,
					index + 1,
					signal,
					runWithReservation(reservation),
					onUpdate
						? (partial) => {
								const current = partial.details?.results[0];
								if (current) {
									onUpdate({
										content: partial.content,
										details: details([...results, current]),
									});
								}
							}
						: undefined,
					details,
				);
				results.push(result);
				progress?.onResult?.(result);
				if (isFailedResult(result)) break;
				previousOutput = getFinalOutput(result.messages);
			} finally {
				reservation.release();
			}
		}
		const formatted = formatPlanContent(mode, results, resultPath);
		return { mode, results, ...formatted };
	}

	if (mode === "parallel") {
		const tasks = request.tasks ?? [];
		if (tasks.length > MAX_PARALLEL_TASKS) {
			throw new Error(
				`Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
			);
		}
		const reservation = initialReservation;
		const allResults: SingleResult[] = tasks.map((task) => ({
			agent: task.agent,
			agentSource: "unknown",
			task: task.task,
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			extensionMode: "default",
			extensionSources: [],
		}));
		const emitUpdate = () => {
			if (!onUpdate) return;
			const running = allResults.filter(
				(result) => result.exitCode === -1,
			).length;
			onUpdate({
				content: [
					{
						type: "text",
						text: `Parallel: ${allResults.length - running}/${allResults.length} done, ${running} queued/running...`,
					},
				],
				details: details([...allResults]),
			});
		};
		try {
			const results = await Promise.all(
				tasks.map(async (task, index) => {
					let result: SingleResult;
					try {
						result = await runSingleAgent(
							defaultCwd,
							agents,
							task.agent,
							task.task,
							task.cwd,
							undefined,
							signal,
							runWithReservation(reservation),
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitUpdate();
								}
							},
							details,
						);
					} catch (error) {
						result = createRejectedResult(agents, task.agent, task.task, error);
					}
					allResults[index] = result;
					progress?.onResult?.(result);
					emitUpdate();
					return result;
				}),
			);
			const formatted = formatPlanContent(mode, results, resultPath);
			return { mode, results, ...formatted };
		} finally {
			reservation.release();
		}
	}

	const reservation = initialReservation;
	try {
		const result = await runSingleAgent(
			defaultCwd,
			agents,
			request.agent!,
			request.task!,
			request.cwd,
			undefined,
			signal,
			runWithReservation(reservation),
			onUpdate,
			details,
		);
		progress?.onResult?.(result);
		const results = [result];
		const formatted = formatPlanContent(mode, results, resultPath);
		return { mode, results, ...formatted };
	} finally {
		reservation.release();
	}
}
