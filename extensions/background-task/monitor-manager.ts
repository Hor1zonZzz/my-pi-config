import { createWriteStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { clip, signalFromExitCode } from "./format.ts";
import {
	clampTimeout,
	type EventBatch,
	eventMessage,
	finalMessage,
	type MonitorRecord,
	type MonitorStopReason,
	silentMessage,
} from "./monitor-format.ts";
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

export const MONITOR_MESSAGE_TYPE = "monitor";
export const MAX_RUNNING_MONITORS = 8;
/** Lines that arrive within this window are delivered as one event. */
export const BATCH_MS = 200;
/** A monitor that exceeds either limit within FLOOD_WINDOW_MS is stopped. */
export const FLOOD_WINDOW_MS = 60 * 1000;
export const FLOOD_EVENTS = 30;
export const FLOOD_LINES = 300;
/** A monitor without a stdout line after this long is reported to the model once. */
export const SILENT_AFTER_MS = 5 * 60 * 1000;
const MAX_FINISHED_MONITORS = 50;
const SHUTDOWN_WAIT_MS = 2000;
const STDERR_TAIL_BYTES = 8 * 1024;
const STDERR_TAIL_LINES = 20;

interface RunningMonitor {
	record: MonitorRecord;
	controller: AbortController;
	done: Promise<void>;
}

/** A monitor's state for display: a copy of its record and the lines of its latest event. */
export interface MonitorSnapshot {
	record: MonitorRecord;
	lastEvent: string[];
}

/** Lines of an event or stderr tail kept in message details and snapshots for renderers. */
export const PREVIEW_LINES = 8;
const PREVIEW_LINE_CHARS = 240;

function preview(lines: readonly string[], from: "start" | "end"): string[] {
	const selected = from === "start" ? lines.slice(0, PREVIEW_LINES) : lines.slice(-PREVIEW_LINES);
	return selected.map((line) => clip(line, PREVIEW_LINE_CHARS));
}

export interface MonitorManagerOptions {
	/** Delay of the one-time "no output yet" reminder; 0 disables it. */
	silentAfterMs?: number;
}

export interface MonitorOptions {
	command: string;
	description: string;
	cwd: string;
	timeoutMs?: number;
}

/** The last lines of a file, cleaned like the stdout log. A partial first line is dropped. */
async function readTail(path: string): Promise<string[]> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
		const { size } = await handle.stat();
		const length = Math.min(size, STDERR_TAIL_BYTES);
		if (length === 0) return [];
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, size - length);
		const log = new OutputLog(() => {}, STDERR_TAIL_LINES + 1);
		log.push(buffer);
		log.end();
		const lines = [...log.tail];
		if (size > length && lines.length > 1) lines.shift();
		return lines.slice(-STDERR_TAIL_LINES);
	} catch {
		return [];
	} finally {
		await handle?.close().catch(() => {});
	}
}

/**
 * Runs watch scripts whose stdout lines are delivered to the owning session as events.
 *
 * Lines are batched for BATCH_MS, a monitor that floods the session is stopped, and every
 * monitor is stopped at its timeout. The end of each monitor is reported once.
 */
export class MonitorManager {
	private session?: SessionBinding;
	private readonly running = new Map<string, RunningMonitor>();
	private finished: MonitorRecord[] = [];
	/** The latest event lines of each monitor, running or finished, for snapshots. */
	private readonly lastEvents = new Map<string, string[]>();
	private readonly ids = new IdSequence("mon");
	private shuttingDown = false;
	private readonly exec: ExecFn;
	private readonly send: SendFn;
	private readonly now: () => number;
	private readonly silentAfterMs: number;

	constructor(exec: ExecFn, send: SendFn, now: () => number = Date.now, options: MonitorManagerOptions = {}) {
		this.exec = exec;
		this.send = send;
		this.now = now;
		this.silentAfterMs = options.silentAfterMs ?? SILENT_AFTER_MS;
	}

	startSession(binding: SessionBinding): void {
		this.session = binding;
		this.shuttingDown = false;
		this.ids.reset();
		this.updateStatus();
	}

	get monitorDir(): string | undefined {
		return this.session ? join(this.session.scratchpad, "monitor") : undefined;
	}

	list(): MonitorRecord[] {
		return [...this.finished, ...[...this.running.values()].map((monitor) => monitor.record)].sort(
			(a, b) => a.startedAt - b.startedAt,
		);
	}

	runningIds(): string[] {
		return [...this.running.keys()];
	}

	/** The current state of a monitor of this session, or undefined for an unknown ID. */
	snapshot(id: string): MonitorSnapshot | undefined {
		// IDs restart in every session, so only this session's monitors match.
		const record =
			this.running.get(id)?.record ??
			this.finished.find((monitor) => monitor.id === id && monitor.sessionId === this.session?.sessionId);
		return record ? { record: { ...record }, lastEvent: this.lastEvents.get(`${record.sessionId}/${id}`) ?? [] } : undefined;
	}

