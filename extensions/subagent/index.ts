// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type AgentConfig,
	type AgentExtensionMode,
	type AgentScope,
	discoverAgents,
} from "./agents.ts";
import { truncateSubagentOutput } from "./output.ts";
import { ProcessScheduler } from "./scheduler.ts";
import type { ScheduleHooks, SchedulerReservation } from "./scheduler.ts";
import { loadSubagentSettings } from "./settings.ts";
import {
	getTaskPaths,
	initializeTaskDirectory,
	markStaleTasksInterrupted,
	readSessionTaskStatuses,
	type StoredTaskStatus,
	type SubagentTaskStatus,
	type TaskPaths,
	writeTaskResults,
	writeTaskStatus,
} from "./task-storage.ts";

const MAX_PARALLEL_TASKS = 8;
const COLLAPSED_ITEM_COUNT = 10;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatExtensionPolicy(
	mode: AgentExtensionMode | undefined,
	sources: string[] | undefined,
	verbose = false,
): string {
	if (mode !== "isolated") return "extensions: auto";
	const configuredSources = sources ?? [];
	if (configuredSources.length === 0) return "extensions: none";
	return verbose
		? `extensions: ${configuredSources.join(", ")}`
		: `extensions: allowlist (${configuredSources.length})`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns)
		parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview =
				command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg(
					"warning",
					`:${startLine}${endLine ? `-${endLine}` : ""}`,
				);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return (
				themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath))
			);
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview =
				argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	extensionMode: AgentExtensionMode;
	extensionSources: string[];
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	taskId?: string;
	taskStatus?: SubagentTaskStatus;
	resultPath?: string;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		return msg.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted"
	);
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return (
			result.errorMessage ||
			result.stderr ||
			getFinalOutput(result.messages) ||
			"(no output)"
		);
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function createRejectedResult(
	agents: AgentConfig[],
	agentName: string,
	task: string,
	error: unknown,
	step?: number,
): SingleResult {
	const agent = agents.find((candidate) => candidate.name === agentName);
	const message = error instanceof Error ? error.message : String(error);
	return {
		agent: agentName,
		agentSource: agent?.source ?? "unknown",
		task,
		exitCode: 1,
		messages: [],
		stderr: message,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		extensionMode: agent?.extensionMode ?? "default",
		extensionSources: agent?.extensionSources ?? [],
		model: agent?.model,
		stopReason:
			error instanceof Error && error.name === "AbortError"
				? "aborted"
				: "error",
		errorMessage: message,
		step,
	};
}

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({
						type: "toolCall",
						name: part.name,
						args: part.arguments,
					});
			}
		}
	}
	return items;
}

