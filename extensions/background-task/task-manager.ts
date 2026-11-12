import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	checkMessage,
	completionMessage,
	previewLines,
	signalFromExitCode,
	type StopReason,
	type TaskRecord,
	TAIL_LINES,
} from "./format.ts";
import { OutputLog } from "./output-log.ts";
import {
	closeStream,
	DELIBERATE_SIGNALS,
	type ExecFn,
	IdSequence,
	readPid,
	type SendFn,
	type SessionBinding,
	shellQuote,
	sleep,
	waitForPid,
	writeJsonAtomic,
} from "./process.ts";
import { touch } from "./scratchpad.ts";

export type { CompletionMessage, ExecFn, SendFn, SessionBinding } from "./process.ts";

export const MAX_RUNNING_TASKS = 16;
/** A task still running is reported to the model at every multiple of this since its start. */
export const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const MAX_FINISHED_TASKS = 50;
const SHUTDOWN_WAIT_MS = 2000;

interface ExecOutcome {
	exitCode?: number;
	error?: Error;
}

interface Launched {
	controller: AbortController;
	stream: WriteStream;
	output: OutputLog;
	execution: Promise<ExecOutcome>;
	ended: boolean;
	stopReason?: StopReason;
}

export interface ForegroundOptions {
	/** Receives output only until the command moves to the background. */
	onData: (data: Buffer) => void;
	/** The tool call's abort signal; it stops being followed once the command moves to the background. */
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	/** Seconds; applies to the whole run, before and after the move. */
	timeout?: number;
	promoteAfterMs: number;
}

export type ForegroundResult =
	| { promoted: false; exitCode: number | null }
	| { promoted: true; task: TaskRecord; tail: string[] };

let foregroundCounter = 0;

interface RunningTask {
	record: TaskRecord;
	controller: AbortController;
	output: OutputLog;
	done: Promise<void>;
}

/** A task's state for display: a copy of its record with the live line count, and its last lines. */
export interface TaskSnapshot {
	record: TaskRecord;
	tail: string[];
}

/** Lines of output kept in message details and snapshots for renderers. */
export const PREVIEW_LINES = 8;

export const MESSAGE_TYPE = "background-task";

export interface TaskManagerOptions {
	/** Interval of the "still running" reminders; 0 disables them. */
	checkIntervalMs?: number;
}

export class BackgroundTaskManager {
	private session?: SessionBinding;
	private readonly running = new Map<string, RunningTask>();
	/** Controllers of `bash` commands still running in the foreground. */
	private readonly foreground = new Set<AbortController>();
	private finished: TaskRecord[] = [];
	/** The last lines of finished tasks, for snapshots. */
	private readonly finishedTails = new Map<string, string[]>();
	private readonly ids = new IdSequence("bg");
	private shuttingDown = false;
	private readonly exec: ExecFn;
	private readonly send: SendFn;
	private readonly now: () => number;
	private readonly checkIntervalMs: number;

	constructor(exec: ExecFn, send: SendFn, now: () => number = Date.now, options: TaskManagerOptions = {}) {
		this.exec = exec;
		this.send = send;
		this.now = now;
		this.checkIntervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS;
	}

	startSession(binding: SessionBinding): void {
		this.session = binding;
		this.shuttingDown = false;
		this.ids.reset();
		this.updateStatus();
	}

	get taskDir(): string | undefined {
		return this.session ? join(this.session.scratchpad, "background") : undefined;
	}

	list(): TaskRecord[] {
		return [...this.finished, ...[...this.running.values()].map((task) => task.record)].sort(
			(a, b) => a.startedAt - b.startedAt,
		);
	}

	runningIds(): string[] {
		return [...this.running.keys()];
	}

	/** The current state of a task of this session, or undefined for an unknown ID. */
	snapshot(id: string): TaskSnapshot | undefined {
		const running = this.running.get(id);
		if (running) {
			return {
				record: { ...running.record, lines: running.output.lineCount },
				tail: previewLines(running.output.tail, PREVIEW_LINES),
			};
		}
		// IDs restart in every session, so only this session's finished tasks match.
		const record = this.finished.find((task) => task.id === id && task.sessionId === this.session?.sessionId);
		return record ? { record: { ...record }, tail: this.finishedTails.get(id) ?? [] } : undefined;
	}

	/** Resolves when the task has finished and its completion has been handled. */
	whenDone(id: string): Promise<void> {
		return this.running.get(id)?.done ?? Promise.resolve();
	}

