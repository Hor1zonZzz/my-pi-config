// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import { truncateSubagentOutput } from "./output.ts";
import {
	RpcProcessClient,
	type RpcGenerationActivity,
	type RpcProcessOptions,
	RpcResponseError,
} from "./rpc-client.ts";
import type { ScheduleHooks, SchedulerReservation } from "./scheduler.ts";

const PERSISTENT_STDERR_CAP_BYTES = 64 * 1024;
const PERSISTENT_STDERR_CAP_LINES = 2_000;
const RETAINED_GENERATIONS = 3;
export const MAX_TERMINAL_JOB_HISTORY = 100;
const QUEUED_MESSAGE_WAKE_PROMPT =
	"Continue now and process the steering or follow-up instruction that was just queued.";

export type PersistentJobStatus =
	| "starting"
	| "running"
	| "idle"
	| "stopping"
	| "stopped"
	| "failed";

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface PersistentStartRequest {
	agent: AgentConfig;
	task: string;
	cwd?: string;
	defaultCwd: string;
}

export interface PersistentCompletion {
	jobId: string;
	agent: string;
	task: string;
	generation: number;
	status: "completed" | "failed";
	output: string;
}

export interface PersistentJobSnapshot {
	id: string;
	agent: string;
	task: string;
	status: PersistentJobStatus;
	generation: number;
	settledGeneration: number;
	createdAt: string;
	updatedAt: string;
	model?: string;
	usage: UsageStats;
	messageCount: number;
	output: string;
	stderr: string;
}

interface GenerationWaiter {
	generation: number;
	finish: (error?: Error) => void;
}

export interface PreparedSystemPrompt {
	filePath: string;
	cleanup: () => Promise<void>;
}

interface PersistentRpcClient {
	readonly exited: Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
		error?: Error;
	}>;
	readonly isExited: boolean;
	getRunState(): {
		running: boolean;
		issuedGeneration: number;
		startedGeneration: number;
		settledGeneration: number;
	};
	waitForGenerationActivity(
		generation: number,
		timeoutMs?: number,
		signal?: AbortSignal,
	): Promise<RpcGenerationActivity>;
	send(
		command: Record<string, unknown>,
		timeoutMs?: number,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>>;
	terminate(): Promise<void>;
}

interface PersistentJob {
	id: string;
	agent: AgentConfig;
	task: string;
	status: PersistentJobStatus;
	createdAt: number;
	updatedAt: number;
	client?: PersistentRpcClient;
	usage: UsageStats;
	stderr: string;
	model?: string;
	messageCount: number;
	generation: number;
	settledGeneration: number;
	currentOutput: string;
	currentStopReason?: string;
	currentError?: string;
	generationOutputs: Map<number, string>;
	generationFailures: Map<number, string>;
	waiters: Set<GenerationWaiter>;
	waitClaims: Map<number, number>;
	reportedGenerations: Set<number>;
	suppressedGenerations: Set<number>;
	handledGenerations: Set<number>;
	pendingReports: Set<number>;
	autoReportEnabled: boolean;
	stopRequested: boolean;
	unexpectedExitReported: boolean;
	operationTail: Promise<void>;
	startupController: AbortController;
	unlinkStartupSignal?: () => void;
	lifetime?: Promise<unknown>;
}

interface LaunchHandle {
	job: PersistentJob;
	started: Promise<PersistentJob>;
}

export interface PersistentJobManagerOptions {
	onChanged: () => void;
	onCompletion: (completion: PersistentCompletion) => void;
	/** Deterministic smoke-test seam; production uses the secure temp-file writer. */
	preparePrompt?: (
		agentName: string,
		prompt: string,
		signal: AbortSignal,
	) => Promise<PreparedSystemPrompt>;
	/** Deterministic barrier immediately before child-client construction. */
	beforeClientCreate?: (signal: AbortSignal) => Promise<void>;
	/** Deterministic smoke-test seam; production uses RpcProcessClient. */
	createClient?: (options: RpcProcessOptions) => PersistentRpcClient;
}

function emptyUsage(): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

