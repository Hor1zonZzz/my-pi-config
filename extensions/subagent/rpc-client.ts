// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

const RPC_COMMAND_TIMEOUT_MS = 30_000;
export const RPC_ACTIVITY_WINDOW_MS = 150;
const TERMINATION_GRACE_MS = 5_000;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_STDERR_LINES = 2_000;
const MAX_JSONL_RECORD_BYTES = 16 * 1024 * 1024;
const ASSISTANT_CONTENT_TYPES = new Set(["text", "thinking", "toolCall"]);
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const FIRE_AND_FORGET_METHODS = new Set([
	"notify",
	"setStatus",
	"setWidget",
	"setTitle",
	"set_editor_text",
]);

export interface RpcProcessExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
}

export interface RpcRunState {
	running: boolean;
	issuedGeneration: number;
	startedGeneration: number;
	settledGeneration: number;
}

export type RpcGenerationActivity =
	| { kind: "started"; generation: number }
	| { kind: "settled"; generation: number }
	| { kind: "handled-without-agent"; generation: number };

export interface RpcProcessOptions {
	args: string[];
	cwd: string;
	onEvent: (event: Record<string, unknown>) => void;
	onStderr?: (text: string) => void;
	onProtocolError?: (error: Error) => void;
	/** Test/harness override. Production callers use Pi's normal executable discovery. */
	invocation?: { command: string; args: string[] };
}

export class RpcResponseError extends Error {
	readonly kind: "response" | "timeout" | "transport" | "aborted";

	constructor(
		message: string,
		kind: "response" | "timeout" | "transport" | "aborted",
	) {
		super(message);
		this.name = kind === "aborted" ? "AbortError" : "RpcResponseError";
		this.kind = kind;
	}
}

interface PiInvocationRuntime {
	currentScript?: string;
	execPath: string;
	existsSync: (filePath: string) => boolean;
}

