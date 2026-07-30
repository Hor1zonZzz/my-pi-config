// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import { spawn } from "node:child_process";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import type { BuiltinToolBroker } from "./broker.ts";

const RUNTIME_PATH = fileURLToPath(
	new URL("./runtime-host.mjs", import.meta.url),
);
const NODE_EXECUTABLE =
	process.env.PI_CODE_MODE_NODE ??
	(!process.versions.bun && basename(process.execPath).startsWith("node")
		? process.execPath
		: "node");
const STARTUP_TIMEOUT_MS = 3_000;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_PROTOCOL_LINE_BYTES = 24 * 1024 * 1024;
const MAX_CONCURRENT_TOOLS = 8;
const MAX_TOOL_CALLS = 64;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2_000;
const MAX_OUTPUT_ITEMS = 256;
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

export interface CodeModeDetails {
	durationMs: number;
	toolCalls: number;
	toolsUsed: string[];
}

export class RuntimeStartupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RuntimeStartupError";
	}
}

export class CodeModeExecutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodeModeExecutionError";
	}
}

function createLimiter(limit: number, signal: AbortSignal) {
	let active = 0;
	const waiting: Array<() => void> = [];

	function release(): void {
		active -= 1;
		waiting.shift()?.();
	}

	return async function run<T>(operation: () => Promise<T>): Promise<T> {
		if (active >= limit) {
			await new Promise<void>((resolve, reject) => {
				const start = () => {
					signal.removeEventListener("abort", abort);
					resolve();
				};
				const abort = () => {
					const index = waiting.indexOf(start);
					if (index >= 0) waiting.splice(index, 1);
					reject(new Error("Code Mode execution aborted."));
				};
				waiting.push(start);
				signal.addEventListener("abort", abort, { once: true });
			});
		}
		if (signal.aborted) throw new Error("Code Mode execution aborted.");
		active += 1;
		try {
			return await operation();
		} finally {
			release();
		}
	};
}

function formatRuntimeError(
	message: string,
	stack: unknown,
	stderr: string,
): string {
	const parts = [message];
	if (typeof stack === "string" && stack.trim()) parts.push(stack.trim());
	if (stderr.trim()) parts.push(`Runtime stderr:\n${stderr.trim()}`);
	return parts.join("\n\n");
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function validateRuntimeOutput(
	value: unknown,
): Array<
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
> {
	if (!Array.isArray(value) || value.length > MAX_OUTPUT_ITEMS) {
		throw new CodeModeExecutionError(
			"Code Mode runtime returned invalid output.",
		);
	}
	let textBytes = 0;
	let textLines = 0;
	let images = 0;
	let imageBytes = 0;
	return value.map((candidate) => {
		const item = record(candidate);
		if (!item) {
			throw new CodeModeExecutionError(
				"Code Mode runtime returned an invalid output item.",
			);
		}
		if (item.type === "text" && typeof item.text === "string") {
			const text = item.text;
			textBytes += Buffer.byteLength(text, "utf8");
			textLines += text.length === 0 ? 0 : text.split("\n").length;
			if (textBytes > MAX_OUTPUT_BYTES || textLines > MAX_OUTPUT_LINES) {
				throw new CodeModeExecutionError(
					"Code Mode runtime exceeded text output limits.",
				);
			}
			return { type: "text" as const, text };
		}
		if (
			item.type === "image" &&
			typeof item.data === "string" &&
			typeof item.mimeType === "string"
		) {
			const data = item.data;
			const mimeType = item.mimeType.toLowerCase();
			if (
				!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) ||
				!/^[A-Za-z0-9+/]*={0,2}$/.test(data)
			) {
				throw new CodeModeExecutionError(
					"Code Mode runtime returned an invalid image.",
				);
			}
			const bytes = Buffer.byteLength(data, "base64");
			images += 1;
			imageBytes += bytes;
			if (
				images > MAX_IMAGES ||
				bytes > MAX_IMAGE_BYTES ||
				imageBytes > MAX_TOTAL_IMAGE_BYTES
			) {
				throw new CodeModeExecutionError(
					"Code Mode runtime exceeded image output limits.",
				);
			}
			return { type: "image" as const, data, mimeType };
		}
		throw new CodeModeExecutionError(
			"Code Mode runtime returned an invalid output item.",
		);
	});
}

