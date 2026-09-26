import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import type { BackgroundJobs } from "./background.ts";
import { preview, truncateBytes } from "./format.ts";
import { readDetails, type PendingTask, type SubagentDetails, toolBodyComponent, toolCallComponent } from "./render.ts";
import { CHILD_ENV, type DispatchDefaults, runAgent } from "./runner.ts";
import { parentSessionDir, type ReservedRun, releaseRun, reserveRun, shortRunId } from "./store.ts";
import { type GroupKind, LiveRun, newSnapshot, type RunMode, type RunRegistry, type RunSnapshot } from "./runs.ts";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const UPDATE_INTERVAL_MS = 100;

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

export const SubagentParams = Type.Object({
	async: Type.Optional(Type.Boolean({ description: "Return immediately; deliver the result via steer when done. Default: false.", default: false })),
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

type Result = AgentToolResult<SubagentDetails> & { isError?: boolean; cancelled?: boolean };

export async function mapWithConcurrencyLimit<TIn, TOut>(items: TIn[], concurrency: number, fn: (item: TIn, index: number) => Promise<TOut>): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current]!, current);
		}
	});
	const settled = await Promise.allSettled(workers);
	const failed = settled.find((result) => result.status === "rejected");
	if (failed?.status === "rejected") throw failed.reason;
	return results;
}

/** Plain copy for tool details; live runs keep mutating their own snapshot. */
function copy(snapshot: RunSnapshot): RunSnapshot {
	return { ...snapshot, usage: { ...snapshot.usage }, toolCalls: [...snapshot.toolCalls], group: { ...snapshot.group } };
}

/** How a task starts when it is dispatched: chain steps and parallel tasks beyond the concurrency limit wait. */
export function initialStatus(kind: GroupKind, index: number): "running" | "queued" {
	if (kind === "chain") return index === 0 ? "running" : "queued";
	if (kind === "parallel") return index < MAX_CONCURRENCY ? "running" : "queued";
	return "running";
}

/** Status words the main agent sees in dispatch results, notices, and final answers. */
export function modelStatus(status: RunSnapshot["status"] | "not started"): string {
	return status === "cancelled" ? "stopped" : status;
}

/** `Transcripts:` lines appended to foreground results, one per run that started. */
function transcriptLines(runs: RunSnapshot[]): string {
	const lines = runs.filter((run) => run.sessionFile).map((run) => `${shortRunId(run.id)} ${run.agent} ${run.sessionFile}`);
	return lines.length ? `\n\nTranscripts:\n${lines.join("\n")}` : "";
}

const FINAL_ANSWER_CAP = 16 * 1024;

/** A background job's final message body: every task's status and answer, in task order. */
export function finalAnswers(runs: RunSnapshot[], requested: Array<{ agent: string }>, reserved: ReservedRun[]): string {
	return requested
		.map((item, index) => {
			const id = shortRunId(reserved[index]!.id);
			const run = runs.find((r) => r.group.index === index);
			if (!run) return `<subagent_result run="${id}" agent="${item.agent}" status="not started"/>`;
			const answer = truncateBytes(run.output || "(no output)", FINAL_ANSWER_CAP, `The full text is in ${run.sessionFile ?? "the transcript"}.`);
			return `<subagent_result run="${id}" agent="${run.agent}" status="${modelStatus(run.status)}">\n${answer}\n</subagent_result>`;
		})
		.join("\n");
}

function statusWord(run: RunSnapshot): string {
	if (run.status === "failed") return `failed${run.stopReason && run.stopReason !== "stop" ? ` (${run.stopReason})` : ""}`;
	return run.status === "cancelled" ? "stopped" : "completed";
}

interface Throttle {
	call(): void;
	cancel(): void;
}

