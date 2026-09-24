import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, truncateHead } from "@earendil-works/pi-coding-agent";

interface Job {
	id: string;
	task: string;
	controller: AbortController;
	promise: Promise<void>;
}

// Own only the background lifecycle; execution and result rendering stay in index.ts.
export class BackgroundJobs {
	private pi: ExtensionAPI;
	private jobs = new Map<string, Job>();
	private generation = 0;
	private stopped = false;
	private context?: ExtensionContext;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	private updateStatus(): void {
		// The TUI lists running subagents below the editor; other UIs get a status line.
		if (this.context?.hasUI && this.context.mode !== "tui") {
			this.context.ui.setStatus("subagent-background", this.jobs.size ? `subagents: ${this.jobs.size} running` : undefined);
		}
	}

	list(): string {
		return [...this.jobs.values()].map((job) => `${job.id}: ${job.task.slice(0, 200)}`).join("\n") || "No background subagents running.";
	}

	cancel(id: string): number {
		const jobs = [...this.jobs.values()].filter((job) => id === "all" || job.id === id);
		for (const job of jobs) job.controller.abort();
		return jobs.length;
	}

	start<T>(ctx: ExtensionContext, task: string, run: (signal: AbortSignal) => Promise<AgentToolResult<T> & { isError?: boolean; cancelled?: boolean }>): string {
		if (this.stopped) throw new Error("Subagent extension is shutting down.");
		if (this.jobs.size >= 4) throw new Error("At most 4 background subagent jobs may run at once. Wait for a completion.");
		const generation = this.generation;
		const sessionId = ctx.sessionManager.getSessionId();
		const job: Job = {
			id: `subagent-${randomUUID().slice(0, 8)}`,
			task,
			controller: new AbortController(),
			promise: Promise.resolve(),
		};
		this.context = ctx;
		this.jobs.set(job.id, job);
		this.updateStatus();
		// Yield to let the dispatch tool return before even an immediate completion.
		job.promise = new Promise<void>((resolve) => setTimeout(resolve, 0))
			.then(async () => {
				let result: (AgentToolResult<T> & { isError?: boolean; cancelled?: boolean }) | undefined;
				let status = "completed";
				let output = "";
				try {
					job.controller.signal.throwIfAborted();
					result = await run(job.controller.signal);
					// A run stopped from the subagent panel reports cancelled rather than failed.
					status = result.cancelled ? "cancelled" : result.isError ? "failed" : "completed";
					output = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
				} catch (error) {
					status = "failed";
					output = error instanceof Error ? error.message : String(error);
				}
				if (job.controller.signal.aborted) {
					status = "cancelled";
					output = "Cancelled. Work may be partial; inspect any changes before relying on them.";
				}
				if (this.stopped || this.generation !== generation || ctx.sessionManager.getSessionId() !== sessionId) return;
				const summary = truncateHead(task, { maxBytes: 2048, maxLines: 20 });
				const text = `Subagent job ${job.id} ${status}.\nDelegated: ${summary.content}${summary.truncated ? "…" : ""}\n\n${output || "(no output)"}`;
				const truncated = truncateHead(text, { maxBytes: 32 * 1024, maxLines: 1000 });
				this.pi.sendMessage({
					customType: "subagent-completion",
					content: truncated.content + (truncated.truncated ? "\n[Truncated; expand this message for full output.]" : ""),
					display: true,
					details: { jobId: job.id, status, result },
				}, { deliverAs: "steer", triggerTurn: true });
			})
			.catch((error) => {
				if (!this.stopped && this.generation === generation && ctx.hasUI) {
					ctx.ui.notify(`Subagent completion delivery failed: ${String(error)}`, "error");
				}
			})
			.finally(() => {
				this.jobs.delete(job.id);
				this.updateStatus();
			});
		return job.id;
	}

	async shutdown(permanent = true): Promise<void> {
		this.stopped = true;
		this.generation++;
		const jobs = [...this.jobs.values()];
		for (const job of jobs) job.controller.abort();
		await Promise.allSettled(jobs.map((job) => job.promise));
		this.jobs.clear();
		this.updateStatus();
		this.context = undefined;
		this.stopped = permanent;
	}
}
