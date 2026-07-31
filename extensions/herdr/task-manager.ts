// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { monitorHerdrTask } from "./monitor.ts";
import type {
	CompletedMonitor,
	HerdrAgentInfo,
	MonitorSubmission,
	MonitorTask,
} from "./types.ts";

const STATUS_KEY = "herdr-background-monitor";
const MAX_SUBMISSIONS_PER_PANE = 20;
const MAX_PENDING_COMPLETIONS = 50;

interface MonitorContext {
	hasUI: boolean;
	isIdle(): boolean;
	sessionManager: { getSessionId(): string };
	ui: { setStatus(key: string, value: string | undefined): void };
}

interface MonitoredToolResult {
	toolCallId: string;
	isError: boolean;
	input: unknown;
	details?: unknown;
}

export class HerdrBackgroundTaskManager {
	private activeContext?: MonitorContext;
	private sessionId?: string;
	private tasks = new Map<string, MonitorTask>();
	private pendingCompletions: CompletedMonitor[] = [];
	private omittedPendingCompletions = 0;
	private shuttingDown = false;
	private sequence = 0;

	constructor(private readonly pi: ExtensionAPI) {}

	startSession(ctx: MonitorContext): void {
		this.shuttingDown = false;
		this.activeContext = ctx;
		this.sessionId = ctx.sessionManager.getSessionId();
		this.tasks = new Map();
		this.pendingCompletions = [];
		this.omittedPendingCompletions = 0;
		this.updateStatus();
	}

	private nextTaskId(): string {
		this.sequence += 1;
		return `herdr-bg-${Date.now().toString(36)}-${this.sequence.toString(36)}`;
	}

	private updateStatus(): void {
		if (!this.activeContext?.hasUI) return;
		const count = this.tasks.size;
		this.activeContext.ui.setStatus(
			STATUS_KEY,
			count > 0 ? `herdr-bg ${count}` : undefined,
		);
	}

	private currentSessionMatches(sessionId: string): boolean {
		if (this.shuttingDown || this.sessionId !== sessionId) return false;
		try {
			return this.activeContext?.sessionManager?.getSessionId?.() === sessionId;
		} catch {
			return false;
		}
	}

	private completionMessage(
		completions: CompletedMonitor[],
		omittedCompletions = 0,
	): string {
		const sections = completions.map((completion) => {
			const taskIds = completion.submissions.map((item) => item.taskId);
			const lines = [
				`## Herdr Background Task${taskIds.length === 1 ? "" : "s"} ${taskIds.join(", ")}`,
				"",
				`Target: ${completion.displayTarget}`,
				`Pane: ${completion.paneId}`,
				`Status: ${completion.outcome.status}`,
			];
			if (completion.outcome.agentStatus) {
				lines.push(`Herdr agent state: ${completion.outcome.agentStatus}`);
			}
			if (completion.outcome.error) {
				lines.push(`Error: ${completion.outcome.error}`);
			}
			lines.push("");
			if (completion.outcome.status === "blocked") {
				lines.push(
					'The Herdr agent is waiting for approval or input. Use `herdr_agent` with `action: "get"` and `action: "read"` before deciding how to respond.',
				);
			} else if (completion.outcome.status === "completed") {
				lines.push(
					'The Herdr agent has settled. Use `herdr_agent` with `action: "read"` to inspect its result.',
				);
			} else {
				lines.push(
					"The background monitor stopped without a successful completion. Inspect the target with `herdr_agent` before relying on its result.",
				);
			}
			const groupedCount = taskIds.length + completion.omittedSubmissions;
			if (groupedCount > 1) {
				lines.push(
					`Multiple background prompts (${groupedCount}) targeted this pane while it was active, so this settlement applies to the grouped submissions rather than an individual prompt.`,
				);
			}
			if (completion.omittedSubmissions > 0) {
				lines.push(
					`${completion.omittedSubmissions} additional task IDs were omitted from this bounded notification.`,
				);
			}
			return lines.join("\n");
		});
		if (omittedCompletions > 0) {
			sections.push(
				`## Additional Herdr Background Completions\n\n${omittedCompletions} additional completion records were omitted while the parent was busy. Inspect active Herdr agents before relying on their results.`,
			);
		}
		const text = sections.join("\n\n---\n\n");
		const truncated = truncateHead(text, {
			maxLines: Math.min(DEFAULT_MAX_LINES, 200),
			maxBytes: Math.min(DEFAULT_MAX_BYTES, 16 * 1024),
		});
		return truncated.truncated
			? `${truncated.content}\n\n[Herdr completion notification truncated.]`
			: truncated.content;
	}

