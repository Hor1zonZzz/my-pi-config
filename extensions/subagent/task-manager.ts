// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { executePlan, formatPlanContent } from "./execution.ts";
import { isFailedResult } from "./runner.ts";
import { ProcessScheduler } from "./scheduler.ts";
import type { ScheduleHooks, SchedulerReservation } from "./scheduler.ts";
import { loadSubagentSettings } from "./settings.ts";
import {
	getTaskPaths,
	initializeTaskDirectory,
	markStaleTasksInterrupted,
	readSessionTaskStatuses,
	type StoredTaskStatus,
	type TaskPaths,
	writeTaskResults,
	writeTaskStatus,
} from "./task-storage.ts";
import type {
	ExecutionMode,
	ExecutionRequest,
	OnUpdateCallback,
	PlanExecution,
	SingleResult,
} from "./types.ts";

export interface ManagedSubagentTask {
	status: StoredTaskStatus;
	paths: TaskPaths;
	controller?: AbortController;
	results: SingleResult[];
	promise?: Promise<PlanExecution | undefined>;
}

export class SubagentTaskManager {
	private scheduler: ProcessScheduler | undefined;
	private sessionId = "";
	private activeContext: any;
	private shuttingDown = false;
	private tasks = new Map<string, ManagedSubagentTask>();
	private pendingCompletions: ManagedSubagentTask[] = [];

	constructor(private readonly pi: ExtensionAPI) {}

	private getScheduler(): ProcessScheduler {
		if (!this.scheduler)
			this.scheduler = new ProcessScheduler(loadSubagentSettings());
		return this.scheduler;
	}

	private activeTasks(): ManagedSubagentTask[] {
		return Array.from(this.tasks.values()).filter(
			(task) =>
				task.status.status === "queued" || task.status.status === "running",
		);
	}

