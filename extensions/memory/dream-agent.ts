/**
 * Dream agents: the analyzer and the organizer are each their own Pi session (Pi SDK `createAgentSession`) on
 * DeepSeek Flash with high thinking, like the cookbook's transcript-analyzer and memory-organizer.
 *
 * The session loads no discovered extensions, skills, prompt templates, or context files: the full
 * memory extension would inject itself and start dreams inside the dream.
 * It runs in the dream's work directory with Pi's base tools; the prompt keeps it to the notes and the
 * session copies, not the project. One inline extension adds the `memory` tool (the way to change notes;
 * create never overwrites) and maps /memories paths given to
 * read/grep/find/ls onto the notes directory. Its session files go to <memory>/dreams/, never
 * to the project's session directory, so later dreams do not review dreams.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, type ExtensionAPI, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CallUsage } from "./call-log.ts";
import type { AgentRun, AgentTask, DreamAgents } from "./dream.ts";
import { createMemoryTool, MEMORY_TOOL } from "./memory-tool.ts";
import { ANALYZER_AGENT_PROMPT, agentPrompt, analyzeTask, ORGANIZE_TASK, ORGANIZER_AGENT_PROMPT } from "./prompts.ts";
import { MEMORY_ROOT } from "./tool.ts";

/** Pi's base tools, all of them. */
export const BASE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
const PATH_TOOLS = new Set(["read", "grep", "find", "ls"]);

function addUsage(total: CallUsage | null, usage: unknown): CallUsage | null {
	if (!usage || typeof usage !== "object") return total;
	const u = usage as { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } };
	const base = total ?? { input: 0, output: 0, cacheRead: 0, cost: 0 };
	return {
		input: base.input + (u.input ?? 0),
		output: base.output + (u.output ?? 0),
		cacheRead: base.cacheRead + (u.cacheRead ?? 0),
		cost: base.cost + (u.cost?.total ?? 0),
	};
}

export interface DreamAgentOptions {
	agentDir: string;
	notes: string;
	/** Where the agents' own session files go: <memory>/dreams/. */
	dreamsDir: string;
	model: Model<Api> | undefined;
	unavailable?: string;
}

export function createDreamAgents(options: DreamAgentOptions): DreamAgents {
	const { model } = options;
	return {
		model: !model || options.unavailable ? { unavailable: options.unavailable ?? "DeepSeek Flash is unavailable" } : { provider: model.provider, model: model.id },
		async run(task: AgentTask, signal: AbortSignal): Promise<AgentRun> {
			if (!model) throw new Error("DeepSeek Flash is unavailable");
			const notes = options.notes;
			const analyzer = task.role === "analyze";

			const inline = (pi: ExtensionAPI) => {
				pi.registerTool(createMemoryTool({ notes: () => notes, options: { overwrite: false } }));
				pi.on("tool_call", (event) => {
					if (!PATH_TOOLS.has(event.toolName)) return undefined;
					// Agents naturally reuse the memory tool's /memories paths with read/grep; map them to the notes directory.
					const input = event.input as { path?: string };
					if (typeof input.path === "string" && (input.path === MEMORY_ROOT || input.path.startsWith(`${MEMORY_ROOT}/`))) {
						input.path = notes + input.path.slice(MEMORY_ROOT.length);
					}
					return undefined;
				});
			};

			const resourceLoader = new DefaultResourceLoader({
				cwd: task.workDir,
				agentDir: options.agentDir,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPrompt: agentPrompt(analyzer ? ANALYZER_AGENT_PROMPT : ORGANIZER_AGENT_PROMPT, notes, new Date()),
				extensionFactories: [{ name: `memory-dream-${task.role}`, factory: inline }],
			});
			await resourceLoader.reload();
			const { session } = await createAgentSession({
				cwd: task.workDir,
				agentDir: options.agentDir,
				model,
				thinkingLevel: "high",
				resourceLoader,
				tools: [...BASE_TOOLS, MEMORY_TOOL],
				sessionManager: SessionManager.create(task.workDir, options.dreamsDir),
				settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } }),
			});

			let usage: CallUsage | null = null;
			let toolCalls = 0;
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "assistant") usage = addUsage(usage, event.message.usage);
				if (event.type === "tool_execution_start") toolCalls += 1;
			});
			const onAbort = () => void session.abort();
			signal.addEventListener("abort", onAbort, { once: true });
			try {
				if (signal.aborted) throw new Error("aborted");
				await session.prompt(analyzer ? analyzeTask(task.transcripts ?? []) : ORGANIZE_TASK);
				const last = [...session.messages].reverse().find((message) => message.role === "assistant") as
					| { stopReason?: string; errorMessage?: string }
					| undefined;
				const stopReason = last?.stopReason ?? "error";
				const ok = !signal.aborted && stopReason === "stop";
				return {
					ok,
					error: ok ? undefined : (last?.errorMessage ?? (signal.aborted ? "aborted" : `stopped: ${stopReason}`)),
					stopReason,
					usage,
					toolCalls,
					finalText: session.getLastAssistantText() ?? "",
					sessionFile: session.sessionFile,
				};
			} finally {
				signal.removeEventListener("abort", onAbort);
				unsubscribe();
				session.dispose();
			}
		},
	};
}
