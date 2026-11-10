/**
 * Per-project memory for Pi.
 *
 * - Injection: a `memory` system-prompt section says what memory is for and lists the index. The index
 *   is frozen at session start (and refreshed after compaction) so the injected bytes do not change
 *   mid-session and prompt caches keep hitting.
 * - Active memory: the `memory` tool (Anthropic memory tool commands) over /memories.
 * - Passive memory (experimental): after each settled turn, Jev on OpenRouter judges the turn and
 *   DeepSeek Flash writes one note when it is worth keeping.
 * - Dream: DeepSeek Flash checks notes against past transcripts and tidies them, on demand or daily.
 * - /memory: a SettingsList panel for the switches, notes, dreams, and call history.
 */
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type CallUsage, pruneCalls, pruneDreamSessions, readCalls } from "./call-log.ts";
import { capture } from "./capture.ts";
import { DREAM_INTERVAL_MS, DREAM_MIN_NEW_SESSIONS, dream } from "./dream.ts";
import { createDreamAgents } from "./dream-agent.ts";
import { createMemoryTool, MEMORY_TOOL } from "./memory-tool.ts";
import { createMemoryPanel } from "./panel.ts";
import type { ModelPort } from "./port.ts";
import { memoryPromptSection, PROMPT_SECTION } from "./prompts.ts";
import {
	acquireDreamLock,
	appendLog,
	deleteNote,
	indexForPrompt,
	listNotes,
	type MemoryConfig,
	memoryDir,
	notesDir,
	readConfig,
	readLog,
	rebuildIndex,
	writeConfig,
} from "./store.ts";
import { buildWindow, type LooseEntry, messagesFromEntries, sessionsSince, splitTurns } from "./transcript.ts";

const TOOL_NAME = MEMORY_TOOL;
const STATUS_KEY = "memory";
const JEV_PROVIDER = "openrouter";
const JEV_MODEL = "~typesafe/jev-latest";
const WRITER_PROVIDER = "deepseek";
const WRITER_MODEL = "deepseek-flash";
const JUDGE_TURNS = 2;
const JUDGE_CHARS = 12_000;
const WRITER_TURNS = 3;
const WRITER_CHARS = 24_000;
const MAX_QUEUED_CAPTURES = 3;

function toUsage(usage: unknown): CallUsage | null {
	if (!usage || typeof usage !== "object") return null;
	const u = usage as { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } };
	return { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cost: u.cost?.total ?? 0 };
}

/** Jev and DeepSeek through Pi's public model registry; auth comes from auth.json, /login, or env. */
function modelPort(ctx: ExtensionContext): ModelPort {
	const registry = ctx.modelRegistry;
	const jev = registry.getModelOfType("classifier", JEV_PROVIDER, JEV_MODEL);
	const flash = registry.find(WRITER_PROVIDER, WRITER_MODEL);
	const judge = !jev
		? { unavailable: `Pi has no ${JEV_PROVIDER}/${JEV_MODEL} classifier` }
		: !registry.getProviderAuthStatus(JEV_PROVIDER).configured
			? { unavailable: "OpenRouter is not logged in (/login or OPENROUTER_API_KEY)" }
			: { provider: JEV_PROVIDER, model: JEV_MODEL };
	const writer = !flash
		? { unavailable: `Pi has no ${WRITER_PROVIDER}/${WRITER_MODEL} model` }
		: !registry.getProviderAuthStatus(WRITER_PROVIDER).configured
			? { unavailable: "DeepSeek is not logged in" }
			: { provider: WRITER_PROVIDER, model: WRITER_MODEL };
	return {
		judge,
		writer,
		async classify(state, questions, signal) {
			if (!jev) throw new Error("Jev is unavailable");
			const result = await registry.classify(jev, { state, questions } as Parameters<typeof registry.classify>[1], { signal });
			return {
				answers: result.answers as Record<string, unknown>,
				usage: toUsage(result.usage),
				stopReason: result.stopReason,
				error: result.errorMessage,
			};
		},
		async write(systemPrompt, user, reasoning, signal) {
			if (!flash) throw new Error("DeepSeek Flash is unavailable");
			const message = await registry
				.streamSimple(flash, { systemPrompt, messages: [{ role: "user", content: user, timestamp: Date.now() }] }, { reasoning, signal })
				.result();
			const text = message.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("");
			return { text, usage: toUsage(message.usage), stopReason: message.stopReason, error: message.errorMessage };
		},
	};
}