/** Test hook for exercising packaged/runtime invocation discovery deterministically. */
export function getPiInvocation(
	args: string[],
	runtime: PiInvocationRuntime = {
		currentScript: process.argv[1],
		execPath: process.execPath,
		existsSync: fs.existsSync,
	},
): { command: string; args: string[] } {
	const { currentScript, execPath } = runtime;
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (
		currentScript &&
		!isBunVirtualScript &&
		runtime.existsSync(currentScript)
	) {
		return { command: execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: execPath, args };
	return { command: "pi", args };
}

function hasExited(process: ChildProcessWithoutNullStreams): boolean {
	return process.exitCode !== null || process.signalCode !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateAssistantContent(content: unknown): string | undefined {
	if (!Array.isArray(content))
		return "assistant message content is not an array";
	for (const [index, part] of content.entries()) {
		if (!isRecord(part) || typeof part.type !== "string") {
			return `assistant content[${index}] is not a typed object`;
		}
		if (!ASSISTANT_CONTENT_TYPES.has(part.type)) {
			return `assistant content[${index}] has unknown type ${part.type}`;
		}
		if (part.type === "text" && typeof part.text !== "string") {
			return `assistant content[${index}].text is not a string`;
		}
		if (part.type === "thinking" && typeof part.thinking !== "string") {
			return `assistant content[${index}].thinking is not a string`;
		}
		if (
			part.type === "toolCall" &&
			(typeof part.id !== "string" ||
				typeof part.name !== "string" ||
				!isRecord(part.arguments))
		) {
			return `assistant content[${index}] is not a valid toolCall`;
		}
	}
	return undefined;
}

function validateExtensionUiRequest(
	event: Record<string, unknown>,
): string | undefined {
	if (typeof event.id !== "string" || typeof event.method !== "string") {
		return "invalid extension_ui_request id or method";
	}
	if (
		!DIALOG_METHODS.has(event.method) &&
		!FIRE_AND_FORGET_METHODS.has(event.method)
	) {
		return `unknown extension_ui_request method: ${event.method}`;
	}
	if (DIALOG_METHODS.has(event.method) && typeof event.title !== "string") {
		return `extension_ui_request ${event.method} requires title`;
	}
	if (
		event.method === "select" &&
		(!Array.isArray(event.options) ||
			event.options.some((option) => typeof option !== "string"))
	) {
		return "extension_ui_request select requires string options";
	}
	if (event.method === "confirm" && typeof event.message !== "string") {
		return "extension_ui_request confirm requires message";
	}
	if (event.method === "notify" && typeof event.message !== "string") {
		return "extension_ui_request notify requires message";
	}
	if (event.method === "setStatus" && typeof event.statusKey !== "string") {
		return "extension_ui_request setStatus requires statusKey";
	}
	if (event.method === "setWidget" && typeof event.widgetKey !== "string") {
		return "extension_ui_request setWidget requires widgetKey";
	}
	if (event.method === "setTitle" && typeof event.title !== "string") {
		return "extension_ui_request setTitle requires title";
	}
	if (event.method === "set_editor_text" && typeof event.text !== "string") {
		return "extension_ui_request set_editor_text requires text";
	}
	return undefined;
}

function validateRpcRecord(event: Record<string, unknown>): string | undefined {
	if (typeof event.type !== "string")
		return "JSONL record type is not a string";
	if (event.type === "response") {
		if (
			typeof event.id !== "string" ||
			typeof event.command !== "string" ||
			typeof event.success !== "boolean"
		) {
			return "invalid response id, command, or success";
		}
		if (event.success === false && typeof event.error !== "string") {
			return "failed response is missing a string error";
		}
		return undefined;
	}
	if (event.type === "agent_start" || event.type === "agent_settled") {
		return Object.keys(event).some((key) => key !== "type")
			? `${event.type} contains unexpected fields`
			: undefined;
	}
	if (event.type === "message_end") {
		if (!isRecord(event.message) || typeof event.message.role !== "string") {
			return "message_end is missing a valid message";
		}
		if (event.message.role === "assistant") {
			return validateAssistantContent(event.message.content);
		}
		return undefined;
	}
	if (event.type === "extension_ui_request") {
		return validateExtensionUiRequest(event);
	}
	return undefined;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedTail(text: string, maxBytes: number, maxLines: number): string {
	let lines = text.split("\n");
	if (lines.length > maxLines) lines = lines.slice(-maxLines);
	let result = lines.join("\n");
	if (Buffer.byteLength(result, "utf8") <= maxBytes) return result;
	const buffer = Buffer.from(result, "utf8");
	result = buffer.subarray(buffer.length - maxBytes).toString("utf8");
	const replacement = result.indexOf("�");
	if (replacement >= 0 && replacement < 4)
		result = result.slice(replacement + 1);
	return result;
}

async function signalWindowsTree(
	process: ChildProcessWithoutNullStreams,
	force: boolean,
): Promise<void> {
	if (!process.pid) return;
	await new Promise<void>((resolve) => {
		const args = ["/PID", String(process.pid), "/T"];
		if (force) args.push("/F");
		const killer = spawn("taskkill", args, {
			stdio: "ignore",
			windowsHide: true,
		});
		killer.once("close", () => resolve());
		killer.once("error", () => resolve());
	});
}

function signalUnixTree(
	process: ChildProcessWithoutNullStreams,
	signal: NodeJS.Signals,
): void {
	if (process.pid) {
		try {
			process.kill(-process.pid, signal);
			return;
		} catch {
			// The process group may already be gone; fall through to the child.
		}
	}
	try {
		process.kill(signal);
	} catch {
		// A concurrent exit is success for termination.
	}
}

export class RpcProcessClient {
	readonly process: ChildProcessWithoutNullStreams;
	readonly exited: Promise<RpcProcessExit>;
	private readonly pending = new Map<
		string,
		{
			commandType: string;
			promptGeneration?: number;
			resolve: (event: Record<string, unknown>) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
			abort?: () => void;
			signal?: AbortSignal;
		}
	>();
	private requestSequence = 0;
	private exitResult?: RpcProcessExit;
	private fatalError?: Error;
	private terminating?: Promise<void>;
	private stderr = "";
	private running = false;
	private issuedGeneration = 0;
	private startedGeneration = 0;
	private settledGeneration = 0;
	private readonly activityWaiters = new Set<() => void>();
	private readonly options: RpcProcessOptions;

	constructor(options: RpcProcessOptions) {
		this.options = options;
		const invocation = options.invocation ?? getPiInvocation(options.args);
		const useProcessGroup = process.platform !== "win32";
		this.process = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			shell: false,
			detached: useProcessGroup,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		let resolveExit!: (result: RpcProcessExit) => void;
		this.exited = new Promise((resolve) => {
			resolveExit = resolve;
		});
		const finish = (result: RpcProcessExit) => {
			if (this.exitResult) return;
			const finalResult = this.fatalError
				? { ...result, error: this.fatalError }
				: result;
			this.exitResult = finalResult;
			const error =
				finalResult.error ??
				new RpcResponseError(
					`Persistent subagent process exited (code=${finalResult.code}, signal=${finalResult.signal}).${this.stderr ? ` Stderr: ${this.stderr}` : ""}`,
					"transport",
				);
			this.rejectPending(error);
			this.notifyActivityWaiters();
			resolveExit(finalResult);
		};

		const protocolFailure = (message: string) => {
			if (this.fatalError || this.exitResult) return;
			const error = new Error(
				`Persistent subagent RPC protocol error: ${message}`,
			);
			error.name = "RpcProtocolError";
			this.fatalError = error;
			this.appendStderr(`${error.message}\n`);
			this.rejectPending(error);
			this.notifyActivityWaiters();
			try {
				options.onProtocolError?.(error);
			} catch (callbackError) {
				this.appendStderr(
					`Protocol-error callback failed: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}\n`,
				);
			}
			void this.terminate();
		};

		const decoder = new StringDecoder("utf8");
		let buffer = "";
		const processLine = (rawLine: string) => {
			if (this.fatalError || this.exitResult) return;
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			if (!line.trim()) return;
			let event: Record<string, unknown>;
			try {
				const parsed = JSON.parse(line) as unknown;
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					protocolFailure("JSONL record is not an object");
					return;
				}
				event = parsed as Record<string, unknown>;
			} catch (error) {
				protocolFailure(
					`malformed JSONL (${error instanceof Error ? error.message : String(error)})`,
				);
				return;
			}
			const shapeError = validateRpcRecord(event);
			if (shapeError) {
				protocolFailure(shapeError);
				return;
			}

			if (event.type === "response") {
				const pending = this.pending.get(event.id as string);
				if (pending) {
					if (event.command !== pending.commandType) {
						protocolFailure(
							`response command mismatch: expected ${pending.commandType}, received ${String(event.command)}`,
						);
						return;
					}
					this.removePending(event.id as string, pending);
					if (event.success === false) {
						this.rollbackPrompt(pending.promptGeneration);
						pending.reject(
							new RpcResponseError(
								String(event.error ?? "RPC command failed"),
								"response",
							),
						);
					} else {
						pending.resolve(event);
					}
				}
				return;
			}

			if (event.type === "extension_ui_request") {
				const id = event.id as string;
				const method = event.method as string;
				if (DIALOG_METHODS.has(method)) {
					this.writeRaw({ type: "extension_ui_response", id, cancelled: true });
					return;
				}
				// Headless persistent jobs intentionally ignore display-only requests.
				return;
			}

			if (event.type === "agent_start") {
				if (!this.running || this.issuedGeneration <= this.settledGeneration) {
					this.issuedGeneration = this.settledGeneration + 1;
				}
				this.running = true;
				this.startedGeneration = Math.max(
					this.startedGeneration,
					this.issuedGeneration,
				);
			} else if (event.type === "agent_settled") {
				if (this.issuedGeneration === 0) this.issuedGeneration = 1;
				this.settledGeneration = Math.max(
					this.settledGeneration,
					this.issuedGeneration,
				);
				this.running = false;
			}
			this.notifyActivityWaiters();
			try {
				options.onEvent(event);
			} catch (error) {
				protocolFailure(
					`event callback failed for ${String(event.type)} (${error instanceof Error ? error.message : String(error)})`,
				);
			}
		};

		this.process.stdout.on("data", (chunk) => {
			buffer += decoder.write(chunk);
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (Buffer.byteLength(line, "utf8") > MAX_JSONL_RECORD_BYTES) {
					protocolFailure(
						`JSONL record exceeded ${MAX_JSONL_RECORD_BYTES} bytes`,
					);
					continue;
				}
				processLine(line);
			}
			if (Buffer.byteLength(buffer, "utf8") > MAX_JSONL_RECORD_BYTES) {
				protocolFailure(
					`JSONL record exceeded ${MAX_JSONL_RECORD_BYTES} bytes without a delimiter`,
				);
				buffer = "";
			}
		});
		this.process.stdout.on("end", () => {
			buffer += decoder.end();
			if (buffer) processLine(buffer);
			buffer = "";
		});
		this.process.stderr.on("data", (chunk) => {
			this.appendStderr(chunk.toString());
		});
		this.process.stdin.on("error", (error) => {
			if (this.exitResult) return;
			this.rejectPending(new RpcResponseError(error.message, "transport"));
		});
		this.process.once("error", (error) => {
			finish({
				code: this.process.exitCode,
				signal: this.process.signalCode,
				error,
			});
		});
		this.process.once("close", (code, signal) => {
			finish({ code, signal });
		});
	}

	get isExited(): boolean {
		return Boolean(this.exitResult) || hasExited(this.process);
	}

	getRunState(): RpcRunState {
		return {
			running: this.running,
			issuedGeneration: this.issuedGeneration,
			startedGeneration: this.startedGeneration,
			settledGeneration: this.settledGeneration,
		};
	}

	getStderr(): string {
		return this.stderr;
	}

	waitForGenerationActivity(
		generation: number,
		timeoutMs = RPC_ACTIVITY_WINDOW_MS,
		signal?: AbortSignal,
	): Promise<RpcGenerationActivity> {
		const current = this.activityForGeneration(generation);
		if (current) return Promise.resolve(current);
		if (signal?.aborted) {
			return Promise.reject(
				new RpcResponseError("RPC activity wait was cancelled", "aborted"),
			);
		}

		let timer: ReturnType<typeof setTimeout> | undefined;
		let wake!: () => void;
		return new Promise<RpcGenerationActivity>((resolve, reject) => {
			let finished = false;
			const finish = (result?: RpcGenerationActivity, error?: Error) => {
				if (finished) return;
				finished = true;
				if (timer) clearTimeout(timer);
				this.activityWaiters.delete(wake);
				signal?.removeEventListener("abort", abort);
				if (error) reject(error);
				else if (result) resolve(result);
			};
			wake = () => {
				const result = this.activityForGeneration(generation);
				if (result) finish(result);
				else if (this.fatalError || this.exitResult) {
					finish(
						undefined,
						this.fatalError ??
							this.exitResult?.error ??
							new RpcResponseError(
								"Persistent subagent is not running",
								"transport",
							),
					);
				}
			};
			const abort = () =>
				finish(
					undefined,
					new RpcResponseError("RPC activity wait was cancelled", "aborted"),
				);
			this.activityWaiters.add(wake);
			timer = setTimeout(
				() => {
					this.rollbackPrompt(generation);
					finish({ kind: "handled-without-agent", generation });
				},
				Math.max(0, timeoutMs),
			);
			signal?.addEventListener("abort", abort, { once: true });
			wake();
		});
	}

	send(
		command: Record<string, unknown>,
		timeoutMs = RPC_COMMAND_TIMEOUT_MS,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		if (signal?.aborted) {
			return Promise.reject(
				new RpcResponseError("RPC command was cancelled", "aborted"),
			);
		}
		if (this.exitResult || hasExited(this.process) || this.fatalError) {
			return Promise.reject(
				this.exitResult?.error ??
					this.fatalError ??
					new RpcResponseError(
						"Persistent subagent is not running",
						"transport",
					),
			);
		}
		const commandType = String(command.type ?? "unknown");
		const promptGeneration =
			command.type === "prompt" ? this.beginPrompt() : undefined;
		const id = `rpc-${++this.requestSequence}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const pending = this.pending.get(id);
				if (!pending) return;
				this.removePending(id, pending);
				reject(
					new RpcResponseError(
						`RPC command ${commandType} timed out`,
						"timeout",
					),
				);
			}, timeoutMs);
			const pending = {
				commandType,
				promptGeneration,
				resolve,
				reject,
				timer,
				signal,
				abort: undefined as (() => void) | undefined,
			};
			pending.abort = () => {
				if (!this.pending.has(id)) return;
				this.removePending(id, pending);
				this.rollbackPrompt(promptGeneration);
				reject(new RpcResponseError("RPC command was cancelled", "aborted"));
			};
			this.pending.set(id, pending);
			signal?.addEventListener("abort", pending.abort, { once: true });
			this.process.stdin.write(
				`${JSON.stringify({ ...command, id })}\n`,
				(error) => {
					if (!error) return;
					const current = this.pending.get(id);
					if (!current) return;
					this.removePending(id, current);
					this.rollbackPrompt(promptGeneration);
					current.reject(new RpcResponseError(error.message, "transport"));
				},
			);
		});
	}

	terminate(): Promise<void> {
		if (this.terminating) return this.terminating;
		this.terminating = (async () => {
			if (this.exitResult || hasExited(this.process)) {
				await this.exited;
				return;
			}

			if (process.platform === "win32") {
				await signalWindowsTree(this.process, false);
				await Promise.race([
					this.exited.then(() => undefined),
					delay(TERMINATION_GRACE_MS),
				]);
				if (!this.exitResult && !hasExited(this.process)) {
					await signalWindowsTree(this.process, true);
				}
			} else {
				signalUnixTree(this.process, "SIGTERM");
				await Promise.race([
					this.exited.then(() => undefined),
					delay(TERMINATION_GRACE_MS),
				]);
				if (!this.exitResult && !hasExited(this.process)) {
					signalUnixTree(this.process, "SIGKILL");
				}
			}
			await this.exited;
		})();
		return this.terminating;
	}

	private activityForGeneration(
		generation: number,
	): RpcGenerationActivity | undefined {
		if (this.settledGeneration >= generation) {
			return { kind: "settled", generation };
		}
		if (this.startedGeneration >= generation) {
			return { kind: "started", generation };
		}
		return undefined;
	}

	private notifyActivityWaiters(): void {
		for (const wake of [...this.activityWaiters]) wake();
	}

	private beginPrompt(): number {
		this.issuedGeneration = Math.max(
			this.issuedGeneration + 1,
			this.settledGeneration + 1,
		);
		this.running = true;
		return this.issuedGeneration;
	}

	private rollbackPrompt(generation: number | undefined): void {
		if (
			generation === undefined ||
			this.startedGeneration >= generation ||
			this.settledGeneration >= generation ||
			this.issuedGeneration !== generation
		) {
			return;
		}
		this.issuedGeneration = Math.max(this.settledGeneration, generation - 1);
		this.running = this.issuedGeneration > this.settledGeneration;
		this.notifyActivityWaiters();
	}

	private writeRaw(record: Record<string, unknown>): void {
		if (this.exitResult || hasExited(this.process)) return;
		if (!this.process.stdin.writable) {
			this.appendStderr(
				"Cannot answer extension UI request: RPC stdin is not writable\n",
			);
			void this.terminate();
			return;
		}
		this.process.stdin.write(`${JSON.stringify(record)}\n`, (error) => {
			if (error && !this.exitResult) {
				this.appendStderr(
					`Failed to answer extension UI request: ${error.message}\n`,
				);
				void this.terminate();
			}
		});
	}

	private appendStderr(text: string): void {
		this.stderr = boundedTail(
			this.stderr + text,
			MAX_STDERR_BYTES,
			MAX_STDERR_LINES,
		);
		try {
			this.options.onStderr?.(text);
		} catch {
			// Diagnostic callbacks must never escape a child stream handler.
		}
	}

	private removePending(
		id: string,
		pending: {
			timer: ReturnType<typeof setTimeout>;
			abort?: () => void;
			signal?: AbortSignal;
		},
	): void {
		this.pending.delete(id);
		clearTimeout(pending.timer);
		if (pending.abort) {
			pending.signal?.removeEventListener("abort", pending.abort);
		}
	}

	private rejectPending(error: Error): void {
		for (const [id, pending] of this.pending) {
			this.removePending(id, pending);
			pending.reject(error);
		}
	}
}
