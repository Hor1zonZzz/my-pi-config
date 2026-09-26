import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { cleanStderr, describeToolCall, finalOutput, preview, stripTerminalEscapes, tail } from "./format.ts";
import { LiveRun, newSnapshot, type RunGroup, type RunMode, type RunRegistry, type RunSnapshot } from "./runs.ts";
import { ensureDir, parentSessionDir, writeMeta } from "./store.ts";

const MAX_TOOL_CALLS = 200;
const MAX_STDERR = 16 * 1024;
/** After abort and closing stdin, how long Pi gets to shut down before SIGTERM. */
const STOP_GRACE_MS = 2000;
const KILL_GRACE_MS = 5000;
/** Set in every child so a subagent cannot start background subagents of its own. */
export const CHILD_ENV = "PI_SUBAGENT_CHILD";
/** Pi's RPC dialogs; they block until answered, and a subagent has nobody to ask. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface RunRequest {
	agent: AgentConfig;
	task: string;
	cwd: string;
	defaults: DispatchDefaults;
	mode: RunMode;
	group: RunGroup;
	parentSessionId: string;
	jobId?: string;
	/** The parent tool call or background job. Aborting it aborts the run and makes runAgent throw. */
	signal?: AbortSignal;
	registry: RunRegistry;
	onChange?: (run: LiveRun) => void;
}