export default function memoryExtension(pi: ExtensionAPI) {
	let dir: string | undefined;
	let notes: string | undefined;
	let sessionId = "";
	let sessionDir = "";
	let project = "";
	let config: MemoryConfig | undefined;
	/** The index injected this session; changes only on enable, session start, and compaction. */
	let frozenIndex: string | undefined;
	let wroteThisRun = false;
	let passiveWrites = 0;
	let noteCount = 0;
	let controller = new AbortController();
	let queue: Promise<void> = Promise.resolve();
	let queued = 0;
	let dreamRunning = false;
	let ui: ExtensionContext["ui"] | undefined;
	const warned = new Set<string>();

	const notify = (text: string, level: "info" | "warning" | "error" = "info") => {
		try {
			ui?.notify(text, level);
		} catch {
			// The UI of a replaced session is gone.
		}
	};
	const warnOnce = (key: string, text: string) => {
		if (warned.has(key)) return;
		warned.add(key);
		notify(text, "warning");
	};
	const refreshStatus = () => {
		try {
			if (!ui) return;
			if (!config?.enabled) {
				ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			const extra = `${passiveWrites ? ` +${passiveWrites}` : ""}${dreamRunning ? " · dreaming" : ""}`;
			ui.setStatus(STATUS_KEY, `mem ${noteCount}${extra}`);
		} catch {}
	};
	const recount = async () => {
		if (notes) noteCount = (await listNotes(notes)).length;
		refreshStatus();
	};
	const applyToolState = () => {
		const active = pi.getActiveTools().filter((name) => name !== TOOL_NAME);
		pi.setActiveTools(config?.enabled ? [...active, TOOL_NAME] : active);
	};
	const freeze = async () => {
		if (notes) frozenIndex = indexForPrompt(await rebuildIndex(notes));
	};
	const updateConfig = async (change: Partial<MemoryConfig>) => {
		if (!dir) return;
		const latest = { ...(await readConfig(dir)), ...change };
		await writeConfig(dir, latest);
		config = latest;
	};

	pi.registerTool(
		createMemoryTool({
			notes: () => (config?.enabled ? notes : undefined),
			offMessage: "Memory is off for this project. The user can turn it on with /memory.",
			onWrite: () => {
				wroteThisRun = true;
				void recount();
			},
		}),
	);

	async function runDream(ctx: ExtensionContext, trigger: "manual" | "auto"): Promise<void> {
		if (!dir || !notes) return;
		if (dreamRunning) {
			notify("Dream 已经在运行。");
			return;
		}
		const release = await acquireDreamLock(dir);
		if (!release) {
			notify("另一个 Pi 进程正在为这个项目运行 Dream。", "warning");
			return;
		}
		dreamRunning = true;
		refreshStatus();
		const signal = controller.signal;
		try {
			const since = (await readConfig(dir)).lastDreamAt ?? 0;
			const flash = ctx.modelRegistry.find(WRITER_PROVIDER, WRITER_MODEL);
			const unavailable = !flash
				? `Pi has no ${WRITER_PROVIDER}/${WRITER_MODEL} model`
				: !ctx.modelRegistry.getProviderAuthStatus(WRITER_PROVIDER).configured
					? "DeepSeek is not logged in"
					: undefined;
			const agents = createDreamAgents({ agentDir: getAgentDir(), notes, dreamsDir: join(dir, "dreams"), model: flash, unavailable });
			const result = await dream({ dir, notes, sessionDir, session: sessionId, since, agents, signal });
			if (signal.aborted || result.status === "aborted") return;
			if (result.readUntil !== undefined && result.readUntil > since) await updateConfig({ lastDreamAt: result.readUntil });
			if (result.status === "unavailable") notify(`Dream 无法运行：${result.reason}`, "warning");
			else if (result.status === "error") notify(`Dream 失败：${result.reason}（详见 calls.jsonl）`, "error");
			else if (result.status === "nothing") {
				if (trigger === "manual") notify("Dream：上次整理之后没有新会话。");
			} else {
				notify(
					`Dream 完成：读取 ${result.sessions} 个会话${result.failedSessions ? `（${result.failedSessions} 个失败）` : ""}${result.organizeFailed ? "，整理失败" : ""} · 新增 ${result.created} · 修改 ${result.updated} · 删除 ${result.deleted}（含被动 ${result.removedPassive}）· 验证被动笔记 ${result.confirmed}`,
				);
			}
			await recount();
		} catch (error) {
			if (!signal.aborted) notify(`Dream 失败：${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			dreamRunning = false;
			await release();
			if (!signal.aborted) refreshStatus();
		}
	}

	pi.registerCommand("memory", {
		description: "Open this project's memory panel: switches, notes, dreams, and model call history",
		handler: async (_args, ctx) => {
			const cfg = config;
			if (!dir || !notes || !cfg) return;
			const currentNotes = await listNotes(notes);
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					`memory ${cfg.enabled ? "on" : "off"} · passive ${cfg.passive ? "on" : "off"} · ${currentNotes.length} notes · ${dir}`,
					"info",
				);
				return;
			}
			const [calls, log, fresh] = await Promise.all([
				readCalls(dir),
				readLog(dir),
				sessionsSince(sessionDir, cfg.lastDreamAt ?? 0, sessionId),
			]);
			const memDir = dir;
			const memNotes = notes;
			await ctx.ui.custom<void>((tui, theme, keybindings, done) =>
				createMemoryPanel(
					{ project, dir: memDir, config: cfg, notes: currentNotes, calls, newSessions: fresh.length, dreamRunning, log },
					{
						setEnabled: async (value) => {
							await updateConfig({ enabled: value });
							if (value && frozenIndex === undefined) await freeze();
							applyToolState();
							await recount();
						},
						setPassive: async (value) => updateConfig({ passive: value }),
						setDreamAuto: async (value) => updateConfig({ dreamAuto: value }),
						deleteNote: async (note) => {
							await deleteNote(memNotes, note.path);
							await rebuildIndex(memNotes);
							await appendLog(memDir, `user deleted ${note.name}`);
							await recount();
						},
						runDream: () => void runDream(ctx, "manual"),
					},
					tui,
					theme,
					keybindings,
					() => done(),
				),
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		controller = new AbortController();
		warned.clear();
		passiveWrites = 0;
		queued = 0;
		queue = Promise.resolve();
		ui = ctx.hasUI ? ctx.ui : undefined;
		dir = memoryDir(getAgentDir(), ctx.cwd);
		notes = notesDir(dir);
		project = ctx.cwd.split(/[/\\]/).filter(Boolean).pop() ?? ctx.cwd;
		sessionId = ctx.sessionManager.getSessionId();
		sessionDir = ctx.sessionManager.getSessionDir();
		config = await readConfig(dir);
		frozenIndex = undefined;
		if (config.enabled) await freeze();
		applyToolState();
		await recount();
		void pruneCalls(dir).catch(() => {});
		void pruneDreamSessions(dir).catch(() => {});
		// Print and JSON modes end the process once the agent settles, so background work stays off.
		if (!ctx.hasUI || !config.enabled || !config.dreamAuto) return;
		const since = config.lastDreamAt ?? 0;
		if (Date.now() - since < DREAM_INTERVAL_MS) return;
		const fresh = await sessionsSince(sessionDir, since, sessionId);
		if (fresh.length >= DREAM_MIN_NEW_SESSIONS) void runDream(ctx, "auto");
	});

	pi.on("before_agent_start", (event) => {
		wroteThisRun = false;
		if (!config?.enabled || frozenIndex === undefined) return;
		event.systemPromptOptions.sections ??= {};
		event.systemPromptOptions.sections[PROMPT_SECTION] = memoryPromptSection(frozenIndex);
	});

	pi.on("session_compact", async () => {
		// Compaction already rebuilt the context, so refreshing the index costs no extra cache miss.
		if (config?.enabled) await freeze();
	});

	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted || !ctx.hasUI || !dir || !notes || !config?.enabled || !config.passive) return;
		if (wroteThisRun) return;
		if (queued >= MAX_QUEUED_CAPTURES) return;
		const turns = splitTurns(messagesFromEntries(ctx.sessionManager.getBranch() as unknown as LooseEntry[]));
		const judgeWindow = buildWindow(turns, JUDGE_TURNS, JUDGE_CHARS);
		const writerWindow = buildWindow(turns, WRITER_TURNS, WRITER_CHARS);
		if (!judgeWindow || !writerWindow) return;
		const port = modelPort(ctx);
		const signal = controller.signal;
		const input = { dir, notes, session: sessionId, judgeWindow, writerWindow, port, signal };
		queued += 1;
		queue = queue.then(async () => {
			try {
				if (signal.aborted) return;
				const outcome = await capture(input);
				if (signal.aborted) return;
				if (outcome.status === "unavailable") warnOnce("unavailable", `被动记忆已暂停：${outcome.reason}`);
				else if (outcome.status === "judge-error") warnOnce("judge-error", `被动记忆：Jev 调用失败：${outcome.error}（详见 calls.jsonl）`);
				else if (outcome.status === "writer-error") warnOnce("writer-error", `被动记忆：DeepSeek 写入失败：${outcome.error}（详见 calls.jsonl）`);
				else if (outcome.status === "written") {
					passiveWrites += 1;
					await recount();
				}
			} catch (error) {
				if (!signal.aborted) warnOnce("capture", `被动记忆出错：${error instanceof Error ? error.message : String(error)}`);
			} finally {
				queued -= 1;
			}
		});
	});

	pi.on("session_shutdown", () => {
		controller.abort();
		ui = undefined;
	});
}
