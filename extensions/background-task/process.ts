import type { WriteStream } from "node:fs";
import { open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Same contract as Pi's `BashOperations.exec`. */
export type ExecFn = (
	command: string,
	cwd: string,
	options: {
		onData: (data: Buffer) => void;
		signal?: AbortSignal;
		/** Seconds; the backend kills the process and rejects with `timeout:<seconds>`. */
		timeout?: number;
		env?: NodeJS.ProcessEnv;
	},
) => Promise<{ exitCode: number | null }>;

export interface CompletionMessage {
	customType: string;
	content: string;
	display: boolean;
	details: Record<string, unknown>;
}

export type SendFn = (
	message: CompletionMessage,
	options: { deliverAs?: "steer"; triggerTurn: boolean },
) => void;

export interface SessionBinding {
	sessionId: string;
	scratchpad: string;
	setStatus?: (text: string | undefined) => void;
}

/** Signals that normally mean somebody stopped the process on purpose. */
export const DELIBERATE_SIGNALS = new Set(["SIGTERM", "SIGINT", "SIGHUP"]);

const PID_WAIT_MS = 1000;
const PID_POLL_MS = 20;

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

let temporaryCounter = 0;

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	temporaryCounter += 1;
	const temporary = `${path}.${process.pid}-${temporaryCounter}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
	await rename(temporary, path);
}

export async function readPid(path: string): Promise<number | undefined> {
	const text = await readFile(path, "utf8").catch(() => "");
	const pid = Number.parseInt(text.trim(), 10);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Wait until the wrapped shell has written its PID, the command has ended, or a short deadline passes. */
export async function waitForPid(
	path: string,
	ended: () => boolean,
	now: () => number,
): Promise<number | undefined> {
	const deadline = now() + PID_WAIT_MS;
	for (;;) {
		const pid = await readPid(path);
		if (pid !== undefined) return pid;
		if (ended() || now() >= deadline) return undefined;
		await sleep(PID_POLL_MS);
	}
}

export function closeStream(stream: WriteStream): Promise<void> {
	return new Promise((resolveClose) => {
		stream.once("error", () => resolveClose());
		stream.end(() => resolveClose());
	});
}

/** Per-directory `<prefix>-<n>` IDs that continue after a resumed session's earlier ones. */
export class IdSequence {
	private value = 0;
	private loaded?: Promise<void>;
	private readonly prefix: string;

	constructor(prefix: string) {
		this.prefix = prefix;
	}

	reset(): void {
		this.value = 0;
		this.loaded = undefined;
	}

	async reserve(dir: string): Promise<string> {
		this.loaded ??= this.load(dir);
		await this.loaded;
		for (;;) {
			this.value += 1;
			const id = `${this.prefix}-${this.value}`;
			try {
				// Exclusive creation keeps IDs unique when a resumed session reuses the directory.
				const handle = await open(join(dir, `${id}.json`), "wx");
				await handle.close();
				return id;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
	}

	private async load(dir: string): Promise<void> {
		const names = await readdir(dir).catch(() => [] as string[]);
		const pattern = new RegExp(`^${this.prefix}-(\\d+)\\.`);
		for (const name of names) {
			const match = pattern.exec(name);
			if (match) this.value = Math.max(this.value, Number(match[1]));
		}
	}
}
