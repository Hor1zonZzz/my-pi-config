import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	completionMessage,
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
const MAX_FINISHED_TASKS = 50;
const SHUTDOWN_WAIT_MS = 2000;

interface RunningTask {
	record: TaskRecord;
	controller: AbortController;
	done: Promise<void>;
}

export const MESSAGE_TYPE = "background-task";

export class BackgroundTaskManager {
	private session?: SessionBinding;
	private readonly running = new Map<string, RunningTask>();
	private finished: TaskRecord[] = [];
	private readonly ids = new IdSequence("bg");
	private shuttingDown = false;
	private readonly exec: ExecFn;
	private readonly send: SendFn;
	private readonly now: () => number;

	constructor(exec: ExecFn, send: SendFn, now: () => number = Date.now) {
		this.exec = exec;
		this.send = send;
		this.now = now;
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

		const stream = createWriteStream(logPath, { flags: "w" });
		stream.on("error", () => {});
		const output = new OutputLog((text) => stream.write(text), TAIL_LINES);
		const controller = new AbortController();
		const stopReason: { value?: StopReason } = {};
		controller.signal.addEventListener("abort", () => {
			stopReason.value = controller.signal.reason as StopReason;
		});

		// The detached shell leads its own process group, so `$$` is the group ID that
		// `kill -- -<pgid>` needs. It is written before the user's command runs.
		const wrapped = `printf '%s\\n' "$$" > ${shellQuote(pidPath)}\n${command}`;
		let ended = false;
		const execution = this.exec(wrapped, directory, {
			onData: (data) => output.push(data),
			signal: controller.signal,
		}).then(
			(result) => ({ exitCode: result.exitCode ?? 1, error: undefined }),
			(error: unknown) => ({
				exitCode: undefined,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		const done = execution.then(async (result) => {
			ended = true;
			output.end();
			await closeStream(stream);
			record.endedAt = this.now();
			record.lines = output.lineCount;
			if (stopReason.value) {
				record.status = "stopped";
				record.stopReason = stopReason.value;
			} else if (result.error !== undefined) {
				record.status = "failed";
				record.error = result.error;
			} else {
				record.status = "exited";
				record.exitCode = result.exitCode;
				record.signal = signalFromExitCode(result.exitCode);
			}
			record.pgid ??= await readPid(pidPath);
			await writeJsonAtomic(metaPath, record).catch(() => {});
			await rm(pidPath, { force: true }).catch(() => {});
			this.running.delete(id);
			this.finished.push(record);
			if (this.finished.length > MAX_FINISHED_TASKS) this.finished.shift();
			this.updateStatus();
			this.deliver(record, output.tail);
		});
		this.running.set(id, { record, controller, done });
		this.updateStatus();

		// A quick command may finish first; its completion handler then records the ID.
		const pgid = await waitForPid(pidPath, () => ended, this.now);
		record.pgid ??= pgid;
		await writeJsonAtomic(metaPath, record).catch(() => {});
		return { ...record };
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
			(record.status === "exited" && !DELIBERATE_SIGNALS.has(record.signal ?? ""));
		try {
			this.send(
				{
					customType: MESSAGE_TYPE,
					content: completionMessage(record, tail),
					display: true,
					details: {
						taskId: record.id,
						status: record.status,
						exitCode: record.exitCode,
						signal: record.signal,
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