	async start(command: string, cwd: string): Promise<TaskRecord> {
		const session = this.session;
		const taskDir = this.taskDir;
		if (!session || !taskDir || this.shuttingDown) {
			throw new Error("No active Pi session for background tasks.");
		}
		if (command.trim().length === 0) throw new Error("command must not be empty.");
		if (this.running.size >= MAX_RUNNING_TASKS) {
			throw new Error(
				`Too many background tasks are running (${this.running.size}). Stop one before starting another.`,
			);
		}
		const directory = resolve(cwd);
		let isDirectory = false;
		try {
			isDirectory = (await stat(directory)).isDirectory();
		} catch {
			// Reported below.
		}
		if (!isDirectory) throw new Error(`Working directory does not exist: ${directory}`);

		await mkdir(taskDir, { recursive: true });
		await touch(session.scratchpad).catch(() => {});
		const id = await this.ids.reserve(taskDir);
		const logPath = join(taskDir, `${id}.log`);
		const pidPath = join(taskDir, `${id}.pid`);
		const metaPath = join(taskDir, `${id}.json`);
		const record: TaskRecord = {
			id,
			command,
			cwd: directory,
			sessionId: session.sessionId,
			logPath,
			startedAt: this.now(),
			status: "running",
			lines: 0,
		};

		const run = this.launch(command, directory, pidPath, logPath, {});
		const done = this.track(record, run, pidPath, metaPath);
		this.running.set(id, { record, controller: run.controller, output: run.output, done });
		this.updateStatus();

		// A quick command may finish first; its completion handler then records the ID.
		const pgid = await waitForPid(pidPath, () => run.ended, this.now);
		record.pgid ??= pgid;
		await writeJsonAtomic(metaPath, record).catch(() => {});
		return { ...record };
	}

	/**
	 * Run a `bash` tool command in the foreground. Output and the tool's abort signal behave as
	 * for a plain execution until `promoteAfterMs`; a command still running then becomes a
	 * background task, detached from the tool's signal, and the call resolves with that task.
	 * Errors before promotion (`aborted`, `timeout:<seconds>`, spawn failures) are rethrown.
	 */
	async runForeground(command: string, cwd: string, options: ForegroundOptions): Promise<ForegroundResult> {
		const session = this.session;
		const taskDir = this.taskDir;
		const plain = async (): Promise<ForegroundResult> => {
			const result = await this.exec(command, cwd, options);
			return { promoted: false, exitCode: result.exitCode };
		};
		if (!session || !taskDir || this.shuttingDown) return plain();
		const directory = resolve(cwd);
		try {
			await mkdir(taskDir, { recursive: true });
		} catch {
			return plain();
		}
		foregroundCounter += 1;
		const pending = join(taskDir, `.foreground-${process.pid}-${foregroundCounter}`);
		const pendingLog = `${pending}.log`;
		const pidPath = `${pending}.pid`;
		const startedAt = this.now();
		let promoted = false;
		const run = this.launch(command, directory, pidPath, pendingLog, {
			env: options.env,
			timeout: options.timeout,
			onData: (data) => {
				if (!promoted) options.onData(data);
			},
		});
		this.foreground.add(run.controller);
		const onToolAbort = () => run.controller.abort();
		if (options.signal?.aborted) onToolAbort();
		else options.signal?.addEventListener("abort", onToolAbort, { once: true });

		let timer: ReturnType<typeof setTimeout> | undefined;
		const promotion = new Promise<"promote">((resolvePromotion) => {
			timer = setTimeout(() => resolvePromotion("promote"), Math.max(0, options.promoteAfterMs));
		});
		const first = await Promise.race([run.execution.then(() => "done" as const), promotion]);
		clearTimeout(timer);

		// The ID is reserved first, so a failure leaves the command running in the foreground.
		const id =
			first === "promote" && this.canPromote(session)
				? await this.ids.reserve(taskDir).catch(() => undefined)
				: undefined;
		// A command that ended or was aborted meanwhile is answered in the foreground.
		if (id !== undefined && (run.ended || run.controller.signal.aborted || !this.canPromote(session))) {
			await rm(join(taskDir, `${id}.json`), { force: true }).catch(() => {});
		} else if (id !== undefined) {
			promoted = true;
			options.signal?.removeEventListener("abort", onToolAbort);
			await touch(session.scratchpad).catch(() => {});
			const logPath = join(taskDir, `${id}.log`);
			const metaPath = join(taskDir, `${id}.json`);
			// The open stream keeps writing to the renamed file.
			await rename(pendingLog, logPath).catch(() => {});
			const record: TaskRecord = {
				id,
				command,
				cwd: directory,
				sessionId: session.sessionId,
				logPath,
				startedAt,
				status: "running",
				lines: run.output.lineCount,
				promotedAfterMs: this.now() - startedAt,
				timeout: options.timeout,
				pgid: await readPid(pidPath),
			};
			this.foreground.delete(run.controller);
			const done = this.track(record, run, pidPath, metaPath);
			this.running.set(id, { record, controller: run.controller, output: run.output, done });
			this.updateStatus();
			await writeJsonAtomic(metaPath, record).catch(() => {});
			return { promoted: true, task: { ...record }, tail: [...run.output.tail] };
		}

		const result = await run.execution;
		options.signal?.removeEventListener("abort", onToolAbort);
		this.foreground.delete(run.controller);
		run.output.end();
		await closeStream(run.stream);
		await Promise.all([rm(pendingLog, { force: true }), rm(pidPath, { force: true })]).catch(() => {});
		if (result.error !== undefined) throw result.error;
		return { promoted: false, exitCode: result.exitCode ?? null };
	}