function throttle(fn: () => void, ms: number): Throttle {
	let last = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		call() {
			const now = Date.now();
			if (now - last >= ms) {
				last = now;
				fn();
			} else if (!timer) {
				timer = setTimeout(() => {
					timer = undefined;
					last = Date.now();
					fn();
				}, ms - (now - last));
			}
		},
		cancel() {
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}

function agentNames(agents: AgentConfig[]): string {
	return agents.map((a) => `"${a.name}"`).join(", ") || "none";
}

// The model only knows the agent names this description gives it. It is read
// when the tool is registered, so new agent files need /reload.
export function toolDescription(userAgents: AgentConfig[]): string {
	const catalog = userAgents.length
		? `User agents (use these exact names): ${userAgents.map((a) => `${a.name} — ${preview(a.description, 120)}`).join("; ")}.`
		: "No user agents are installed.";
	return [
		"Delegate scoped tasks to subagents with isolated context. For async work, do not duplicate it: continue independent work or end your turn; results arrive automatically.",
		"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
		catalog,
		`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
		`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		"Results name each run's ID and session JSONL file; read the file to see what the subagent did.",
		"Use subagent_control to send a run a message (steer, interrupt, or continue it) or stop it.",
	].join(" ");
}

export function registerSubagentTool(pi: ExtensionAPI, registry: RunRegistry, background: BackgroundJobs): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: toolDescription(discoverAgents(process.cwd(), "user").agents),
		parameters: SubagentParams,
		renderShell: "self",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const defaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const mode: GroupKind = hasChain ? "chain" : hasTasks ? "parallel" : "single";
			const details = (runs: RunSnapshot[], pending: PendingTask[] = [], extra: Partial<SubagentDetails> = {}): SubagentDetails => ({
				version: 2,
				mode,
				agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				runs,
				pending,
				...extra,
			});

			if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return { content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` }], details: details([]) };
			}

			const requested = hasChain ? params.chain! : hasTasks ? params.tasks! : [{ agent: params.agent!, task: params.task!, cwd: params.cwd }];
			if ((agentScope === "project" || agentScope === "both") && (params.confirmProjectAgents ?? true) && ctx.hasUI) {
				const projectAgents = [...new Set(requested.map((item) => item.agent))]
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");
				if (projectAgents.length > 0) {
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${projectAgents.map((a) => a.name).join(", ")}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) return { content: [{ type: "text", text: "Canceled: project-local agents not approved." }], details: details([]) };
				}
			}

			const unknown = requested.find((item) => !agents.some((agent) => agent.name === item.agent));
			if (unknown) throw new Error(`Unknown agent: "${unknown.agent}". Available agents: ${agentNames(agents)}.`);
			if (params.tasks && params.tasks.length > MAX_PARALLEL_TASKS) throw new Error(`Too many parallel tasks. Max is ${MAX_PARALLEL_TASKS}.`);
			signal?.throwIfAborted();
			if (params.async && (ctx.mode === "print" || ctx.mode === "json")) {
				throw new Error("Async subagents require TUI or RPC mode. Use async: false in single-shot print/JSON mode.");
			}
			// A subagent's own RPC session ends when its task settles, so it could not receive a background result.
			if (params.async && process.env[CHILD_ENV]) {
				throw new Error("Async subagents are not available inside a subagent. Use async: false.");
			}

			const parentSessionId = ctx.sessionManager.getSessionId();
			const agentFor = (name: string) => agents.find((a) => a.name === name)!;
			// IDs and session files exist before any child starts, so the result can name them.
			const sessionDir = parentSessionDir(parentSessionId);
			const reserved = requested.map(() => reserveRun(sessionDir));
			requested.forEach((item, index) => registry.expect({ id: reserved[index]!.id, agent: item.agent, parentSessionId }));
			const ids = { runIds: reserved.map((r) => shortRunId(r.id)), sessionFiles: reserved.map((r) => r.sessionFile) };

			const run = async (runSignal: AbortSignal | undefined, update: typeof onUpdate, runMode: RunMode, jobId?: string): Promise<Result> => {
				const live: LiveRun[] = [];
				const started = new Set<number>();
				let pending: PendingTask[] = requested.map((item, index) => ({ agent: item.agent, task: item.task, index }));
				const snapshot = () => live.map((r) => copy(r.snapshot)).sort((a, b) => a.group.index - b.group.index);
				const emit = throttle(() => {
					const runs = snapshot();
					const text = mode === "single" ? runs[0]?.output || "(running...)" : `${mode}: ${runs.filter((r) => r.status !== "running").length}/${requested.length} done`;
					update?.({ content: [{ type: "text", text }], details: details(runs, pending, ids) });
				}, UPDATE_INTERVAL_MS);
				const start = async (item: { agent: string; task: string; cwd?: string }, index: number): Promise<RunSnapshot> => {
					pending = pending.filter((p) => p.index !== index);
					if (registry.takeStartDecision(reserved[index]!.id)) {
						// subagent_control stopped it while it waited; it never starts.
						const skipped = newSnapshot({ id: reserved[index]!.id, parentSessionId, agent: item.agent, agentSource: agentFor(item.agent).source, task: item.task, cwd: item.cwd ?? ctx.cwd, mode: runMode, group: { kind: mode, index, total: requested.length }, sessionDir, jobId });
						Object.assign(skipped, { status: "cancelled", endedAt: skipped.startedAt, output: "Stopped by the main agent before it started." });
						const stopped = new LiveRun(skipped);
						live.push(stopped);
						emit.call();
						return copy(skipped);
					}
					started.add(index);
					const liveRun = await runAgent({
						agent: agentFor(item.agent),
						task: item.task,
						cwd: item.cwd ?? ctx.cwd,
						defaults,
						mode: runMode,
						group: { kind: mode, index, total: requested.length },
						parentSessionId,
						jobId,
						signal: runSignal,
						registry,
						reserved: reserved[index],
						onChange: (r) => {
							if (!live.includes(r)) live.push(r);
							emit.call();
						},
					});
					emit.call();
					return copy(liveRun.snapshot);
				};

				try {
					if (mode === "chain") {
						let previous = "";
						for (let i = 0; i < requested.length; i++) {
							const step = requested[i]!;
							const result = await start({ ...step, task: step.task.replace(/\{previous\}/g, previous) }, i);
							if (result.status !== "completed") {
								pending = [];
								const verb = result.status === "cancelled" ? "was stopped" : "failed";
								const text = runMode === "async"
									? finalAnswers(snapshot(), requested, reserved)
									: `Chain stopped at step ${i + 1} (${step.agent}) because it ${verb}: ${result.output ?? "(no output)"}${transcriptLines(snapshot())}`;
								return { content: [{ type: "text", text }], details: details(snapshot(), [], ids), isError: true, cancelled: result.status === "cancelled" };
							}
							previous = result.output ?? "";
						}
						const runs = snapshot();
						const text = runMode === "async" ? finalAnswers(runs, requested, reserved) : `${runs[runs.length - 1]?.output || "(no output)"}${transcriptLines(runs)}`;
						return { content: [{ type: "text", text }], details: details(runs, [], ids) };
					}

					if (mode === "parallel") {
						const results = await mapWithConcurrencyLimit(requested, MAX_CONCURRENCY, (item, index) => start(item, index));
						const ok = results.filter((r) => r.status === "completed").length;
						const summaries = results.map((r) => `### [${r.agent}] ${statusWord(r)}\n\n${truncateBytes(r.output || "(no output)", PER_TASK_OUTPUT_CAP)}`);
						const text = runMode === "async"
							? finalAnswers(snapshot(), requested, reserved)
							: `Parallel: ${ok}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}${transcriptLines(snapshot())}`;
						return {
							content: [{ type: "text", text }],
							details: details(snapshot(), [], ids),
							isError: ok !== results.length,
							cancelled: results.every((r) => r.status === "cancelled"),
						};
					}

					const result = await start(requested[0]!, 0);
					const transcripts = transcriptLines(snapshot());
					if (runMode === "async") {
						return {
							content: [{ type: "text", text: finalAnswers(snapshot(), requested, reserved) }],
							details: details(snapshot(), [], ids),
							isError: result.status !== "completed",
							cancelled: result.status === "cancelled",
						};
					}
					if (result.status === "cancelled") {
						return {
							content: [{ type: "text", text: `Subagent ${result.agent} was stopped by the user before it finished. Its partial work may already be on disk; do not assume the task is done.${transcripts}` }],
							details: details(snapshot(), [], ids),
							isError: true,
							cancelled: true,
						};
					}
					if (result.status === "failed") {
						return { content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${result.output ?? "(no output)"}${transcripts}` }], details: details(snapshot(), [], ids), isError: true };
					}
					return { content: [{ type: "text", text: `${result.output || "(no output)"}${transcripts}` }], details: details(snapshot(), [], ids) };
				} finally {
					emit.cancel();
					// Tasks that never started (a stopped chain, an aborted job) leave no empty files behind.
					reserved.forEach((r, index) => {
						if (started.has(index)) return;
						releaseRun(r);
						registry.takeStartDecision(r.id);
					});
				}
			};

			if (!params.async) return run(signal, onUpdate, "sync");
			const label = requested.map((item) => `${item.agent}: ${preview(item.task, 200)}`).join("; ");
			let jobId = "";
			try {
				jobId = background.start(ctx, label, (backgroundSignal) => run(backgroundSignal, undefined, "async", jobId));
			} catch (error) {
				for (const r of reserved) {
					releaseRun(r);
					registry.takeStartDecision(r.id);
				}
				throw error;
			}
			const lines = requested.map((item, index) => `${ids.runIds[index]} ${item.agent} ${initialStatus(mode, index)} ${ids.sessionFiles[index]}`);
			return {
				content: [{ type: "text", text: [
					`Started background job ${jobId}. State changes arrive as <subagent_notification> messages and the final answers when the job ends; do not repeat or poll this work.`,
					...lines,
				].join("\n") }],
				details: details([], requested.map((item, index) => ({ agent: item.agent, task: item.task, index })), { async: true, jobId, dispatched: true, ...ids }),
			};
		},

		renderCall(args, theme, context) {
			const state = context.state as { args?: unknown; details?: SubagentDetails };
			state.args = args;
			return toolCallComponent(theme, () => (state.args ?? {}) as never, () => state.details);
		},

		renderResult(result, { expanded }, theme, context) {
			const state = context.state as { details?: SubagentDetails };
			state.details = readDetails(result.details);
			const first = result.content[0];
			return toolBodyComponent(theme, state.details, expanded, first?.type === "text" ? first.text : "");
		},
	});
}

export type { Result as SubagentResult };