export async function executeCodeCell(options: {
	code: string;
	timeoutMs: number;
	createBroker(signal: AbortSignal): BuiltinToolBroker;
	signal: AbortSignal | undefined;
	onUpdate: AgentToolUpdateCallback<CodeModeDetails> | undefined;
	toolCallId: string;
}): Promise<AgentToolResult<CodeModeDetails>> {
	if (options.signal?.aborted) {
		throw new CodeModeExecutionError("Code Mode execution aborted.");
	}
	const startedAt = Date.now();
	const controller = new AbortController();
	const abortFromParent = () => controller.abort();
	if (options.signal?.aborted) controller.abort();
	else
		options.signal?.addEventListener("abort", abortFromParent, { once: true });

	const child = spawn(
		NODE_EXECUTABLE,
		[
			"--max-old-space-size=128",
			"--permission",
			`--allow-fs-read=${RUNTIME_PATH}`,
			RUNTIME_PATH,
		],
		{
			cwd: process.cwd(),
			env: {
				NODE_NO_WARNINGS: "1",
				PATH: process.env.PATH ?? "",
			},
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		},
	);
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	const broker = options.createBroker(controller.signal);
	const runLimited = createLimiter(MAX_CONCURRENT_TOOLS, controller.signal);
	const toolsUsed = new Set<string>();
	const seenToolCallIds = new Set<string>();
	let toolCalls = 0;
	let completedToolCalls = 0;
	let stderr = "";
	let ready = false;
	let settled = false;
	let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

	function details(): CodeModeDetails {
		return {
			durationMs: Date.now() - startedAt,
			toolCalls,
			toolsUsed: Array.from(toolsUsed).sort((a, b) => a.localeCompare(b)),
		};
	}

	function writeMessage(message: unknown): void {
		if (!child.stdin.writable) {
			throw new Error("Code Mode runtime input closed unexpectedly.");
		}
		const line = `${JSON.stringify(message)}\n`;
		if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
			throw new Error("Code Mode protocol message exceeded the 24MB limit.");
		}
		child.stdin.write(line);
	}

	function stopChild(): void {
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.kill("SIGTERM");
		forceKillTimer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
			}
		}, 500);
		forceKillTimer.unref?.();
	}

	const abortChild = () => {
		controller.abort();
		stopChild();
	};
	if (controller.signal.aborted) stopChild();
	else controller.signal.addEventListener("abort", stopChild, { once: true });

	child.stderr.on("data", (chunk: Buffer) => {
		if (Buffer.byteLength(stderr, "utf8") >= MAX_STDERR_BYTES) return;
		stderr += chunk.toString("utf8");
		if (Buffer.byteLength(stderr, "utf8") > MAX_STDERR_BYTES) {
			stderr = Buffer.from(stderr, "utf8")
				.subarray(0, MAX_STDERR_BYTES)
				.toString("utf8");
		}
	});

	return new Promise<AgentToolResult<CodeModeDetails>>((resolve, reject) => {
		const startupTimer = setTimeout(() => {
			if (ready || settled) return;
			settleReject(
				new RuntimeStartupError(
					`Code Mode runtime did not become ready within ${STARTUP_TIMEOUT_MS}ms.`,
				),
			);
		}, STARTUP_TIMEOUT_MS);
		const executionTimer = setTimeout(() => {
			if (settled) return;
			settleReject(
				new CodeModeExecutionError(
					`Code Mode cell exceeded its ${options.timeoutMs / 1000}s timeout.`,
				),
			);
		}, options.timeoutMs + STARTUP_TIMEOUT_MS);

		function cleanup(): void {
			clearTimeout(startupTimer);
			clearTimeout(executionTimer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			options.signal?.removeEventListener("abort", abortFromParent);
			controller.signal.removeEventListener("abort", stopChild);
			lines.close();
			stopChild();
		}

		function settleResolve(result: AgentToolResult<CodeModeDetails>): void {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		}

		function settleReject(error: Error): void {
			if (settled) return;
			settled = true;
			controller.abort();
			cleanup();
			reject(error);
		}

		async function handleToolCall(
			message: Record<string, unknown>,
		): Promise<void> {
			const id = String(message.id ?? "");
			const name = String(message.name ?? "");
			toolCalls += 1;
			if (
				!id ||
				!name ||
				seenToolCallIds.has(id) ||
				toolCalls > MAX_TOOL_CALLS
			) {
				writeMessage({
					type: "tool_error",
					id,
					message:
						toolCalls > MAX_TOOL_CALLS
							? `Code Mode is limited to ${MAX_TOOL_CALLS} nested tool calls.`
							: "Code Mode received an invalid or duplicate nested tool call.",
				});
				return;
			}
			seenToolCallIds.add(id);
			toolsUsed.add(name);
			try {
				const result = await runLimited(() =>
					broker.execute(
						name,
						message.input,
						`${options.toolCallId}:nested:${id}`,
					),
				);
				completedToolCalls += 1;
				options.onUpdate?.({
					content: [
						{
							type: "text",
							text: `Code Mode · ${completedToolCalls}/${toolCalls} nested calls complete`,
						},
					],
					details: details(),
				});
				writeMessage({ type: "tool_result", id, result });
			} catch (error) {
				writeMessage({
					type: "tool_error",
					id,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}

		lines.on("line", (line) => {
			if (settled) return;
			if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
				settleReject(
					new CodeModeExecutionError(
						"Code Mode runtime emitted a protocol message larger than 24MB.",
					),
				);
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				settleReject(
					ready
						? new CodeModeExecutionError(
								"Code Mode runtime emitted invalid JSON.",
							)
						: new RuntimeStartupError(
								"Code Mode runtime emitted invalid JSON.",
							),
				);
				return;
			}
			const message = record(parsed);
			if (!message) {
				settleReject(
					new CodeModeExecutionError(
						"Code Mode runtime emitted an invalid protocol object.",
					),
				);
				return;
			}
			if (message.type === "ready") {
				if (ready || message.protocol !== 1) {
					settleReject(
						new RuntimeStartupError("Unsupported Code Mode runtime protocol."),
					);
					return;
				}
				ready = true;
				clearTimeout(startupTimer);
				try {
					writeMessage({
						type: "execute",
						code: options.code,
						timeoutMs: options.timeoutMs,
						tools: broker.toolDefinitions,
					});
				} catch (error) {
					settleReject(
						new RuntimeStartupError(
							error instanceof Error ? error.message : String(error),
						),
					);
				}
				return;
			}
			if (!ready) {
				settleReject(
					new RuntimeStartupError(
						"Code Mode runtime sent data before its ready message.",
					),
				);
				return;
			}
			if (message.type === "tool_call") {
				void handleToolCall(message).catch((error) =>
					settleReject(
						new CodeModeExecutionError(
							error instanceof Error ? error.message : String(error),
						),
					),
				);
				return;
			}
			if (message.type === "complete") {
				try {
					settleResolve({
						content: validateRuntimeOutput(message.output),
						details: details(),
					});
				} catch (error) {
					settleReject(
						error instanceof CodeModeExecutionError
							? error
							: new CodeModeExecutionError(String(error)),
					);
				}
				return;
			}
			if (message.type === "error") {
				settleReject(
					new CodeModeExecutionError(
						formatRuntimeError(
							String(message.message ?? "Code Mode cell failed."),
							message.stack,
							stderr,
						),
					),
				);
				return;
			}
			settleReject(
				new CodeModeExecutionError(
					`Unknown Code Mode runtime message: ${String(message.type)}`,
				),
			);
		});

		child.stdin.once("error", (error) => {
			settleReject(
				ready
					? new CodeModeExecutionError(error.message)
					: new RuntimeStartupError(error.message),
			);
		});
		child.once("error", (error) => {
			settleReject(
				ready
					? new CodeModeExecutionError(error.message)
					: new RuntimeStartupError(error.message),
			);
		});
		child.once("exit", (code, signal) => {
			if (settled) return;
			if (controller.signal.aborted) {
				settleReject(
					new CodeModeExecutionError("Code Mode execution aborted."),
				);
				return;
			}
			const suffix = stderr.trim() ? `\n${stderr.trim()}` : "";
			const message = `Code Mode runtime exited unexpectedly (${signal ?? code ?? "unknown"}).${suffix}`;
			settleReject(
				ready
					? new CodeModeExecutionError(message)
					: new RuntimeStartupError(message),
			);
		});
		controller.signal.addEventListener(
			"abort",
			() => {
				if (!settled) {
					settleReject(
						new CodeModeExecutionError("Code Mode execution aborted."),
					);
				}
			},
			{ once: true },
		);
	}).finally(() => {
		abortChild();
	});
}