	private canPromote(session: SessionBinding): boolean {
		return !this.shuttingDown && this.session === session && this.running.size < MAX_RUNNING_TASKS;
	}

	/** Spawn a command whose cleaned output goes to `logPath`. */
	private launch(
		command: string,
		directory: string,
		pidPath: string,
		logPath: string,
		options: { env?: NodeJS.ProcessEnv; timeout?: number; onData?: (data: Buffer) => void },
	): Launched {
		const stream = createWriteStream(logPath, { flags: "w" });
		stream.on("error", () => {});
		const output = new OutputLog((text) => stream.write(text), TAIL_LINES);
		const controller = new AbortController();
		const launched = { controller, stream, output, ended: false } as Launched;
		controller.signal.addEventListener("abort", () => {
			const reason: unknown = controller.signal.reason;
			// A plain abort (the tool call's Esc before promotion) carries a DOMException, not a reason.
			if (typeof reason === "string") launched.stopReason = reason as StopReason;
		});
		// The detached shell leads its own process group, so `$$` is the group ID that
		// `kill -- -<pgid>` needs. It is written before the user's command runs.
		const wrapped = `printf '%s\\n' "$$" > ${shellQuote(pidPath)}\n${command}`;
		launched.execution = this.exec(wrapped, directory, {
			onData: (data) => {
				output.push(data);
				options.onData?.(data);
			},
			signal: controller.signal,
			timeout: options.timeout,
			env: options.env,
		}).then(
			(result): ExecOutcome => {
				launched.ended = true;
				return { exitCode: result.exitCode ?? 1 };
			},
			(error: unknown): ExecOutcome => {
				launched.ended = true;
				return { error: error instanceof Error ? error : new Error(String(error)) };
			},
		);
		return launched;
	}

	/** Record a running task's end, persist it, and report it to its session. */
	private track(record: TaskRecord, run: Launched, pidPath: string, metaPath: string): Promise<void> {
		const cancelChecks = this.scheduleChecks(record, run);
		return run.execution.then(async (result) => {
			cancelChecks();
			run.output.end();
			await closeStream(run.stream);
			record.endedAt = this.now();
			record.lines = run.output.lineCount;
			if (run.stopReason) {
				record.status = "stopped";
				record.stopReason = run.stopReason;
			} else if (result.error?.message.startsWith("timeout:")) {
				record.status = "stopped";
				record.stopReason = "timeout";
			} else if (result.error !== undefined) {
				record.status = "failed";
				record.error = result.error.message;
			} else {
				record.status = "exited";
				record.exitCode = result.exitCode;
				record.signal = signalFromExitCode(result.exitCode);
			}
			record.pgid ??= await readPid(pidPath);
			await writeJsonAtomic(metaPath, record).catch(() => {});
			await rm(pidPath, { force: true }).catch(() => {});
			this.running.delete(record.id);
			this.finished.push(record);
			this.finishedTails.set(record.id, previewLines(run.output.tail, PREVIEW_LINES));
			if (this.finished.length > MAX_FINISHED_TASKS) {
				const dropped = this.finished.shift();
				if (dropped) this.finishedTails.delete(dropped.id);
			}
			this.updateStatus();
			this.deliver(record, run.output.tail);
		});
	}