async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), "pi-subagent-"),
	);
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, {
			encoding: "utf-8",
			mode: 0o600,
		});
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;
type RunProcess = <T>(runner: () => Promise<T>) => Promise<T>;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	runProcess: RunProcess,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
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
			step,
		};
	}

	if (agent.extensionConfigError) {
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: `Agent "${agentName}": ${agent.extensionConfigError}`,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			extensionMode: agent.extensionMode,
			extensionSources: agent.extensionSources,
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.extensionMode === "isolated") {
		args.push("--no-extensions");
		for (const extensionSource of agent.extensionSources)
			args.push("--extension", extensionSource);
	}
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0)
		args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
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
		extensionMode: agent.extensionMode,
		extensionSources: agent.extensionSources,
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [
					{
						type: "text",
						text: getFinalOutput(currentResult.messages) || "(running...)",
					},
				],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await runProcess(
			() =>
				new Promise<number>((resolve) => {
					const invocation = getPiInvocation(args);
					const useProcessGroup = process.platform !== "win32";
					const proc = spawn(invocation.command, invocation.args, {
						cwd: cwd ?? defaultCwd,
						shell: false,
						detached: useProcessGroup,
						stdio: ["ignore", "pipe", "pipe"],
					});
					let buffer = "";
					let closed = false;
					let killTimer: ReturnType<typeof setTimeout> | undefined;

					const processLine = (line: string) => {
						if (!line.trim()) return;
						let event: any;
						try {
							event = JSON.parse(line);
						} catch {
							return;
						}

						if (event.type === "message_end" && event.message) {
							const msg = event.message as Message;
							currentResult.messages.push(msg);

							if (msg.role === "assistant") {
								currentResult.usage.turns++;
								const usage = msg.usage;
								if (usage) {
									currentResult.usage.input += usage.input || 0;
									currentResult.usage.output += usage.output || 0;
									currentResult.usage.cacheRead += usage.cacheRead || 0;
									currentResult.usage.cacheWrite += usage.cacheWrite || 0;
									currentResult.usage.cost += usage.cost?.total || 0;
									currentResult.usage.contextTokens = usage.totalTokens || 0;
								}
								if (!currentResult.model && msg.model)
									currentResult.model = msg.model;
								if (msg.stopReason) currentResult.stopReason = msg.stopReason;
								if (msg.errorMessage)
									currentResult.errorMessage = msg.errorMessage;
							}
							emitUpdate();
						}
					};

					proc.stdout.on("data", (data) => {
						buffer += data.toString();
						const lines = buffer.split("\n");
						buffer = lines.pop() || "";
						for (const line of lines) processLine(line);
					});

					proc.stderr.on("data", (data) => {
						currentResult.stderr += data.toString();
					});

					const signalProcess = (signalName: NodeJS.Signals) => {
						if (process.platform === "win32" && proc.pid) {
							spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
								stdio: "ignore",
							});
							return;
						}
						if (useProcessGroup && proc.pid) {
							try {
								process.kill(-proc.pid, signalName);
								return;
							} catch {
								// Fall back to the direct child if the process group already exited.
							}
						}
						proc.kill(signalName);
					};
					const killProc = () => {
						wasAborted = true;
						if (closed) return;
						signalProcess("SIGTERM");
						killTimer = setTimeout(() => {
							if (!closed) signalProcess("SIGKILL");
						}, 5000);
					};

					proc.on("close", (code) => {
						closed = true;
						if (killTimer) clearTimeout(killTimer);
						signal?.removeEventListener("abort", killProc);
						if (buffer.trim()) processLine(buffer);
						resolve(code ?? 0);
					});

					proc.on("error", (error) => {
						closed = true;
						if (killTimer) clearTimeout(killTimer);
						signal?.removeEventListener("abort", killProc);
						currentResult.errorMessage = error.message;
						currentResult.stderr += `${error.message}\n`;
						resolve(1);
					});

					if (signal?.aborted) killProc();
					else signal?.addEventListener("abort", killProc, { once: true });
				}),
		);

		currentResult.exitCode = wasAborted && exitCode === 0 ? 1 : exitCode;
		if (wasAborted) {
			currentResult.stopReason = "aborted";
			currentResult.errorMessage = "Subagent was aborted";
		}
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

interface ExecutionRequest {
	agent?: string;
	task?: string;
	tasks?: Array<{ agent: string; task: string; cwd?: string }>;
	chain?: Array<{ agent: string; task: string; cwd?: string }>;
	cwd?: string;
}

interface PlanExecution {
	mode: "single" | "parallel" | "chain";
	results: SingleResult[];
	content: string;
	failed: boolean;
}

interface PlanProgressHooks {
	createScheduleHooks?: () => ScheduleHooks;
	onResult?: (result: SingleResult) => void;
}

function getExecutionMode(
	params: ExecutionRequest,
): "single" | "parallel" | "chain" | undefined {
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

function makeSubagentDetails(
	mode: "single" | "parallel" | "chain",
	agentScope: AgentScope,
	projectAgentsDir: string | null,
	results: SingleResult[],
): SubagentDetails {
	return { mode, agentScope, projectAgentsDir, results };
}

function formatPlanContent(
	mode: "single" | "parallel" | "chain",
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

async function executePlan(options: {
	defaultCwd: string;
	agents: AgentConfig[];
	request: ExecutionRequest;
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
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
		agentScope,
		projectAgentsDir,
		signal,
		onUpdate,
		scheduler,
		initialReservation,
		resultPath,
		progress,
	} = options;
	const details = (results: SingleResult[]) =>
		makeSubagentDetails(mode, agentScope, projectAgentsDir, results);
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

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		description: "Task with optional {previous} placeholder for prior output",
	}),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	action: StringEnum(
		["block", "background", "list", "status", "cancel"] as const,
		{
			description:
				"Required operation: block waits for execution, background returns a task ID, list/status inspect tasks, cancel stops a task.",
		},
	),
	taskId: Type.Optional(
		Type.String({ description: "Task ID for status or cancel actions" }),
	),
	agent: Type.Optional(
		Type.String({
			description: "Name of the agent to invoke (for single mode)",
		}),
	),
	task: Type.Optional(
		Type.String({ description: "Task to delegate (for single mode)" }),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Array of {agent, task} for parallel execution",
			minItems: 1,
			maxItems: MAX_PARALLEL_TASKS,
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description: "Array of {agent, task} for sequential execution",
			minItems: 1,
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local agents. Default: true.",
			default: true,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the agent process (single mode)",
		}),
	),
});