	/** Resolves when the monitor has ended and its final report has been handled. */
	whenDone(id: string): Promise<void> {
		return this.running.get(id)?.done ?? Promise.resolve();
	}

	async start(options: MonitorOptions): Promise<MonitorRecord> {
		const session = this.session;
		const dir = this.monitorDir;
		if (!session || !dir || this.shuttingDown) throw new Error("No active Pi session for monitors.");
		const { command } = options;
		const description = options.description.trim();
		if (command.trim().length === 0) throw new Error("command must not be empty.");
		if (description.length === 0) throw new Error("description must not be empty.");
		if (this.running.size >= MAX_RUNNING_MONITORS) {
			throw new Error(
				`Too many monitors are running (${this.running.size}). Stop one before starting another.`,
			);
		}
		const directory = resolve(options.cwd);
		let isDirectory = false;
		try {
			isDirectory = (await stat(directory)).isDirectory();
		} catch {
			// Reported below.
		}
		if (!isDirectory) throw new Error(`Working directory does not exist: ${directory}`);

		await mkdir(dir, { recursive: true });
		await touch(session.scratchpad).catch(() => {});
		const id = await this.ids.reserve(dir);
		const pidPath = join(dir, `${id}.pid`);
		const metaPath = join(dir, `${id}.json`);
		const record: MonitorRecord = {
			id,
			description,
			command,
			cwd: directory,
			sessionId: session.sessionId,
			logPath: join(dir, `${id}.log`),
			stderrPath: join(dir, `${id}.stderr.log`),
			startedAt: this.now(),
			timeoutMs: clampTimeout(options.timeoutMs),
			status: "running",
			lines: 0,
			events: 0,
		};

		const controller = new AbortController();
		const stopReason: { value?: MonitorStopReason } = {};
		controller.signal.addEventListener("abort", () => {
			stopReason.value = controller.signal.reason as MonitorStopReason;
		});
		const stop = (reason: MonitorStopReason) => {
			if (!controller.signal.aborted) controller.abort(reason);
		};

		// Event batching and flood control.
		let pending: EventBatch | undefined;
		let batchTimer: ReturnType<typeof setTimeout> | undefined;
		const recentEvents: number[] = [];
		const recentLines: number[] = [];
		const prune = (times: number[], now: number) => {
			while (times.length > 0 && now - times[0] >= FLOOD_WINDOW_MS) times.shift();
		};
		const flush = () => {
			batchTimer = undefined;
			// After a stop, pending lines are left for the final report.
			if (!pending || controller.signal.aborted) return;
			const batch = pending;
			pending = undefined;
			const now = this.now();
			prune(recentEvents, now);
			if (recentEvents.length >= FLOOD_EVENTS) {
				pending = batch;
				stop("flood");
				return;
			}
			recentEvents.push(now);
			record.events += 1;
			this.deliverEvent(record, batch);
		};
		const onLine = (line: string) => {
			record.lines += 1;
			if (controller.signal.aborted) return;
			const now = this.now();
			prune(recentLines, now);
			recentLines.push(now);
			if (pending) {
				pending.lines.push(line);
			} else {
				pending = { firstLine: record.lines, lines: [line] };
			}
			if (recentLines.length > FLOOD_LINES) {
				stop("flood");
				return;
			}
			batchTimer ??= setTimeout(flush, BATCH_MS);
		};

		const stream = createWriteStream(record.logPath, { flags: "w" });
		stream.on("error", () => {});
		const output = new OutputLog((text) => {
			stream.write(text);
			onLine(text.slice(0, -1));
		}, 0);

		// The detached shell leads its own process group, so `$$` is the group ID that
		// `kill -- -<pgid>` needs. Only stdout reaches onData; stderr goes to its own file.
		const wrapped = [
			`printf '%s\\n' "$$" > ${shellQuote(pidPath)}`,
			"{",
			command,
			`} 2>> ${shellQuote(record.stderrPath)}`,
		].join("\n");
		const timeout = setTimeout(() => stop("timeout"), record.timeoutMs);
		let ended = false;
		// A monitor that expires before the reminder is reported at expiry instead.
		const skipReminder = () => ended || controller.signal.aborted || record.lines > 0;
		const silentTimer =
			this.silentAfterMs > 0 && this.silentAfterMs < record.timeoutMs
				? setTimeout(() => void this.remindSilent(record, skipReminder), this.silentAfterMs)
				: undefined;
		silentTimer?.unref?.();
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
			clearTimeout(timeout);
			if (silentTimer) clearTimeout(silentTimer);
			output.end();
			if (batchTimer) clearTimeout(batchTimer);
			batchTimer = undefined;
			await closeStream(stream);
			record.endedAt = this.now();
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
			const failed =
				record.status === "failed" ||
				(record.status === "exited" && record.exitCode !== 0 && !DELIBERATE_SIGNALS.has(record.signal ?? ""));
			const stderrTail = failed ? await readTail(record.stderrPath) : [];
			await writeJsonAtomic(metaPath, record).catch(() => {});
			await rm(pidPath, { force: true }).catch(() => {});
			this.running.delete(id);
			this.finished.push(record);
			if (pending && pending.lines.length > 0) {
				this.lastEvents.set(`${record.sessionId}/${record.id}`, preview(pending.lines, "end"));
			}
			if (this.finished.length > MAX_FINISHED_MONITORS) {
				const dropped = this.finished.shift();
				if (dropped) this.lastEvents.delete(`${dropped.sessionId}/${dropped.id}`);
			}
			this.updateStatus();
			this.deliverFinal(record, pending, stderrTail);
		});
		this.running.set(id, { record, controller, done });
		this.updateStatus();

		// A quick script may finish first; its completion handler then records the ID.
		const pgid = await waitForPid(pidPath, () => ended, this.now);
		record.pgid ??= pgid;
		await writeJsonAtomic(metaPath, record).catch(() => {});
		return { ...record };
	}

	/** Stop a running monitor on the user's request. */
	stop(id: string): boolean {
		const monitor = this.running.get(id);
		if (!monitor) return false;
		monitor.controller.abort("user" satisfies MonitorStopReason);
		return true;
	}

	/** Kill every running monitor without notifying the model, then wait briefly for cleanup. */
	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		const pending = [...this.running.values()];
		for (const monitor of pending) monitor.controller.abort("shutdown" satisfies MonitorStopReason);
		await Promise.race([
			Promise.allSettled(pending.map((monitor) => monitor.done)),
			sleep(SHUTDOWN_WAIT_MS),
		]);
		this.session?.setStatus?.(undefined);
	}

	private ownsSession(record: MonitorRecord): boolean {
		return !this.shuttingDown && this.session?.sessionId === record.sessionId;
	}

	private deliverEvent(record: MonitorRecord, batch: EventBatch): void {
		this.lastEvents.set(`${record.sessionId}/${record.id}`, preview(batch.lines, "end"));
		if (!this.ownsSession(record)) return;
		this.trySend(
			{
				customType: MONITOR_MESSAGE_TYPE,
				content: eventMessage(record, batch),
				display: true,
				details: {
					monitorId: record.id,
					kind: "event",
					description: record.description,
					event: record.events,
					elapsedMs: this.now() - record.startedAt,
					timeoutMs: record.timeoutMs,
					firstLine: batch.firstLine,
					lines: batch.lines.length,
					preview: preview(batch.lines, "start"),
					logPath: record.logPath,
				},
			},
			true,
		);
	}

	/** Tell the model once that a monitor has printed nothing, unless that changed meanwhile. */
	private async remindSilent(record: MonitorRecord, skip: () => boolean): Promise<void> {
		if (skip()) return;
		const stderrTail = await readTail(record.stderrPath);
		if (skip() || !this.ownsSession(record)) return;
		this.trySend(
			{
				customType: MONITOR_MESSAGE_TYPE,
				content: silentMessage(record, this.now() - record.startedAt, stderrTail),
				display: true,
				details: {
					monitorId: record.id,
					kind: "silent",
					description: record.description,
					pgid: record.pgid,
					elapsedMs: this.now() - record.startedAt,
					timeoutMs: record.timeoutMs,
					stderrTail: preview(stderrTail, "end"),
					logPath: record.logPath,
					stderrPath: record.stderrPath,
				},
			},
			true,
		);
	}

	private deliverFinal(record: MonitorRecord, pending: EventBatch | undefined, stderrTail: string[]): void {
		if (record.stopReason === "shutdown" || !this.ownsSession(record)) return;
		// A monitor stopped on purpose is reported without starting a new model turn.
		const deliberate =
			record.stopReason === "user" ||
			(record.status === "exited" && DELIBERATE_SIGNALS.has(record.signal ?? ""));
		this.trySend(
			{
				customType: MONITOR_MESSAGE_TYPE,
				content: finalMessage(record, pending, stderrTail),
				display: true,
				details: {
					monitorId: record.id,
					kind: "end",
					description: record.description,
					elapsedMs: (record.endedAt ?? record.startedAt) - record.startedAt,
					timeoutMs: record.timeoutMs,
					error: record.error,
					finalEvents: pending ? preview(pending.lines, "start") : [],
					stderrTail: preview(stderrTail, "end"),
					status: record.status,
					stopReason: record.stopReason,
					exitCode: record.exitCode,
					signal: record.signal,
					events: record.events,
					lines: record.lines,
					logPath: record.logPath,
				},
			},
			!deliberate,
		);
	}

	private trySend(message: Parameters<SendFn>[0], wake: boolean): void {
		try {
			this.send(message, wake ? { deliverAs: "steer", triggerTurn: true } : { triggerTurn: false });
		} catch {
			// The session runtime may already be gone.
		}
	}

	private updateStatus(): void {
		const count = this.running.size;
		this.session?.setStatus?.(count > 0 ? `mon ${count}` : undefined);
	}
}