	/**
	 * Remind the model of a running task at every multiple of the check interval since it
	 * started, with its progress since the previous reminder and the end of its log.
	 */
	private scheduleChecks(record: TaskRecord, run: Launched): () => void {
		const interval = this.checkIntervalMs;
		if (!(interval > 0)) return () => {};
		let timer: ReturnType<typeof setTimeout> | undefined;
		let linesAtLastCheck: number | undefined;
		const schedule = () => {
			const elapsed = this.now() - record.startedAt;
			const next = (Math.floor(elapsed / interval) + 1) * interval;
			timer = setTimeout(remind, next - elapsed);
			timer.unref?.();
		};
		const remind = () => {
			timer = undefined;
			if (run.ended || run.controller.signal.aborted) return;
			const lineCount = run.output.lineCount;
			const newLines = linesAtLastCheck === undefined ? undefined : lineCount - linesAtLastCheck;
			this.deliverCheck(record, this.now() - record.startedAt, lineCount, newLines, run.output.tail);
			linesAtLastCheck = lineCount;
			schedule();
		};
		schedule();
		return () => {
			if (timer) clearTimeout(timer);
			timer = undefined;
		};
	}

	private deliverCheck(
		record: TaskRecord,
		elapsedMs: number,
		lineCount: number,
		newLines: number | undefined,
		tail: readonly string[],
	): void {
		const session = this.session;
		if (this.shuttingDown || !session || session.sessionId !== record.sessionId) return;
		try {
			this.send(
				{
					customType: MESSAGE_TYPE,
					content: checkMessage(record, elapsedMs, lineCount, newLines, tail),
					display: true,
					details: {
						taskId: record.id,
						kind: "check",
						command: record.command,
						pgid: record.pgid,
						elapsedMs,
						lines: lineCount,
						newLines,
						tail: previewLines(tail, PREVIEW_LINES),
						logPath: record.logPath,
					},
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		} catch {
			// The session runtime may already be gone.
		}
	}

	/** Stop a running task on the user's request. */
	stop(id: string): boolean {
		const task = this.running.get(id);
		if (!task) return false;
		task.controller.abort("user" satisfies StopReason);
		return true;
	}

	/** Kill every running task without notifying the model, then wait briefly for cleanup. */
	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		for (const controller of this.foreground) controller.abort("shutdown" satisfies StopReason);
		const pending = [...this.running.values()];
		for (const task of pending) task.controller.abort("shutdown" satisfies StopReason);
		await Promise.race([
			Promise.allSettled(pending.map((task) => task.done)),
			sleep(SHUTDOWN_WAIT_MS),
		]);
		this.session?.setStatus?.(undefined);
	}

	private deliver(record: TaskRecord, tail: readonly string[]): void {
		const session = this.session;
		if (this.shuttingDown || record.stopReason === "shutdown") return;
		if (!session || session.sessionId !== record.sessionId) return;
		// A task stopped on purpose is reported without starting a new model turn.
		const wake =
			record.status === "failed" ||
			record.stopReason === "timeout" ||
			(record.status === "exited" && !DELIBERATE_SIGNALS.has(record.signal ?? ""));
		try {
			this.send(
				{
					customType: MESSAGE_TYPE,
					content: completionMessage(record, tail),
					display: true,
					details: {
						taskId: record.id,
						kind: "exit",
						status: record.status,
						exitCode: record.exitCode,
						signal: record.signal,
						stopReason: record.stopReason,
						error: record.error,
						timeout: record.timeout,
						command: record.command,
						elapsedMs: (record.endedAt ?? record.startedAt) - record.startedAt,
						lines: record.lines,
						tail: previewLines(tail, PREVIEW_LINES),
						logPath: record.logPath,
					},
				},
				wake ? { deliverAs: "steer", triggerTurn: true } : { triggerTurn: false },
			);
		} catch {
			// The session runtime may already be gone.
		}
	}

	private updateStatus(): void {
		const count = this.running.size;
		this.session?.setStatus?.(count > 0 ? `bg ${count}` : undefined);
	}
}

export const DEFAULT_PROMOTE_AFTER_MS = 30_000;

/** `PI_BASH_BACKGROUND_AFTER_MS`: milliseconds before `bash` moves a command to the background; 0 disables it. */
export function promoteAfterMsFrom(value: string | undefined): number {
	if (value === undefined || value.trim() === "") return DEFAULT_PROMOTE_AFTER_MS;
	const ms = Number(value);
	return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : DEFAULT_PROMOTE_AFTER_MS;
}
