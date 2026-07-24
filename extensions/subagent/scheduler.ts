// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

export interface SchedulerConfig {
	maxConcurrentProcesses: number;
	maxQueuedProcesses: number;
}

export interface ScheduleHooks {
	onQueued?: () => void;
	onDequeued?: () => void;
	onStart?: () => void;
	onFinish?: () => void;
}

interface QueueItem<T> {
	signal?: AbortSignal;
	runner: () => Promise<T>;
	hooks: ScheduleHooks;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
	onAbort?: () => void;
}

export interface SchedulerReservation {
	run<T>(
		signal: AbortSignal | undefined,
		runner: () => Promise<T>,
		hooks?: ScheduleHooks,
	): Promise<T>;
	release(): void;
}

function abortError(): Error {
	const error = new Error("Subagent task was cancelled");
	error.name = "AbortError";
	return error;
}

function callHook(hook: (() => void) | undefined): void {
	try {
		hook?.();
	} catch {
		// Task persistence/UI failures must not corrupt scheduler accounting.
	}
}

export class ProcessScheduler {
	private running = 0;
	private reserved = 0;
	private queue: QueueItem<unknown>[] = [];
	private closed = false;

	constructor(private readonly config: SchedulerConfig) {}

	get runningCount(): number {
		return this.running;
	}

	get queuedCount(): number {
		return this.queue.length;
	}

	reserve(processCount: number): SchedulerReservation {
		if (this.closed) throw new Error("Subagent scheduler is shutting down");
		if (!Number.isInteger(processCount) || processCount < 1) {
			throw new Error(`Invalid process reservation: ${processCount}`);
		}
		const capacity =
			this.config.maxConcurrentProcesses + this.config.maxQueuedProcesses;
		const outstanding = this.running + this.queue.length + this.reserved;
		if (outstanding + processCount > capacity) {
			throw new Error(
				`Subagent process queue is full (${this.running} running, ${this.queue.length + this.reserved} queued/reserved; capacity ${capacity}).`,
			);
		}
		this.reserved += processCount;
		let remaining = processCount;
		let released = false;

		return {
			run: <T>(
				signal: AbortSignal | undefined,
				runner: () => Promise<T>,
				hooks: ScheduleHooks = {},
			): Promise<T> => {
				if (released || remaining <= 0) {
					return Promise.reject(
						new Error("Subagent scheduler reservation is exhausted"),
					);
				}
				remaining -= 1;
				this.reserved -= 1;
				return this.schedule(signal, runner, hooks);
			},
			release: () => {
				if (released) return;
				released = true;
				this.reserved -= remaining;
				remaining = 0;
				this.drain();
			},
		};
	}

	shutdown(): void {
		this.closed = true;
		for (const item of this.queue.splice(0)) {
			if (item.signal && item.onAbort) {
				item.signal.removeEventListener("abort", item.onAbort);
			}
			callHook(item.hooks.onDequeued);
			item.reject(abortError());
		}
	}

	private schedule<T>(
		signal: AbortSignal | undefined,
		runner: () => Promise<T>,
		hooks: ScheduleHooks,
	): Promise<T> {
		if (this.closed)
			return Promise.reject(new Error("Subagent scheduler is shutting down"));
		if (signal?.aborted) return Promise.reject(abortError());

		return new Promise<T>((resolve, reject) => {
			const item: QueueItem<T> = { signal, runner, hooks, resolve, reject };
			if (this.running < this.config.maxConcurrentProcesses) {
				this.start(item);
				return;
			}
			item.onAbort = () => {
				const index = this.queue.indexOf(item as QueueItem<unknown>);
				if (index < 0) return;
				this.queue.splice(index, 1);
				callHook(hooks.onDequeued);
				reject(abortError());
				this.drain();
			};
			signal?.addEventListener("abort", item.onAbort, { once: true });
			this.queue.push(item as QueueItem<unknown>);
			callHook(hooks.onQueued);
		});
	}

	private start<T>(item: QueueItem<T>): void {
		if (item.signal && item.onAbort) {
			item.signal.removeEventListener("abort", item.onAbort);
		}
		if (item.signal?.aborted) {
			item.reject(abortError());
			this.drain();
			return;
		}
		this.running += 1;
		callHook(item.hooks.onStart);
		void (async () => {
			try {
				const value = await item.runner();
				this.running -= 1;
				callHook(item.hooks.onFinish);
				this.drain();
				item.resolve(value);
			} catch (error) {
				this.running -= 1;
				callHook(item.hooks.onFinish);
				this.drain();
				item.reject(error);
			}
		})();
	}

	private drain(): void {
		while (
			!this.closed &&
			this.running < this.config.maxConcurrentProcesses &&
			this.queue.length > 0
		) {
			const item = this.queue.shift();
			if (item) this.start(item);
		}
	}
}