function isTerminal(status: PersistentJobStatus): boolean {
	return status === "stopped" || status === "failed";
}

function abortError(
	message = "Persistent subagent startup was cancelled",
): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortError();
}

function waitAbortable<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	throwIfAborted(signal);
	return new Promise<T>((resolve, reject) => {
		let finished = false;
		const finish = (value?: T, error?: unknown) => {
			if (finished) return;
			finished = true;
			signal.removeEventListener("abort", abort);
			if (error !== undefined) reject(error);
			else resolve(value as T);
		};
		const abort = () => finish(undefined, abortError());
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => finish(value),
			(error) => finish(undefined, error),
		);
	});
}

async function prepareSystemPrompt(
	agentName: string,
	prompt: string,
	signal: AbortSignal,
): Promise<PreparedSystemPrompt> {
	throwIfAborted(signal);
	const directory = await mkdtemp(join(tmpdir(), "pi-subagent-rpc-"));
	let cleaned = false;
	const cleanup = async () => {
		if (cleaned) return;
		cleaned = true;
		await rm(directory, { recursive: true, force: true });
	};
	try {
		throwIfAborted(signal);
		await chmod(directory, 0o700);
		const safeName = agentName.replace(/[^\w.-]+/g, "_");
		const filePath = join(directory, `prompt-${safeName}.md`);
		await writeFile(filePath, prompt, {
			encoding: "utf8",
			mode: 0o600,
			signal,
		});
		await chmod(filePath, 0o600);
		throwIfAborted(signal);
		return { filePath, cleanup };
	} catch (error) {
		await cleanup();
		throw error;
	}
}

function boundedTail(text: string): string {
	let lines = text.split("\n");
	if (lines.length > PERSISTENT_STDERR_CAP_LINES) {
		lines = lines.slice(-PERSISTENT_STDERR_CAP_LINES);
	}
	let result = lines.join("\n");
	if (Buffer.byteLength(result, "utf8") <= PERSISTENT_STDERR_CAP_BYTES) {
		return result;
	}
	const buffer = Buffer.from(result, "utf8");
	result = buffer
		.subarray(buffer.length - PERSISTENT_STDERR_CAP_BYTES)
		.toString("utf8");
	if (result.startsWith("�")) result = result.slice(1);
	return result;
}

function appendStderr(job: PersistentJob, text: string): void {
	job.stderr = boundedTail(job.stderr + text);
	job.updatedAt = Date.now();
}

function getAssistantText(message: Message): string {
	if (message.role !== "assistant") return "";
	const textParts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") textParts.push(part.text);
	}
	return textParts.join("\n");
}

export class PersistentJobManager {
	private readonly jobs = new Map<string, PersistentJob>();
	private readonly options: PersistentJobManagerOptions;
	private shuttingDown = false;

	constructor(options: PersistentJobManagerOptions) {
		this.options = options;
	}

	get activeCount(): number {
		return this.busyCount;
	}

	get liveCount(): number {
		let count = 0;
		for (const job of this.jobs.values()) {
			if (!isTerminal(job.status) || (job.client && !job.client.isExited)) {
				count += 1;
			}
		}
		return count;
	}

	get busyCount(): number {
		let count = 0;
		for (const job of this.jobs.values()) {
			if (
				job.status === "starting" ||
				job.status === "running" ||
				job.status === "stopping"
			) {
				count += 1;
			}
		}
		return count;
	}

	list(includeOutput = false): PersistentJobSnapshot[] {
		return Array.from(this.jobs.values())
			.sort((left, right) => left.createdAt - right.createdAt)
			.map((job) => this.snapshotJob(job, includeOutput));
	}

	get(jobId: string, includeOutput = true): PersistentJobSnapshot {
		return this.snapshotJob(this.requireJob(jobId), includeOutput);
	}