	private updateTaskStatusWidget(): void {
		if (!this.activeContext) return;
		const active = this.activeTasks();
		if (active.length === 0) {
			this.activeContext.ui.setStatus("subagent-tasks", undefined);
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
		this.activeContext.ui.setStatus(
			"subagent-tasks",
			this.activeContext.ui.theme.fg(
				"warning",
				`subagents ${running} running · ${queued} queued`,
			),
		);
	}

	private persistTask(
		task: ManagedSubagentTask,
		appendSessionEntry = false,
	): void {
		writeTaskStatus(task.paths, task.status);
		if (appendSessionEntry && !this.shuttingDown) {
			this.pi.appendEntry("subagent-task-state", {
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
		this.updateTaskStatusWidget();
	}

	private makeCompletionMessage(completedTasks: ManagedSubagentTask[]): string {
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
	}

	private deliverCompletions(completedTasks: ManagedSubagentTask[]): void {
		if (this.shuttingDown || completedTasks.length === 0) return;
		this.pi.sendMessage(
			{
				customType: "subagent-task-completion",
				content: this.makeCompletionMessage(completedTasks),
				display: true,
				details: {
					taskIds: completedTasks.map((task) => task.status.taskId),
				},
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	private queueCompletion(task: ManagedSubagentTask): void {
		if (this.shuttingDown) return;
		if (this.activeContext?.isIdle()) {
			this.deliverCompletions([task]);
			return;
		}
		this.pendingCompletions.push(task);
	}

	reserve(demand: number): SchedulerReservation {
		return this.getScheduler().reserve(demand);
	}

	listStatuses(cwd: string): StoredTaskStatus[] {
		for (const status of readSessionTaskStatuses(cwd, this.sessionId)) {
			if (!this.tasks.has(status.taskId)) {
				this.tasks.set(status.taskId, {
					status,
					paths: getTaskPaths(cwd, this.sessionId, status.taskId),
					results: [],
				});
			}
		}
		return Array.from(this.tasks.values())
			.map((task) => task.status)
			.sort((left, right) => left.createdAt - right.createdAt);
	}

	findTask(cwd: string, taskId: string): ManagedSubagentTask | undefined {
		const current = this.tasks.get(taskId);
		if (current) return current;
		const stored = readSessionTaskStatuses(cwd, this.sessionId).find(
			(status) => status.taskId === taskId,
		);
		if (!stored) return undefined;
		const task = {
			status: stored,
			paths: getTaskPaths(cwd, this.sessionId, stored.taskId),
			results: [],
		};
		this.tasks.set(stored.taskId, task);
		return task;
	}

	createTask(
		execution: "block" | "background",
		mode: ExecutionMode,
		request: ExecutionRequest,
		cwd: string,
	): ManagedSubagentTask {
		const taskId = `task_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
		const paths = getTaskPaths(cwd, this.sessionId, taskId);
		initializeTaskDirectory(paths);
		const total =
			mode === "parallel"
				? request.tasks!.length
				: mode === "chain"
					? request.chain!.length
					: 1;
		const status: StoredTaskStatus = {
			version: 1,
			taskId,
			sessionId: this.sessionId,
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
		this.tasks.set(taskId, task);
		this.persistTask(task, true);
		return task;
	}

	runTask(
		task: ManagedSubagentTask,
		request: ExecutionRequest,
		agents: AgentConfig[],
		projectAgentsDir: string | null,
		initialReservation: SchedulerReservation,
		onUpdate?: OnUpdateCallback,
	): Promise<PlanExecution | undefined> {
		const promise = (async () => {
			const createScheduleHooks = (): ScheduleHooks => ({
				onQueued: () => {
					task.status.processes.queued += 1;
					this.persistTask(task);
				},
				onDequeued: () => {
					task.status.processes.queued = Math.max(
						0,
						task.status.processes.queued - 1,
					);
					this.persistTask(task);
				},
				onStart: () => {
					task.status.processes.queued = Math.max(
						0,
						task.status.processes.queued - 1,
					);
					task.status.processes.running += 1;
					task.status.status = "running";
					task.status.startedAt ??= Date.now();
					this.persistTask(task);
				},
				onFinish: () => {
					task.status.processes.running = Math.max(
						0,
						task.status.processes.running - 1,
					);
					this.persistTask(task);
				},
			});

			try {
				const plan = await executePlan({
					defaultCwd: task.status.cwd,
					agents,
					request,
					mode: task.status.mode,
					projectAgentsDir,
					signal: task.controller?.signal,
					onUpdate,
					scheduler: this.getScheduler(),
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
							this.persistTask(task);
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
				this.persistTask(task, true);
				if (task.status.execution === "background") this.queueCompletion(task);
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
				this.persistTask(task, true);
				if (task.status.execution === "background") this.queueCompletion(task);
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
	}

	startSession(ctx: any): void {
		this.shuttingDown = false;
		this.activeContext = ctx;
		this.sessionId = ctx.sessionManager.getSessionId();
		this.scheduler = new ProcessScheduler(loadSubagentSettings());
		this.pendingCompletions = [];
		this.tasks = new Map(
			markStaleTasksInterrupted(ctx.cwd, this.sessionId).map((status) => [
				status.taskId,
				{
					status,
					paths: getTaskPaths(ctx.cwd, this.sessionId, status.taskId),
					results: [],
				},
			]),
		);
		this.updateTaskStatusWidget();
	}

	deliverPendingCompletions(): void {
		if (this.pendingCompletions.length === 0 || this.shuttingDown) return;
		const completed = this.pendingCompletions;
		this.pendingCompletions = [];
		this.deliverCompletions(completed);
	}

	guardTreeNavigation(ctx: any): { cancel: true } | undefined {
		const active = this.activeTasks();
		if (active.length === 0) return undefined;
		ctx.ui.notify(
			`Cannot navigate the session tree while ${active.length} subagent task(s) are active. Use subagent action=list or action=cancel first.`,
			"warning",
		);
		return { cancel: true };
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		this.pendingCompletions = [];
		this.scheduler?.shutdown();
		for (const task of this.activeTasks()) task.controller?.abort();
		const promises = this.activeTasks()
			.map((task) => task.promise)
			.filter((promise): promise is Promise<PlanExecution | undefined> =>
				Boolean(promise),
			);
		await Promise.allSettled(promises);
		this.activeContext?.ui.setStatus("subagent-tasks", undefined);
		this.activeContext = undefined;
	}
}