	private deliver(
		completions: CompletedMonitor[],
		omittedCompletions = 0,
	): void {
		const deliverable = completions.filter((completion) =>
			this.currentSessionMatches(completion.ownerSessionId),
		);
		if (deliverable.length === 0) return;
		this.pi.sendMessage(
			{
				customType: "herdr-background-completion",
				content: this.completionMessage(deliverable, omittedCompletions),
				display: true,
				details: {
					taskIds: deliverable
						.flatMap((completion) =>
							completion.submissions.map((item) => item.taskId),
						)
						.slice(0, 200),
				},
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	private queueCompletion(completion: CompletedMonitor): void {
		if (!this.currentSessionMatches(completion.ownerSessionId)) return;
		if (this.activeContext?.isIdle?.()) {
			this.deliver([completion]);
			return;
		}
		if (this.pendingCompletions.length < MAX_PENDING_COMPLETIONS) {
			this.pendingCompletions.push(completion);
		} else {
			this.omittedPendingCompletions += 1;
		}
	}

	deliverPendingCompletions(): void {
		if (
			(this.pendingCompletions.length === 0 &&
				this.omittedPendingCompletions === 0) ||
			this.shuttingDown
		) {
			return;
		}
		const pending = this.pendingCompletions;
		const omitted = this.omittedPendingCompletions;
		this.pendingCompletions = [];
		this.omittedPendingCompletions = 0;
		this.deliver(pending, omitted);
	}

	trackPromptResult(event: MonitoredToolResult, ctx: MonitorContext): void {
		if (this.shuttingDown || event.isError) return;
		const input = event.input as {
			action?: unknown;
			target?: unknown;
			wait?: unknown;
		};
		if (
			input?.action !== "prompt" ||
			input.wait !== false ||
			typeof input.target !== "string"
		) {
			return;
		}
		const ownerSessionId = ctx.sessionManager.getSessionId();
		if (!this.currentSessionMatches(ownerSessionId)) return;

		const details = event.details as { agent?: HerdrAgentInfo } | undefined;
		const agent = details?.agent;
		if (!agent?.pane_id || !agent.agent_status) return;
		const submission: MonitorSubmission = {
			taskId: this.nextTaskId(),
			toolCallId: event.toolCallId,
			target: input.target,
			submittedAt: Date.now(),
		};
		const existing = this.tasks.get(agent.pane_id);
		if (existing) {
			if (existing.submissions.length < MAX_SUBMISSIONS_PER_PANE) {
				existing.submissions.push(submission);
			} else {
				existing.omittedSubmissions += 1;
			}
			existing.generation += 1;
			existing.initialAgentStatus = agent.agent_status;
			existing.baselineStateChangeSeq = agent.state_change_seq;
			existing.observedWorking = agent.agent_status === "working";
			existing.status = existing.observedWorking ? "working" : "starting";
			existing.startedAt = Date.now();
			return;
		}

		const task: MonitorTask = {
			ownerSessionId,
			paneId: agent.pane_id,
			displayTarget: agent.name || agent.display_agent || input.target,
			status: agent.agent_status === "working" ? "working" : "starting",
			initialAgentStatus: agent.agent_status,
			baselineStateChangeSeq: agent.state_change_seq,
			observedWorking: agent.agent_status === "working",
			startedAt: Date.now(),
			generation: 1,
			submissions: [submission],
			omittedSubmissions: 0,
			controller: new AbortController(),
		};
		this.tasks.set(task.paneId, task);
		this.updateStatus();
		task.promise = monitorHerdrTask(this.pi, task)
			.then((outcome) => {
				if (outcome.status === "cancelled" || this.shuttingDown) return;
				this.queueCompletion({
					ownerSessionId: task.ownerSessionId,
					paneId: task.paneId,
					displayTarget: task.displayTarget,
					submissions: [...task.submissions],
					omittedSubmissions: task.omittedSubmissions,
					outcome,
					completedAt: Date.now(),
				});
			})
			.catch(() => {
				// monitorHerdrTask converts expected failures into outcomes.
			})
			.finally(() => {
				if (this.tasks.get(task.paneId) === task)
					this.tasks.delete(task.paneId);
				this.updateStatus();
			});
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		this.pendingCompletions = [];
		this.omittedPendingCompletions = 0;
		for (const task of this.tasks.values()) task.controller.abort();
		const promises = [...this.tasks.values()]
			.map((task) => task.promise)
			.filter((promise): promise is Promise<void> => Boolean(promise));
		await Promise.allSettled(promises);
		this.tasks.clear();
		this.activeContext?.ui?.setStatus?.(STATUS_KEY, undefined);
		this.activeContext = undefined;
		this.sessionId = undefined;
	}
}
