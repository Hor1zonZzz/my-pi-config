import type { Message } from "@earendil-works/pi-ai";
import { emptyUsage, type RunStatus, type UsageStats } from "./format.ts";

export type RunMode = "sync" | "async";
export type GroupKind = "single" | "parallel" | "chain";

export interface RunGroup {
	kind: GroupKind;
	/** Zero-based position within the tool call's tasks or chain steps. */
	index: number;
	total: number;
}

/**
 * Serializable state of one subagent process. It is stored in tool-result
 * details, completion messages, and `<id>.meta.json` next to the child session.
 */
export interface RunSnapshot {
	version: 1;
	id: string;
	parentSessionId: string;
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	cwd: string;
	mode: RunMode;
	group: RunGroup;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	usage: UsageStats;
	model?: string;
	/** What the child is doing right now, e.g. `read src/a.ts`; cleared when the run ends. */
	activity?: string;
	exitCode?: number;
	stopReason?: string;
	errorMessage?: string;
	stderr?: string;
	/** The subagent's final answer, or the failure text. */
	output?: string;
	/** Described tool calls in order, capped. */
	toolCalls: string[];
	/** Directory holding the child session JSONL and this run's metadata. */
	sessionDir: string;
	/** The child's session file, `<sessionDir>/<short id>.jsonl`. Runs recorded before it existed have none. */
	sessionFile?: string;
	jobId?: string;
}

export interface StreamingMessage {
	thinking: string;
	text: string;
}

export function newSnapshot(fields: Omit<RunSnapshot, "version" | "status" | "usage" | "toolCalls" | "startedAt">): RunSnapshot {
	return { version: 1, status: "running", usage: emptyUsage(), toolCalls: [], startedAt: Date.now(), ...fields };
}

/** A run owned by this Pi process: the snapshot plus live transcript and cancellation. */
export class LiveRun {
	snapshot: RunSnapshot;
	readonly messages: Message[] = [];
	streaming: StreamingMessage | undefined;
	readonly controller = new AbortController();
	/** Who stopped the run: the user from the panel, or the main agent with subagent_control. */
	stoppedBy: "user" | "agent" | undefined;
	/**
	 * Set by the runner while the child takes commands. `steer` is delivered after
	 * the child's current step; `interrupt` aborts that step and handles the
	 * message at once. Both reject when the child refuses or has exited.
	 */
	steer?: (message: string) => Promise<void>;
	interrupt?: (message: string) => Promise<void>;

	constructor(snapshot: RunSnapshot) {
		this.snapshot = snapshot;
	}

	get id(): string {
		return this.snapshot.id;
	}

	get running(): boolean {
		return this.snapshot.status === "running";
	}

	/** Stop only this run; the rest of its tool call or background job keeps going. */
	stop(by: "user" | "agent" = "user"): boolean {
		if (!this.running || this.controller.signal.aborted) return false;
		this.stoppedBy = by;
		this.controller.abort();
		return true;
	}
}

/** A run found on disk that this process is no longer running. */
export function interrupted(snapshot: RunSnapshot): RunSnapshot {
	if (snapshot.status !== "running") return snapshot;
	return { ...snapshot, status: "cancelled", activity: undefined, output: snapshot.output || "Interrupted: Pi exited or reloaded before the run finished." };
}

type Listener = (run: LiveRun | undefined) => void;

export interface WaitingRun {
	id: string;
	agent: string;
	parentSessionId: string;
	stopRequested?: boolean;
}

/** Runs started by this process, in start order, with change notifications for the UI. */
export class RunRegistry {
	private readonly runs = new Map<string, LiveRun>();
	private readonly listeners = new Set<Listener>();
	/** Runs handed out by a dispatch that have not started yet, and whether a stop was asked for. */
	private readonly waiting = new Map<string, WaitingRun>();

	add(run: LiveRun): void {
		this.waiting.delete(run.id);
		this.runs.set(run.id, run);
		this.emit(run);
	}

	/** Records a dispatched run before it starts, so it can be named and stopped at once. */
	expect(run: WaitingRun): void {
		this.waiting.set(run.id, run);
	}

	waitingRuns(): WaitingRun[] {
		return [...this.waiting.values()];
	}

	/** Asks a run that has not started never to start. False when it is not waiting. */
	stopBeforeStart(id: string): boolean {
		const run = this.waiting.get(id);
		if (!run) return false;
		run.stopRequested = true;
		return true;
	}

	/** Called when a task's turn comes: true when it must be skipped. Forgets the waiting entry. */
	takeStartDecision(id: string): boolean {
		const run = this.waiting.get(id);
		this.waiting.delete(id);
		return run?.stopRequested === true;
	}

	get(id: string): LiveRun | undefined {
		return this.runs.get(id);
	}

	list(): LiveRun[] {
		return [...this.runs.values()];
	}

	running(): LiveRun[] {
		return this.list().filter((run) => run.running);
	}

	emit(run?: LiveRun): void {
		for (const listener of this.listeners) {
			try {
				listener(run);
			} catch {
				// A broken view must not break the run.
			}
		}
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Stop every running process and forget this session's runs. */
	reset(): void {
		for (const run of this.runs.values()) run.stop();
		this.runs.clear();
		this.waiting.clear();
		this.emit();
	}
}