	async startMany(
		requests: PersistentStartRequest[],
		reservation: SchedulerReservation,
		createHooks?: () => ScheduleHooks,
		signal?: AbortSignal,
	): Promise<PersistentJobSnapshot[]> {
		if (this.shuttingDown) {
			reservation.release();
			throw new Error("Persistent subagents are shutting down");
		}
		const startupController = new AbortController();
		const abortAll = () => startupController.abort();
		if (signal?.aborted) abortAll();
		else signal?.addEventListener("abort", abortAll, { once: true });

		const launches = requests.map((request) =>
			this.launchScheduled(
				request,
				reservation,
				createHooks?.(),
				startupController.signal,
			),
		);
		reservation.release();

		try {
			const settled = await Promise.allSettled(
				launches.map((launch) => launch.started),
			);
			const failures = settled.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			);
			if (signal?.aborted && failures.length === 0) {
				failures.push(abortError());
			}
			if (failures.length > 0) {
				startupController.abort();
				await Promise.allSettled(
					launches.map((launch) => this.stopForFailedBatch(launch.job)),
				);
				await Promise.allSettled(
					launches
						.map((launch) => launch.job.lifetime)
						.filter((promise): promise is Promise<unknown> => Boolean(promise)),
				);
				const details = failures
					.map((failure) =>
						failure instanceof Error ? failure.message : String(failure),
					)
					.join("; ");
				if (signal?.aborted) throw abortError(details || undefined);
				throw new Error(
					`Failed to start persistent subagent job(s): ${details}`,
				);
			}

			// Parallel startup is an ACK/activity barrier: no child may auto-report
			// until every prompt is acknowledged and classified as started, settled,
			// or explicitly handled without an agent run.
			for (const launch of launches) launch.job.autoReportEnabled = true;
			for (const launch of launches) this.flushPendingReports(launch.job);
			this.changed();
			return launches.map((launch) => this.snapshotJob(launch.job, false));
		} finally {
			signal?.removeEventListener("abort", abortAll);
		}
	}

	async send(
		jobId: string,
		message: string,
		delivery: "steer" | "followUp",
		signal?: AbortSignal,
	): Promise<PersistentJobSnapshot> {
		if (!message.trim()) {
			throw new Error("subagent_control send requires a non-empty message");
		}
		const job = this.requireJob(jobId);
		await this.withOperation(job, async () => {
			if (job.stopRequested || isTerminal(job.status) || !job.client) {
				throw new Error(`Persistent subagent ${job.id} is not running`);
			}
			const client = job.client;
			if (!client.getRunState().running) {
				await this.sendNewGeneration(job, message, signal);
				return;
			}

			job.status = "running";
			job.updatedAt = Date.now();
			this.changed();
			try {
				await client.send(
					{
						type: delivery === "followUp" ? "follow_up" : "steer",
						message,
					},
					undefined,
					signal,
				);
				const targetGeneration = client.getRunState().issuedGeneration;
				const activity = await client.waitForGenerationActivity(
					targetGeneration,
					undefined,
					signal,
				);
				if (
					activity.kind === "handled-without-agent" &&
					job.settledGeneration < job.generation
				) {
					this.settleHandledGeneration(job, job.generation);
				}
			} catch (error) {
				// Settlement can win the race between our state read and Pi handling the
				// steer/follow_up command. A definitive idle rejection is safely retried
				// as a fresh prompt; transport timeouts are ambiguous and fail the job.
				if (
					error instanceof RpcResponseError &&
					error.kind === "response" &&
					!client.getRunState().running &&
					!client.isExited
				) {
					await this.sendNewGeneration(job, message, signal);
					return;
				}
				await this.failAmbiguousCommand(job, error);
				throw error;
			}
			if (job.status === "failed") {
				throw new Error(
					`Persistent subagent ${job.id} failed while accepting the message`,
				);
			}
			if (!client.getRunState().running && !client.isExited) {
				// Pi may accept a steer/follow_up just after the prior run settles. The
				// instruction is then queued but no turn is active to drain it. Start a
				// generation with a neutral wake prompt rather than duplicating the
				// already queued user instruction.
				await this.sendNewGeneration(job, QUEUED_MESSAGE_WAKE_PROMPT, signal);
			}
		});
		return this.snapshotJob(job, false);
	}

	async wait(
		jobId: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<PersistentJobSnapshot> {
		const job = this.requireJob(jobId);
		if (job.status === "idle" || isTerminal(job.status)) {
			return this.snapshotJob(job, true);
		}
		const targetGeneration = job.generation;
		job.waitClaims.set(
			targetGeneration,
			(job.waitClaims.get(targetGeneration) ?? 0) + 1,
		);
		try {
			await new Promise<void>((resolve, reject) => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				let finished = false;
				const waiter: GenerationWaiter = {
					generation: targetGeneration,
					finish: (error) => {
						if (finished) return;
						finished = true;
						if (timer) clearTimeout(timer);
						job.waiters.delete(waiter);
						signal?.removeEventListener("abort", abort);
						if (error) reject(error);
						else resolve();
					},
				};
				const abort = () => {
					const error = new Error(
						`Stopped waiting for persistent subagent ${job.id}`,
					);
					error.name = "AbortError";
					waiter.finish(error);
				};
				job.waiters.add(waiter);
				if (timeoutMs > 0) {
					timer = setTimeout(
						() =>
							waiter.finish(
								new Error(
									`Timed out waiting for persistent subagent ${job.id}`,
								),
							),
						timeoutMs,
					);
				}
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			});
		} finally {
			const remaining = (job.waitClaims.get(targetGeneration) ?? 1) - 1;
			if (remaining > 0) job.waitClaims.set(targetGeneration, remaining);
			else job.waitClaims.delete(targetGeneration);
		}
		return this.snapshotJob(job, true);
	}

	async stop(jobId: string): Promise<PersistentJobSnapshot> {
		const job = this.requireJob(jobId);
		await this.withOperation(job, async () => {
			if (job.status === "stopped" && (!job.client || job.client.isExited)) {
				return;
			}
			await this.requestStop(job);
		});
		if (job.lifetime) await job.lifetime.catch(() => undefined);
		job.status = "stopped";
		job.updatedAt = Date.now();
		this.finishWaiters(job);
		this.changed();
		return this.snapshotJob(job, true);
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		const live = Array.from(this.jobs.values()).filter(
			(job) => !isTerminal(job.status) || !job.client?.isExited,
		);
		await Promise.allSettled(live.map((job) => this.stop(job.id)));
		await Promise.allSettled(
			Array.from(this.jobs.values())
				.map((job) => job.lifetime)
				.filter((promise): promise is Promise<unknown> => Boolean(promise)),
		);
	}

	private launchScheduled(
		request: PersistentStartRequest,
		reservation: SchedulerReservation,
		hooks: ScheduleHooks,
		startupSignal: AbortSignal,
	): LaunchHandle {
		const now = Date.now();
		const startupController = new AbortController();
		const propagateAbort = () => startupController.abort();
		if (startupSignal.aborted) propagateAbort();
		else
			startupSignal.addEventListener("abort", propagateAbort, { once: true });
		const job: PersistentJob = {
			id: `job_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
			agent: request.agent,
			task: request.task,
			status: "starting",
			createdAt: now,
			updatedAt: now,
			usage: emptyUsage(),
			stderr: "",
			model: request.agent.model,
			messageCount: 0,
			generation: 1,
			settledGeneration: 0,
			currentOutput: "",
			generationOutputs: new Map(),
			generationFailures: new Map(),
			waiters: new Set(),
			waitClaims: new Map(),
			reportedGenerations: new Set(),
			suppressedGenerations: new Set(),
			handledGenerations: new Set(),
			pendingReports: new Set(),
			autoReportEnabled: false,
			stopRequested: false,
			unexpectedExitReported: false,
			operationTail: Promise.resolve(),
			startupController,
			unlinkStartupSignal: () =>
				startupSignal.removeEventListener("abort", propagateAbort),
		};
		this.jobs.set(job.id, job);
		this.changed();

		let resolveStarted!: (job: PersistentJob) => void;
		let rejectStarted!: (error: Error) => void;
		let startSettled = false;
		const started = new Promise<PersistentJob>((resolve, reject) => {
			resolveStarted = resolve;
			rejectStarted = reject;
		});
		const resolveStart = () => {
			if (startSettled) return;
			startSettled = true;
			resolveStarted(job);
		};
		const rejectStart = (error: unknown) => {
			if (startSettled) return;
			startSettled = true;
			rejectStarted(error instanceof Error ? error : new Error(String(error)));
		};

		job.lifetime = reservation
			.run(
				startupController.signal,
				async () => {
					let preparedPrompt: PreparedSystemPrompt | undefined;
					try {
						throwIfAborted(startupController.signal);
						const args = ["--mode", "rpc", "--no-session"];
						if (request.agent.extensionMode === "isolated") {
							args.push("--no-extensions");
							for (const source of request.agent.extensionSources) {
								args.push("--extension", source);
							}
						}
						if (request.agent.model) args.push("--model", request.agent.model);
						if (request.agent.tools?.length) {
							args.push("--tools", request.agent.tools.join(","));
						}
						if (request.agent.systemPrompt.trim()) {
							const prepare = this.options.preparePrompt ?? prepareSystemPrompt;
							preparedPrompt = await prepare(
								request.agent.name,
								request.agent.systemPrompt,
								startupController.signal,
							);
							throwIfAborted(startupController.signal);
							args.push("--append-system-prompt", preparedPrompt.filePath);
						}
						if (this.options.beforeClientCreate) {
							await waitAbortable(
								this.options.beforeClientCreate(startupController.signal),
								startupController.signal,
							);
						}
						throwIfAborted(startupController.signal);

						const createClient =
							this.options.createClient ??
							((options: RpcProcessOptions) => new RpcProcessClient(options));
						const client = createClient({
							args,
							cwd: request.cwd ?? request.defaultCwd,
							onEvent: (event) => this.handleEvent(job, event),
							onStderr: (text) => appendStderr(job, text),
							onProtocolError: (error) => this.handleProtocolError(job, error),
						});
						job.client = client;
						if (job.stopRequested || startupController.signal.aborted) {
							await client.terminate();
							throw abortError();
						}
						job.status = "running";
						job.updatedAt = Date.now();
						this.changed();
						await client.send(
							{ type: "prompt", message: `Task: ${request.task}` },
							undefined,
							startupController.signal,
						);
						throwIfAborted(startupController.signal);
						const generation = client.getRunState().issuedGeneration;
						const activity = await client.waitForGenerationActivity(
							generation,
							undefined,
							startupController.signal,
						);
						if (activity.kind === "handled-without-agent") {
							this.settleHandledGeneration(job, job.generation);
						}
						resolveStart();

						const exit = await client.exited;
						if (!job.stopRequested) this.handleUnexpectedExit(job, exit);
					} catch (error) {
						rejectStart(error);
						if (!job.stopRequested) {
							const detail =
								error instanceof Error ? error.message : String(error);
							appendStderr(job, `${detail}\n`);
							if (job.generation > job.settledGeneration) {
								this.settleGeneration(job, true, detail);
							} else {
								job.status = "failed";
							}
						}
						if (job.client && !job.client.isExited) {
							await job.client.terminate();
						}
					} finally {
						if (preparedPrompt) {
							try {
								await preparedPrompt.cleanup();
							} catch (error) {
								appendStderr(
									job,
									`Failed to clean temporary system prompt: ${error instanceof Error ? error.message : String(error)}\n`,
								);
							}
						}
						job.unlinkStartupSignal?.();
						job.unlinkStartupSignal = undefined;
						if (job.stopRequested) job.status = "stopped";
						job.updatedAt = Date.now();
						this.finishWaiters(job);
						this.changed();
					}
				},
				hooks,
			)
			.catch((error) => {
				rejectStart(error);
				job.unlinkStartupSignal?.();
				job.unlinkStartupSignal = undefined;
				if (job.stopRequested || startupController.signal.aborted) {
					job.status = "stopped";
				} else {
					const detail = error instanceof Error ? error.message : String(error);
					appendStderr(job, `${detail}\n`);
					job.status = "failed";
				}
				job.updatedAt = Date.now();
				this.finishWaiters(job);
				this.changed();
			});
		return { job, started };
	}

	private handleEvent(
		job: PersistentJob,
		event: Record<string, unknown>,
	): void {
		job.updatedAt = Date.now();
		if (event.type === "agent_start") {
			// A delayed start after the short handled-without-agent window is a real
			// new generation, not a reason to resurrect the settled handled one.
			if (job.generation <= job.settledGeneration) this.beginGeneration(job);
			if (!job.stopRequested) job.status = "running";
			this.changed();
			return;
		}
		if (event.type === "message_end" && event.message) {
			const message = event.message as Message;
			job.messageCount += 1;
			if (message.role === "assistant") {
				job.usage.turns += 1;
				const output = getAssistantText(message);
				if (output) job.currentOutput = truncateSubagentOutput(output);
				job.currentStopReason = message.stopReason;
				job.currentError = message.errorMessage;
				const usage = message.usage;
				if (usage) {
					job.usage.input += usage.input || 0;
					job.usage.output += usage.output || 0;
					job.usage.cacheRead += usage.cacheRead || 0;
					job.usage.cacheWrite += usage.cacheWrite || 0;
					job.usage.cost += usage.cost?.total || 0;
					job.usage.contextTokens = usage.totalTokens || 0;
				}
				if (!job.model && message.model) job.model = message.model;
			}
			return;
		}
		if (event.type === "extension_error") {
			appendStderr(job, `${String(event.error ?? "Extension error")}\n`);
			return;
		}
		if (event.type === "agent_settled") {
			const failed =
				job.currentStopReason === "error" ||
				job.currentStopReason === "aborted";
			this.settleGeneration(job, failed, failed ? job.currentError : undefined);
			if (failed && job.client && !job.client.isExited) {
				job.unexpectedExitReported = true;
				void job.client.terminate();
			}
		}
	}

	private handleProtocolError(job: PersistentJob, error: Error): void {
		if (job.stopRequested || job.unexpectedExitReported) return;
		job.unexpectedExitReported = true;
		if (job.generation <= job.settledGeneration) this.beginGeneration(job);
		this.settleGeneration(job, true, error.message);
	}

	private handleUnexpectedExit(
		job: PersistentJob,
		exit: {
			code: number | null;
			signal: NodeJS.Signals | null;
			error?: Error;
		},
	): void {
		if (job.unexpectedExitReported || job.stopRequested) return;
		job.unexpectedExitReported = true;
		const detail =
			exit.error?.message ??
			`Persistent subagent process exited unexpectedly (code=${exit.code}, signal=${exit.signal})`;
		appendStderr(job, `${detail}\n`);
		if (job.generation <= job.settledGeneration) this.beginGeneration(job);
		this.settleGeneration(job, true, detail);
	}

	private beginGeneration(job: PersistentJob): number {
		job.generation = Math.max(job.generation, job.settledGeneration) + 1;
		job.currentOutput = "";
		job.currentStopReason = undefined;
		job.currentError = undefined;
		job.status = "running";
		job.updatedAt = Date.now();
		this.changed();
		return job.generation;
	}

	private async sendNewGeneration(
		job: PersistentJob,
		message: string,
		signal?: AbortSignal,
	): Promise<void> {
		const client = job.client;
		if (!client)
			throw new Error(`Persistent subagent ${job.id} is not running`);
		const previousGeneration = job.generation;
		const previousStatus = job.status;
		const generation = this.beginGeneration(job);
		try {
			await client.send({ type: "prompt", message }, undefined, signal);
			const targetGeneration = client.getRunState().issuedGeneration;
			const activity = await client.waitForGenerationActivity(
				targetGeneration,
				undefined,
				signal,
			);
			if (activity.kind === "handled-without-agent") {
				this.settleHandledGeneration(job, generation);
			}
		} catch (error) {
			if (
				error instanceof RpcResponseError &&
				error.kind === "response" &&
				!client.getRunState().running &&
				job.settledGeneration < generation
			) {
				job.generation = previousGeneration;
				job.status = previousStatus === "idle" ? "idle" : previousStatus;
				job.updatedAt = Date.now();
				this.changed();
				throw error;
			}
			await this.failAmbiguousCommand(job, error);
			throw error;
		}
		if (job.settledGeneration < generation) job.status = "running";
		job.updatedAt = Date.now();
		this.changed();
	}

	private async failAmbiguousCommand(
		job: PersistentJob,
		error: unknown,
	): Promise<void> {
		if (job.stopRequested || job.status === "failed") return;
		const detail = error instanceof Error ? error.message : String(error);
		appendStderr(job, `${detail}\n`);
		if (job.generation <= job.settledGeneration) this.beginGeneration(job);
		this.settleGeneration(job, true, detail);
		job.unexpectedExitReported = true;
		if (job.client && !job.client.isExited) await job.client.terminate();
	}

	private settleHandledGeneration(
		job: PersistentJob,
		generation: number,
	): void {
		if (generation <= job.settledGeneration) return;
		job.handledGenerations.add(generation);
		job.suppressedGenerations.add(generation);
		job.settledGeneration = generation;
		job.status = "idle";
		job.updatedAt = Date.now();
		this.finishWaiters(job, generation);
		this.pruneGenerations(job);
		this.changed();
	}

	private settleGeneration(
		job: PersistentJob,
		failed: boolean,
		error?: string,
	): void {
		const generation = job.generation;
		if (generation <= job.settledGeneration) return;
		const output = truncateSubagentOutput(
			job.currentOutput || error || job.stderr || "(no output)",
		);
		job.generationOutputs.set(generation, output);
		if (failed) job.generationFailures.set(generation, error || output);
		job.settledGeneration = generation;
		job.status = failed ? "failed" : "idle";
		job.updatedAt = Date.now();
		if ((job.waitClaims.get(generation) ?? 0) > 0) {
			job.suppressedGenerations.add(generation);
		}
		this.finishWaiters(job, generation);
		if (job.autoReportEnabled) this.reportGeneration(job, generation);
		else job.pendingReports.add(generation);
		this.pruneGenerations(job);
		this.changed();
	}

	private reportGeneration(job: PersistentJob, generation: number): void {
		if (
			this.shuttingDown ||
			job.stopRequested ||
			job.reportedGenerations.has(generation) ||
			job.suppressedGenerations.has(generation) ||
			job.handledGenerations.has(generation)
		) {
			return;
		}
		job.reportedGenerations.add(generation);
		const failed = job.generationFailures.has(generation);
		try {
			this.options.onCompletion({
				jobId: job.id,
				agent: job.agent.name,
				task: job.task,
				generation,
				status: failed ? "failed" : "completed",
				output: job.generationOutputs.get(generation) || "(no output)",
			});
		} catch {
			// Session replacement can invalidate completion delivery during teardown.
		}
	}

	private flushPendingReports(job: PersistentJob): void {
		for (const generation of job.pendingReports) {
			this.reportGeneration(job, generation);
		}
		job.pendingReports.clear();
	}

	private pruneGenerations(job: PersistentJob): void {
		const minimum = Math.max(
			1,
			job.settledGeneration - RETAINED_GENERATIONS + 1,
		);
		for (const generation of [...job.generationOutputs.keys()]) {
			if (generation < minimum) job.generationOutputs.delete(generation);
		}
		for (const generation of [...job.generationFailures.keys()]) {
			if (generation < minimum) job.generationFailures.delete(generation);
		}
		for (const set of [
			job.reportedGenerations,
			job.suppressedGenerations,
			job.handledGenerations,
			job.pendingReports,
		]) {
			for (const generation of [...set]) {
				if (generation < minimum) set.delete(generation);
			}
		}
	}

	private finishWaiters(job: PersistentJob, generation = job.generation): void {
		for (const waiter of [...job.waiters]) {
			if (waiter.generation <= generation) waiter.finish();
		}
	}

	private async requestStop(job: PersistentJob): Promise<void> {
		job.stopRequested = true;
		job.autoReportEnabled = false;
		job.pendingReports.clear();
		job.startupController.abort();
		job.status = "stopping";
		job.updatedAt = Date.now();
		this.changed();
		if (job.client && !job.client.isExited) {
			try {
				await job.client.send({ type: "abort" }, 2_000);
			} catch {
				// Process-tree termination is authoritative if RPC is unresponsive.
			}
			await job.client.terminate();
		}
	}

	private async stopForFailedBatch(job: PersistentJob): Promise<void> {
		const preserveFailure =
			job.status === "failed" || job.unexpectedExitReported;
		job.autoReportEnabled = false;
		job.pendingReports.clear();
		if (!job.stopRequested) await this.requestStop(job);
		else if (job.client && !job.client.isExited) await job.client.terminate();
		if (job.lifetime) await job.lifetime.catch(() => undefined);
		job.status = preserveFailure ? "failed" : "stopped";
		job.updatedAt = Date.now();
		this.finishWaiters(job);
		this.changed();
	}

	private snapshotJob(
		job: PersistentJob,
		includeOutput: boolean,
	): PersistentJobSnapshot {
		const generation =
			job.status === "starting" || job.status === "running"
				? job.generation
				: job.settledGeneration || job.generation;
		const output =
			job.generationOutputs.get(generation) ||
			job.currentOutput ||
			(job.status === "failed" ? job.stderr : "");
		return {
			id: job.id,
			agent: job.agent.name,
			task: job.task,
			status: job.status,
			generation: job.generation,
			settledGeneration: job.settledGeneration,
			createdAt: new Date(job.createdAt).toISOString(),
			updatedAt: new Date(job.updatedAt).toISOString(),
			model: job.model,
			usage: { ...job.usage },
			messageCount: job.messageCount,
			output: includeOutput
				? truncateSubagentOutput(output || "(no output)")
				: "",
			stderr: includeOutput ? truncateSubagentOutput(job.stderr) : "",
		};
	}

	private requireJob(jobId: string): PersistentJob {
		const job = this.jobs.get(jobId);
		if (!job) throw new Error(`Unknown persistent subagent job: ${jobId}`);
		return job;
	}

	private pruneTerminalHistory(): void {
		const terminal = [...this.jobs.values()]
			.filter(
				(job) => isTerminal(job.status) && (!job.client || job.client.isExited),
			)
			.sort((left, right) => left.createdAt - right.createdAt);
		for (const job of terminal.slice(0, -MAX_TERMINAL_JOB_HISTORY)) {
			for (const waiter of [...job.waiters]) {
				waiter.finish(
					new Error(`Persistent subagent history evicted: ${job.id}`),
				);
			}
			job.waiters.clear();
			job.generationOutputs.clear();
			job.generationFailures.clear();
			job.waitClaims.clear();
			job.reportedGenerations.clear();
			job.suppressedGenerations.clear();
			job.handledGenerations.clear();
			job.pendingReports.clear();
			job.currentOutput = "";
			job.currentError = undefined;
			job.stderr = "";
			job.task = "";
			job.agent = { ...job.agent, systemPrompt: "" };
			job.client = undefined;
			job.lifetime = undefined;
			job.operationTail = Promise.resolve();
			this.jobs.delete(job.id);
		}
	}

	private withOperation<T>(
		job: PersistentJob,
		operation: () => Promise<T>,
	): Promise<T> {
		const run = job.operationTail.then(operation, operation);
		job.operationTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private changed(): void {
		this.pruneTerminalHistory();
		try {
			this.options.onChanged();
		} catch {
			// UI failures must not affect process lifecycle.
		}
	}
}

export function formatPersistentSnapshot(
	snapshot: PersistentJobSnapshot,
): string {
	const lines = [
		`Job: ${snapshot.id}`,
		`Agent: ${snapshot.agent}`,
		`Status: ${snapshot.status}`,
		`Generation: ${snapshot.generation} (settled ${snapshot.settledGeneration})`,
		`Task: ${snapshot.task}`,
	];
	if (snapshot.model) lines.push(`Model: ${snapshot.model}`);
	if (snapshot.output) lines.push("", "Output:", snapshot.output);
	if (snapshot.stderr) lines.push("", "Stderr:", snapshot.stderr);
	return truncateSubagentOutput(lines.join("\n"));
}