interface ManagedSubagentTask {
	status: StoredTaskStatus;
	paths: TaskPaths;
	controller?: AbortController;
	results: SingleResult[];
	promise?: Promise<PlanExecution | undefined>;
}

export default function (pi: ExtensionAPI) {
	let scheduler: ProcessScheduler | undefined;
	let sessionId = "";
	let activeContext: any;
	let shuttingDown = false;
	let tasks = new Map<string, ManagedSubagentTask>();
	let pendingCompletions: ManagedSubagentTask[] = [];

	const getScheduler = (): ProcessScheduler => {
		if (!scheduler) scheduler = new ProcessScheduler(loadSubagentSettings());
		return scheduler;
	};

	const activeTasks = (): ManagedSubagentTask[] =>
		Array.from(tasks.values()).filter(
			(task) =>
				task.status.status === "queued" || task.status.status === "running",
		);

	const updateTaskStatusWidget = (): void => {
		if (!activeContext) return;
		const active = activeTasks();
		if (active.length === 0) {
			activeContext.ui.setStatus("subagent-tasks", undefined);
			return;
		}
		const running = active.reduce(
			(total, task) => total + task.status.processes.running,
			0,
		);
		const queued = active.reduce(
			(total, task) => total + task.status.processes.queued,
			0,
		);
		activeContext.ui.setStatus(
			"subagent-tasks",
			activeContext.ui.theme.fg(
				"warning",
				`subagents ${running} running · ${queued} queued`,
			),
		);
	};

	const persistTask = (
		task: ManagedSubagentTask,
		appendSessionEntry = false,
	): void => {
		writeTaskStatus(task.paths, task.status);
		if (appendSessionEntry && !shuttingDown) {
			pi.appendEntry("subagent-task-state", {
				taskId: task.status.taskId,
				status: task.status.status,
				mode: task.status.mode,
				execution: task.status.execution,
				resultPath: task.status.resultPath,
				detailsPath: task.status.detailsPath,
				createdAt: task.status.createdAt,
				completedAt: task.status.completedAt,
				error: task.status.error,
			});
		}
		updateTaskStatusWidget();
	};

	const makeCompletionMessage = (
		completedTasks: ManagedSubagentTask[],
	): string => {
		const sections = completedTasks.map((task) => {
			const formatted = formatPlanContent(
				task.status.mode,
				task.results,
				task.status.resultPath,
			);
			return [
				`## Subagent Task ${task.status.taskId}`,
				"",
				`Status: ${task.status.status}`,
				...(task.status.error ? [`Error: ${task.status.error}`] : []),
				`Complete result: ${task.status.resultPath}`,
				`Structured details: ${task.status.detailsPath}`,
				"",
				formatted.content,
			].join("\n");
		});
		return sections.join("\n\n---\n\n");
	};

	const deliverCompletions = (completedTasks: ManagedSubagentTask[]): void => {
		if (shuttingDown || completedTasks.length === 0) return;
		pi.sendMessage(
			{
				customType: "subagent-task-completion",
				content: makeCompletionMessage(completedTasks),
				display: true,
				details: {
					taskIds: completedTasks.map((task) => task.status.taskId),
				},
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	const queueCompletion = (task: ManagedSubagentTask): void => {
		if (shuttingDown) return;
		if (activeContext?.isIdle()) {
			deliverCompletions([task]);
			return;
		}
		pendingCompletions.push(task);
	};

	const createTask = (
		execution: "block" | "background",
		mode: "single" | "parallel" | "chain",
		request: any,
		cwd: string,
	): ManagedSubagentTask => {
		const taskId = `task_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
		const paths = getTaskPaths(cwd, sessionId, taskId);
		initializeTaskDirectory(paths);
		const total =
			mode === "parallel"
				? request.tasks.length
				: mode === "chain"
					? request.chain.length
					: 1;
		const status: StoredTaskStatus = {
			version: 1,
			taskId,
			sessionId,
			execution,
			mode,
			status: "queued",
			createdAt: Date.now(),
			cwd,
			resultPath: path.join(paths.relativeDirectory, "result.md"),
			detailsPath: path.join(paths.relativeDirectory, "details.json"),
			request,
			processes: {
				total,
				queued: 0,
				running: 0,
				completed: 0,
				failed: 0,
			},
		};
		const task: ManagedSubagentTask = {
			status,
			paths,
			controller: new AbortController(),
			results: [],
		};
		tasks.set(taskId, task);
		persistTask(task, true);
		return task;
	};

	const runManagedTask = (
		task: ManagedSubagentTask,
		request: any,
		agents: AgentConfig[],
		agentScope: AgentScope,
		projectAgentsDir: string | null,
		initialReservation: SchedulerReservation,
		onUpdate?: OnUpdateCallback,
	): Promise<PlanExecution | undefined> => {
		const promise = (async () => {
			const createScheduleHooks = (): ScheduleHooks => ({
				onQueued: () => {
					task.status.processes.queued += 1;
					persistTask(task);
				},
				onDequeued: () => {
					task.status.processes.queued = Math.max(
						0,
						task.status.processes.queued - 1,
					);
					persistTask(task);
				},
				onStart: () => {
					task.status.processes.queued = Math.max(
						0,
						task.status.processes.queued - 1,
					);
					task.status.processes.running += 1;
					task.status.status = "running";
					task.status.startedAt ??= Date.now();
					persistTask(task);
				},
				onFinish: () => {
					task.status.processes.running = Math.max(
						0,
						task.status.processes.running - 1,
					);
					persistTask(task);
				},
			});

			try {
				const plan = await executePlan({
					defaultCwd: task.status.cwd,
					agents,
					request,
					mode: task.status.mode,
					agentScope,
					projectAgentsDir,
					signal: task.controller?.signal,
					onUpdate,
					scheduler: getScheduler(),
					initialReservation,
					resultPath: task.status.resultPath,
					progress: {
						createScheduleHooks,
						onResult: (result) => {
							task.results.push(result);
							task.status.processes.completed += 1;
							if (isFailedResult(result)) {
								task.status.processes.failed += 1;
							}
							persistTask(task);
						},
					},
				});
				task.results = plan.results;
				task.status.status = task.controller?.signal.aborted
					? "cancelled"
					: plan.failed
						? "failed"
						: "completed";
				task.status.processes.queued = 0;
				task.status.processes.running = 0;
				task.status.completedAt = Date.now();
				writeTaskResults(task.paths, task.status, task.results);
				persistTask(task, true);
				if (task.status.execution === "background") queueCompletion(task);
				return plan;
			} catch (error) {
				initialReservation.release();
				const cancelled =
					task.controller?.signal.aborted ||
					(error instanceof Error && error.name === "AbortError");
				task.status.status = cancelled ? "cancelled" : "failed";
				task.status.processes.queued = 0;
				task.status.processes.running = 0;
				task.status.completedAt = Date.now();
				task.status.error =
					error instanceof Error ? error.message : String(error);
				writeTaskResults(task.paths, task.status, task.results);
				persistTask(task, true);
				if (task.status.execution === "background") queueCompletion(task);
				return undefined;
			}
		})();
		const guardedPromise = promise.catch((error) => {
			task.status.status = task.controller?.signal.aborted
				? "cancelled"
				: "failed";
			task.status.processes.queued = 0;
			task.status.processes.running = 0;
			task.status.completedAt = Date.now();
			task.status.error =
				error instanceof Error ? error.message : String(error);
			try {
				writeTaskStatus(task.paths, task.status);
			} catch {
				// Nothing else can be persisted if the task directory is unavailable.
			}
			return undefined;
		});
		task.promise = guardedPromise;
		return guardedPromise;
	};

	pi.registerMessageRenderer(
		"subagent-task-completion",
		(message, _options, _theme) =>
			new Markdown(message.content, 0, 0, getMarkdownTheme()),
	);

	pi.on("session_start", (_event, ctx) => {
		shuttingDown = false;
		activeContext = ctx;
		sessionId = ctx.sessionManager.getSessionId();
		scheduler = new ProcessScheduler(loadSubagentSettings());
		pendingCompletions = [];
		tasks = new Map(
			markStaleTasksInterrupted(ctx.cwd, sessionId).map((status) => [
				status.taskId,
				{
					status,
					paths: getTaskPaths(ctx.cwd, sessionId, status.taskId),
					results: [],
				},
			]),
		);
		updateTaskStatusWidget();
	});

	pi.on("agent_settled", () => {
		if (pendingCompletions.length === 0 || shuttingDown) return;
		const completed = pendingCompletions;
		pendingCompletions = [];
		deliverCompletions(completed);
	});

	pi.on("session_before_tree", (_event, ctx) => {
		const active = activeTasks();
		if (active.length === 0) return;
		ctx.ui.notify(
			`Cannot navigate the session tree while ${active.length} subagent task(s) are active. Use subagent action=list or action=cancel first.`,
			"warning",
		);
		return { cancel: true };
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		pendingCompletions = [];
		scheduler?.shutdown();
		for (const task of activeTasks()) task.controller?.abort();
		const promises = activeTasks()
			.map((task) => task.promise)
			.filter((promise): promise is Promise<PlanExecution | undefined> =>
				Boolean(promise),
			);
		await Promise.allSettled(promises);
		activeContext?.ui.setStatus("subagent-tasks", undefined);
		activeContext = undefined;
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Run and manage isolated subagent tasks.",
			"Required actions: block waits, background returns a task ID, list/status inspect current-session tasks, cancel stops one.",
			"Execution modes: single (agent + task), parallel (tasks array), chain (sequential with full {previous} output).",
			"Every subagent contributes at most 50KB to the parent; complete results are written under .pi/subagent-tasks/<sessionId>/<taskId>/.",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const hasExecutionFields =
				params.agent !== undefined ||
				params.task !== undefined ||
				params.tasks !== undefined ||
				params.chain !== undefined ||
				params.cwd !== undefined ||
				params.agentScope !== undefined ||
				params.confirmProjectAgents !== undefined;
			const managementAction =
				params.action === "list" ||
				params.action === "status" ||
				params.action === "cancel";
			if (managementAction && hasExecutionFields) {
				throw new Error(
					`action=${params.action} does not accept agent, task, tasks, chain, cwd, agentScope, or confirmProjectAgents.`,
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
				for (const status of readSessionTaskStatuses(ctx.cwd, sessionId)) {
					if (!tasks.has(status.taskId)) {
						tasks.set(status.taskId, {
							status,
							paths: getTaskPaths(ctx.cwd, sessionId, status.taskId),
							results: [],
						});
					}
				}
				const statuses = Array.from(tasks.values())
					.map((task) => task.status)
					.sort((left, right) => left.createdAt - right.createdAt);
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
					details: makeSubagentDetails("single", "user", null, []),
				};
			}

			if (params.action === "status" || params.action === "cancel") {
				if (!params.taskId) {
					throw new Error(`action=${params.action} requires taskId.`);
				}
				let task = tasks.get(params.taskId);
				if (!task) {
					const stored = readSessionTaskStatuses(ctx.cwd, sessionId).find(
						(status) => status.taskId === params.taskId,
					);
					if (stored) {
						task = {
							status: stored,
							paths: getTaskPaths(ctx.cwd, sessionId, stored.taskId),
							results: [],
						};
						tasks.set(stored.taskId, task);
					}
				}
				if (!task) {
					return {
						content: [
							{
								type: "text",
								text: `Unknown subagent task: ${params.taskId}`,
							},
						],
						details: makeSubagentDetails("single", "user", null, []),
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
							details: makeSubagentDetails(task.status.mode, "user", null, []),
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
						details: makeSubagentDetails(task.status.mode, "user", null, []),
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
					details: makeSubagentDetails(task.status.mode, "user", null, []),
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
					details: makeSubagentDetails(mode, "user", null, []),
				};
			}

			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI
			) {
				const requestedNames = new Set<string>();
				if (params.agent) requestedNames.add(params.agent);
				for (const item of params.tasks ?? []) requestedNames.add(item.agent);
				for (const item of params.chain ?? []) requestedNames.add(item.agent);
				const projectAgents = Array.from(requestedNames)
					.map((name) => agents.find((agent) => agent.name === name))
					.filter((agent): agent is AgentConfig => agent?.source === "project");
				if (projectAgents.length > 0) {
					const approved = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${projectAgents.map((agent) => agent.name).join(", ")}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!approved) {
						return {
							content: [
								{
									type: "text",
									text: "Canceled: project-local agents not approved.",
								},
							],
							details: makeSubagentDetails(
								mode,
								agentScope,
								discovery.projectAgentsDir,
								[],
							),
						};
					}
				}
			}

			const demand = mode === "parallel" ? params.tasks.length : 1;
			let reservation: SchedulerReservation;
			try {
				reservation = getScheduler().reserve(demand);
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: error instanceof Error ? error.message : String(error),
						},
					],
					details: makeSubagentDetails(
						mode,
						agentScope,
						discovery.projectAgentsDir,
						[],
					),
				};
			}

			let task: ManagedSubagentTask;
			try {
				task = createTask(params.action, mode, params, ctx.cwd);
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

			const execution = runManagedTask(
				task,
				params,
				agents,
				agentScope,
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
						...makeSubagentDetails(
							mode,
							agentScope,
							discovery.projectAgentsDir,
							[],
						),
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
						...makeSubagentDetails(
							mode,
							agentScope,
							discovery.projectAgentsDir,
							[],
						),
						taskId: task.status.taskId,
						taskStatus: task.status.status,
						resultPath: task.status.resultPath,
					},
				};
			} finally {
				unlinkParentAbort?.();
			}
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (
				args.action === "list" ||
				args.action === "status" ||
				args.action === "cancel"
			) {
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
						theme.fg("accent", args.action) +
						(args.taskId ? theme.fg("dim", ` ${args.taskId}`) : ""),
					0,
					0,
				);
			}
			const executionLabel = theme.fg("warning", ` ${args.action}`);
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					executionLabel +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview =
						cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					executionLabel +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview =
						t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task
				? args.task.length > 60
					? `${args.task.slice(0, 60)}...`
					: args.task
				: "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				executionLabel +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(
					text?.type === "text" ? text.text : "(no output)",
					0,
					0,
				);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped =
					limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0)
					text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded
							? item.text
							: item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError
					? theme.fg("error", "✗")
					: theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource}; ${formatExtensionPolicy(r.extensionMode, r.extensionSources)})`)}`;
					if (isError && r.stopReason)
						header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (r.extensionMode === "isolated" && r.extensionSources.length > 0)
						container.addChild(
							new Text(
								theme.fg(
									"dim",
									formatExtensionPolicy(
										r.extensionMode,
										r.extensionSources,
										true,
									),
								),
								0,
								0,
							),
						);
					if (isError && r.errorMessage)
						container.addChild(
							new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
						);
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(theme.fg("muted", "─── Output ───"), 0, 0),
					);
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(
							new Text(theme.fg("muted", "(no output)"), 0, 0),
						);
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(
												item.name,
												item.args,
												theme.fg.bind(theme),
											),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(
								new Markdown(finalOutput.trim(), 0, 0, mdTheme),
							);
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource}; ${formatExtensionPolicy(r.extensionMode, r.extensionSources)})`)}`;
				if (isError && r.stopReason)
					text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage)
					text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0)
					text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT)
						text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turns: 0,
				};
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter(
					(r) => r.exitCode === 0,
				).length;
				const icon =
					successCount === details.results.length
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg(
									"accent",
									`${successCount}/${details.results.length} steps`,
								),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon =
							r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(
							new Text(
								theme.fg("muted", "Task: ") + theme.fg("dim", r.task),
								0,
								0,
							),
						);
						container.addChild(
							new Text(
								theme.fg(
									"dim",
									formatExtensionPolicy(
										r.extensionMode,
										r.extensionSources,
										true,
									),
								),
								0,
								0,
							),
						);

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(
												item.name,
												item.args,
												theme.fg.bind(theme),
											),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(
								new Markdown(finalOutput.trim(), 0, 0, mdTheme),
							);
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage)
							container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0),
						);
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon =
						r.exitCode === 0
							? theme.fg("success", "✓")
							: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}${theme.fg("dim", ` [${formatExtensionPolicy(r.extensionMode, r.extensionSources)}]`)}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter(
					(r) => r.exitCode !== -1 && !isFailedResult(r),
				).length;
				const failCount = details.results.filter(
					(r) => r.exitCode !== -1 && isFailedResult(r),
				).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r)
							? theme.fg("error", "✗")
							: theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(
							new Text(
								theme.fg("muted", "Task: ") + theme.fg("dim", r.task),
								0,
								0,
							),
						);
						container.addChild(
							new Text(
								theme.fg(
									"dim",
									formatExtensionPolicy(
										r.extensionMode,
										r.extensionSources,
										true,
									),
								),
								0,
								0,
							),
						);

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(
												item.name,
												item.args,
												theme.fg.bind(theme),
											),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(
								new Markdown(finalOutput.trim(), 0, 0, mdTheme),
							);
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage)
							container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0),
						);
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text +=
						`\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}` +
						theme.fg(
							"dim",
							` [${formatExtensionPolicy(r.extensionMode, r.extensionSources)}]`,
						);
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