/** How to start the same Pi that runs this extension. */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const filePath = path.join(dir, `prompt-${agentName.replace(/[^\w.-]+/g, "_")}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir, filePath };
}

export function buildArgs(request: RunRequest, id: string, sessionDir: string, promptFile?: string): string[] {
	const { agent, defaults } = request;
	// RPC mode keeps stdin open for commands; the task arrives as the first prompt.
	// Persist the child session instead of --no-session so /subagent-history can show it.
	const args = ["--mode", "rpc", "--session-dir", sessionDir, "--session-id", id, "--name", `${agent.name} · ${preview(request.task, 60)}`];
	const inheritsDispatchModel = !agent.model;
	const model = agent.model ?? defaults.model;
	const thinkingLevel = agent.thinkingLevel ?? (inheritsDispatchModel ? defaults.thinkingLevel : undefined);
	if (model) args.push("--model", model);
	if (thinkingLevel) args.push("--thinking", thinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (promptFile) args.push("--append-system-prompt", promptFile);
	return args;
}

/** The first RPC command: the task itself. */
export function taskCommand(task: string): string {
	return `${JSON.stringify({ id: "task", type: "prompt", message: `Task: ${task}` })}\n`;
}

/** Apply one JSON-mode event from the child to the live run. Returns true when state changed. */
export function applyEvent(run: LiveRun, event: any): boolean {
	const s = run.snapshot;
	switch (event?.type) {
		case "message_start":
			if (event.message?.role === "assistant") {
				run.streaming = { thinking: "", text: "" };
				s.activity = "thinking";
				return true;
			}
			return false;
		case "message_update": {
			const update = event.assistantMessageEvent;
			if (!run.streaming) run.streaming = { thinking: "", text: "" };
			if (update?.type === "text_delta" && typeof update.delta === "string") {
				run.streaming.text += update.delta;
				s.activity = "writing";
			} else if (update?.type === "thinking_delta" && typeof update.delta === "string") {
				run.streaming.thinking += update.delta;
				s.activity = "thinking";
			} else if (update?.type === "toolcall_start") {
				s.activity = `calling ${update.toolName ?? "a tool"}`;
			} else {
				return false;
			}
			return true;
		}
		case "message_end": {
			const message = event.message as Message | undefined;
			if (!message || typeof message.role !== "string") return false;
			run.messages.push(message);
			if (message.role === "assistant") {
				run.streaming = undefined;
				s.usage.turns++;
				const usage = message.usage;
				if (usage) {
					s.usage.input += usage.input || 0;
					s.usage.output += usage.output || 0;
					s.usage.cacheRead += usage.cacheRead || 0;
					s.usage.cacheWrite += usage.cacheWrite || 0;
					s.usage.cost += usage.cost?.total || 0;
					s.usage.contextTokens = usage.totalTokens || 0;
				}
				if (!s.model && message.model) s.model = message.model;
				if (message.stopReason) s.stopReason = message.stopReason;
				if (message.errorMessage) s.errorMessage = message.errorMessage;
				const output = finalOutput(run.messages);
				if (output) s.output = output;
			}
			return true;
		}
		case "tool_execution_start": {
			const described = describeToolCall(String(event.toolName ?? "tool"), event.args);
			s.activity = described;
			if (s.toolCalls.length < MAX_TOOL_CALLS) s.toolCalls.push(described);
			return true;
		}
		case "tool_execution_end":
			s.activity = "thinking";
			return true;
		case "auto_retry_start":
			s.activity = `retrying (${event.attempt ?? "?"}/${event.maxAttempts ?? "?"})`;
			return true;
		case "compaction_start":
			s.activity = "compacting context";
			return true;
		default:
			return false;
	}
}

function settle(run: LiveRun, exitCode: number, stderr: string, parentAborted = false): void {
	const s = run.snapshot;
	s.exitCode = exitCode;
	s.endedAt = Date.now();
	s.activity = undefined;
	run.streaming = undefined;
	const cleaned = cleanStderr(stderr);
	if (cleaned) s.stderr = tail(cleaned, MAX_STDERR);
	if (run.stoppedByUser || parentAborted) {
		s.status = "cancelled";
		s.output = run.stoppedByUser ? "Stopped by the user before it finished." : "Cancelled with the parent operation.";
		return;
	}
	const failed = exitCode !== 0 || s.stopReason === "error" || s.stopReason === "aborted";
	s.status = failed ? "failed" : "completed";
	if (failed) s.output = s.errorMessage || s.stderr || s.output || "(no output)";
	else s.output = finalOutput(run.messages) || "(no output)";
}

/**
 * Run one subagent to completion. A user stop resolves with status
 * "cancelled"; an aborted parent signal throws after the child exits.
 */
export async function runAgent(request: RunRequest): Promise<LiveRun> {
	request.signal?.throwIfAborted();
	const id = randomUUID();
	const sessionDir = parentSessionDir(request.parentSessionId);
	const run = new LiveRun(
		newSnapshot({
			id,
			parentSessionId: request.parentSessionId,
			agent: request.agent.name,
			agentSource: request.agent.source,
			task: request.task,
			cwd: request.cwd,
			mode: request.mode,
			group: request.group,
			model: request.agent.model ?? request.defaults.model,
			sessionDir,
			jobId: request.jobId,
		}),
	);
	const changed = () => {
		request.registry.emit(run);
		request.onChange?.(run);
	};
	const parentAbort = () => run.controller.abort();
	request.signal?.addEventListener("abort", parentAbort, { once: true });

	let promptDir: string | undefined;
	let stderr = "";
	try {
		ensureDir(sessionDir);
		let promptFile: string | undefined;
		if (request.agent.systemPrompt.trim()) {
			const temp = await writePromptToTempFile(request.agent.name, request.agent.systemPrompt);
			promptDir = temp.dir;
			promptFile = temp.filePath;
		}
		writeMeta(run.snapshot);
		request.registry.add(run);
		request.onChange?.(run);

		const exitCode = await new Promise<number>((resolve) => {
			if (run.controller.signal.aborted) {
				resolve(1);
				return;
			}
			const invocation = getPiInvocation(buildArgs(request, id, sessionDir, promptFile));
			const proc = spawn(invocation.command, invocation.args, {
				cwd: request.cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, [CHILD_ENV]: "1" },
			});
			// A child that exits early closes the pipe; its exit code tells the story.
			proc.stdin.on("error", () => {});
			const send = (record: object) => {
				if (!proc.stdin.destroyed && proc.stdin.writable) proc.stdin.write(`${JSON.stringify(record)}\n`);
			};
			// Closing stdin asks Pi for an orderly shutdown once it has nothing left to do.
			const endInput = () => {
				if (!proc.stdin.destroyed && !proc.stdin.writableEnded) proc.stdin.end();
			};
			let buffer = "";
			const processLine = (line: string) => {
				const text = stripTerminalEscapes(line.replace(/\r$/, ""));
				if (!text.trim()) return;
				let record: any;
				try {
					record = JSON.parse(text);
				} catch {
					return;
				}
				if (record?.type === "response") {
					if (record.command === "prompt" && record.success === false) {
						run.snapshot.stopReason = "error";
						run.snapshot.errorMessage = String(record.error ?? "The subagent rejected its task.");
						endInput();
					}
					return;
				}
				if (record?.type === "extension_ui_request") {
					if (DIALOG_METHODS.has(record.method)) send({ type: "extension_ui_response", id: record.id, cancelled: true });
					return;
				}
				if (record?.type === "agent_settled") {
					endInput();
					return;
				}
				if (applyEvent(run, record)) changed();
			};
			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				stderr = tail(stderr + data.toString(), MAX_STDERR * 2);
			});
			proc.stdin.write(taskCommand(request.task));
			const timers: Array<ReturnType<typeof setTimeout>> = [];
			const alive = () => proc.exitCode === null && proc.signalCode === null;
			const stop = () => {
				send({ type: "abort" });
				endInput();
				// kill() only sends a signal; escalate while the process is still alive.
				timers.push(setTimeout(() => {
					if (!alive()) return;
					proc.kill("SIGTERM");
					timers.push(setTimeout(() => {
						if (alive()) proc.kill("SIGKILL");
					}, KILL_GRACE_MS));
				}, STOP_GRACE_MS));
			};
			run.controller.signal.addEventListener("abort", stop, { once: true });
			proc.on("close", (code) => {
				for (const timer of timers) clearTimeout(timer);
				run.controller.signal.removeEventListener("abort", stop);
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 1);
			});
			proc.on("error", (error) => {
				stderr += error.message;
				resolve(1);
			});
		});

		settle(run, exitCode, stderr, request.signal?.aborted);
		writeMeta(run.snapshot);
		changed();
		if (request.signal?.aborted) throw new Error("Subagent was aborted");
		return run;
	} catch (error) {
		if (run.running) {
			settle(run, 1, stderr || (error instanceof Error ? error.message : String(error)), request.signal?.aborted);
			writeMeta(run.snapshot);
			changed();
		}
		throw error;
	} finally {
		request.signal?.removeEventListener("abort", parentAbort);
		if (promptDir) fs.rmSync(promptDir, { recursive: true, force: true });
	}
}

export function isFailed(snapshot: RunSnapshot): boolean {
	return snapshot.status === "failed" || snapshot.status === "cancelled";
}
