// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import type {
	OnUpdateCallback,
	RunProcess,
	SingleResult,
	SubagentDetails,
} from "./types.ts";

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		return msg.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

export function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted"
	);
}

export function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return (
			result.errorMessage ||
			result.stderr ||
			getFinalOutput(result.messages) ||
			"(no output)"
		);
	}
	return getFinalOutput(result.messages) || "(no output)";
}

export function createRejectedResult(
	agents: AgentConfig[],
	agentName: string,
	task: string,
	error: unknown,
	step?: number,
): SingleResult {
	const agent = agents.find((candidate) => candidate.name === agentName);
	const message = error instanceof Error ? error.message : String(error);
	return {
		agent: agentName,
		agentSource: agent?.source ?? "unknown",
		task,
		exitCode: 1,
		messages: [],
		stderr: message,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		extensionMode: agent?.extensionMode ?? "default",
		extensionSources: agent?.extensionSources ?? [],
		model: agent?.model,
		stopReason:
			error instanceof Error && error.name === "AbortError"
				? "aborted"
				: "error",
		errorMessage: message,
		step,
	};
}

async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), "pi-subagent-"),
	);
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, {
			encoding: "utf-8",
			mode: 0o600,
		});
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	runProcess: RunProcess,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((candidate) => candidate.name === agentName);

	if (!agent) {
		const available =
			agents.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			extensionMode: "default",
			extensionSources: [],
			step,
		};
	}

	if (agent.extensionConfigError) {
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: `Agent "${agentName}": ${agent.extensionConfigError}`,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			extensionMode: agent.extensionMode,
			extensionSources: agent.extensionSources,
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.extensionMode === "isolated") {
		args.push("--no-extensions");
		for (const extensionSource of agent.extensionSources)
			args.push("--extension", extensionSource);
	}
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0)
		args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		extensionMode: agent.extensionMode,
		extensionSources: agent.extensionSources,
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [
					{
						type: "text",
						text: getFinalOutput(currentResult.messages) || "(running...)",
					},
				],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await runProcess(
			() =>
				new Promise<number>((resolve) => {
					const invocation = getPiInvocation(args);
					const useProcessGroup = process.platform !== "win32";
					const proc = spawn(invocation.command, invocation.args, {
						cwd: cwd ?? defaultCwd,
						shell: false,
						detached: useProcessGroup,
						stdio: ["ignore", "pipe", "pipe"],
					});
					let buffer = "";
					let closed = false;
					let killTimer: ReturnType<typeof setTimeout> | undefined;

					const processLine = (line: string) => {
						if (!line.trim()) return;
						let event: any;
						try {
							event = JSON.parse(line);
						} catch {
							return;
						}

						if (event.type === "message_end" && event.message) {
							const msg = event.message as Message;
							currentResult.messages.push(msg);

							if (msg.role === "assistant") {
								currentResult.usage.turns++;
								const usage = msg.usage;
								if (usage) {
									currentResult.usage.input += usage.input || 0;
									currentResult.usage.output += usage.output || 0;
									currentResult.usage.cacheRead += usage.cacheRead || 0;
									currentResult.usage.cacheWrite += usage.cacheWrite || 0;
									currentResult.usage.cost += usage.cost?.total || 0;
									currentResult.usage.contextTokens = usage.totalTokens || 0;
								}
								if (!currentResult.model && msg.model)
									currentResult.model = msg.model;
								if (msg.stopReason) currentResult.stopReason = msg.stopReason;
								if (msg.errorMessage)
									currentResult.errorMessage = msg.errorMessage;
							}
							emitUpdate();
						}
					};

					proc.stdout.on("data", (data) => {
						buffer += data.toString();
						const lines = buffer.split("\n");
						buffer = lines.pop() || "";
						for (const line of lines) processLine(line);
					});

					proc.stderr.on("data", (data) => {
						currentResult.stderr += data.toString();
					});

					const signalProcess = (signalName: NodeJS.Signals) => {
						if (process.platform === "win32" && proc.pid) {
							spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
								stdio: "ignore",
							});
							return;
						}
						if (useProcessGroup && proc.pid) {
							try {
								process.kill(-proc.pid, signalName);
								return;
							} catch {
								// Fall back to the direct child if the process group already exited.
							}
						}
						proc.kill(signalName);
					};
					const killProc = () => {
						wasAborted = true;
						if (closed) return;
						signalProcess("SIGTERM");
						killTimer = setTimeout(() => {
							if (!closed) signalProcess("SIGKILL");
						}, 5000);
					};

					proc.on("close", (code) => {
						closed = true;
						if (killTimer) clearTimeout(killTimer);
						signal?.removeEventListener("abort", killProc);
						if (buffer.trim()) processLine(buffer);
						resolve(code ?? 0);
					});

					proc.on("error", (error) => {
						closed = true;
						if (killTimer) clearTimeout(killTimer);
						signal?.removeEventListener("abort", killProc);
						currentResult.errorMessage = error.message;
						currentResult.stderr += `${error.message}\n`;
						resolve(1);
					});

					if (signal?.aborted) killProc();
					else signal?.addEventListener("abort", killProc, { once: true });
				}),
		);

		currentResult.exitCode = wasAborted && exitCode === 0 ? 1 : exitCode;
		if (wasAborted) {
			currentResult.stopReason = "aborted";
			currentResult.errorMessage = "Subagent was aborted";
		}
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}
