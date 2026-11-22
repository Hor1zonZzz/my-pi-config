/**
 * /btw — Claude Code-style ephemeral side question panel with multi-turn follow-ups.
 * Renders inline in Pi's bottom editor/status area (above the footer, without covering
 * the main transcript) and reuses the active conversation context (and prompt cache prefix)
 * without adding anything to the main session context.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Api, Context, Message, Model, Usage } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	getAgentDir,
	ModelSelectorComponent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { BtwOverlayComponent, type BtwPersistedTurn } from "./overlay.ts";

const BTW_ENTRY_TYPE = "btw";
const BTW_CLEAR_ENTRY_TYPE = "btw_clear";

const BTW_INSTRUCTION =
	"[Side question via /btw — ephemeral, NOT added to main conversation history. IMPORTANT: All tools are DISABLED in /btw. Do NOT call or attempt to call any tools; answer directly and concisely in plain text/Markdown using only the conversation context above.]\n\n";

const BTW_TOOL_DISABLED_SECTION =
	"No tools are available in /btw side-question mode. Do NOT call or attempt to call any tools. Answer directly and concisely in plain text/Markdown using only the conversation context.";

const STRIPPED_SYSTEM_SECTIONS = new Set(["tools", "docs", "skills", "mcp_servers"]);

/**
 * Strip tool definitions/skills from the system message and flatten toolCall / toolResult /
 * thinking blocks in the main conversation snapshot into plain text so `/btw` works reliably
 * with tools disabled across ALL providers & models (no hallucinated tool calls, no API errors,
 * and ~8k fewer wasted input tokens).
 */
function sanitizeMessagesForNoTools(messages: readonly Message[]): Message[] {
	const out: Message[] = [];
	for (const msg of messages) {
		const role = (msg as { role?: string }).role;
		if (role === "system") {
			const sys = msg as { role: "system"; content?: string; sections?: Record<string, string>; timestamp?: number };
			if (sys.sections && typeof sys.sections === "object") {
				const cleanSections: Record<string, string> = {};
				for (const [k, v] of Object.entries(sys.sections)) {
					if (!STRIPPED_SYSTEM_SECTIONS.has(k)) {
						cleanSections[k] = v;
					}
				}
				cleanSections.tools = BTW_TOOL_DISABLED_SECTION;
				out.push({
					role: "system",
					content: sys.content ?? "",
					sections: cleanSections,
					timestamp: sys.timestamp ?? Date.now(),
				} as unknown as Message);
			} else {
				out.push({
					role: "system",
					content: `${sys.content ?? ""}\n\n${BTW_TOOL_DISABLED_SECTION}`.trim(),
					timestamp: sys.timestamp ?? Date.now(),
				} as unknown as Message);
			}
			continue;
		}
		if (role === "toolResult") {
			const tr = msg as { toolName?: string; content?: unknown; timestamp?: number };
			const rawText = Array.isArray(tr.content)
				? tr.content
						.map((c: unknown) => {
							if (typeof c === "string") return c;
							if (c && typeof c === "object" && "text" in c && typeof (c as { text?: unknown }).text === "string") {
								return (c as { text: string }).text;
							}
							return "";
						})
						.filter(Boolean)
						.join("\n")
				: typeof tr.content === "string"
					? tr.content
					: "";
			const clipped = rawText.length > 4000 ? `${rawText.slice(0, 4000)}\n…(truncated)` : rawText;
			const label = tr.toolName ? `[Tool result (${tr.toolName})]` : "[Tool result]";
			const text = clipped ? `${label}\n${clipped}` : `${label} (empty)`;
			const prev = out[out.length - 1];
			if (prev && prev.role === "user" && Array.isArray(prev.content)) {
				prev.content = [...prev.content, { type: "text", text }];
			} else {
				out.push({
					role: "user",
					content: [{ type: "text", text }],
					timestamp: tr.timestamp ?? Date.now(),
				});
			}
			continue;
		}
		if (role === "assistant") {
			const am = msg as Extract<Message, { role: "assistant" }>;
			const parts: { type: "text"; text: string }[] = [];
			if (Array.isArray(am.content)) {
				for (const block of am.content) {
					if (block.type === "text" && block.text) {
						parts.push({ type: "text", text: block.text });
					} else if (block.type === "toolCall") {
						parts.push({ type: "text", text: `[Called tool: ${block.name}]` });
					}
					// Skip thinking blocks to avoid cross-provider signature errors
				}
			}
			if (parts.length > 0) {
				out.push({
					...am,
					content: parts,
				});
			}
			continue;
		}
		if (role === "user") {
			const um = msg as Extract<Message, { role: "user" }>;
			const prev = out[out.length - 1];
			if (prev && prev.role === "user" && Array.isArray(prev.content)) {
				const extra = Array.isArray(um.content)
					? um.content
					: [{ type: "text" as const, text: String(um.content ?? "") }];
				prev.content = [...prev.content, ...extra];
			} else {
				out.push(
					Array.isArray(um.content)
						? { ...um, content: [...um.content] }
						: um,
				);
			}
			continue;
		}
		out.push(msg);
	}
	return out;
}

interface BtwConfig {
	/** Optional `"provider/modelId"` override; `null` or omitted means follow the active main model. */
	model?: string | null;
}

function getAgentDirSafe(): string {
	try {
		return getAgentDir();
	} catch {
		return join(homedir(), ".pi", "agent");
	}
}

function getBtwConfigPath(): string {
	return join(getAgentDirSafe(), "btw.json");
}

function readBtwConfig(): BtwConfig {
	try {
		const p = getBtwConfigPath();
		if (!existsSync(p)) return {};
		const parsed = JSON.parse(readFileSync(p, "utf8")) as BtwConfig;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writeBtwConfig(cfg: BtwConfig): void {
	try {
		writeFileSync(getBtwConfigPath(), `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
	} catch {
		// Ignore write errors in read-only environments
	}
}

function resolveBtwModel(ctx: ExtensionCommandContext): { model: Model<Api> | undefined; isCustom: boolean } {
	const cfg = readBtwConfig();
	if (cfg.model && cfg.model.includes("/")) {
		const slash = cfg.model.indexOf("/");
		const provider = cfg.model.slice(0, slash);
		const modelId = cfg.model.slice(slash + 1);
		const found = ctx.modelRegistry.find(provider, modelId);
		if (found) return { model: found, isCustom: true };
	}
	return { model: ctx.model, isCustom: false };
}

async function pickBtwModel(
	ctx: ExtensionCommandContext,
	initialSearch?: string,
): Promise<{ model: Model<Api> | undefined; isCustom: boolean } | undefined> {
	const trimmed = initialSearch?.trim();
	if (trimmed === "reset" || trimmed === "default") {
		writeBtwConfig({ model: null });
		return { model: ctx.model, isCustom: false };
	}

	const currentSel = resolveBtwModel(ctx);
	// Minimal ModelRuntime adapter backed by ctx.modelRegistry so we can directly reuse
	// Pi's built-in /model ModelSelectorComponent (with fuzzy search, scoped models, etc.).
	const runtimeAdapter = {
		getAvailableSnapshot: () => ctx.modelRegistry.getAvailable(),
		getModel: (provider: string, id: string) => ctx.modelRegistry.find(provider, id),
		refresh: async () => ({ errors: new Map<string, string>(), aborted: false }),
		getError: () => ctx.modelRegistry.getError(),
	};

	const result = await ctx.ui.custom<{ kind: "select"; model: Model<Api> } | { kind: "reset" } | undefined>(
		(tui, _theme, _keybindings, done) => {
			const selector = new ModelSelectorComponent(
				tui,
				currentSel.model,
				runtimeAdapter as never,
				ctx.scopedModels,
				(selectedModel) => done({ kind: "select", model: selectedModel }),
				() => done(undefined),
				trimmed || undefined,
			);
			const origHandleInput = selector.handleInput.bind(selector);
			selector.handleInput = (keyData: string) => {
				if (matchesKey(keyData, "ctrl+r")) {
					done({ kind: "reset" });
					return;
				}
				origHandleInput(keyData);
			};
			return selector;
		},
	);

	if (!result) return undefined;
	if (result.kind === "reset") {
		writeBtwConfig({ model: null });
		return { model: ctx.model, isCustom: false };
	}

	const key = `${result.model.provider}/${result.model.id}`;
	writeBtwConfig({ model: key });
	return { model: result.model, isCustom: true };
}

interface BtwEntryData {
	question: string;
	answer: string;
	provider: string;
	model: string;
	elapsedMs: number;
	usage?: Usage;
	timestamp: number;
}

interface SessionManagerWithUsage {
	appendUsage?: (kind: string, provider: string, model: string, usage: Usage, note?: string) => unknown;
}

type EmphasisModule = {
	createPalette?: (theme: unknown, boldColor?: string) => unknown;
	decorate?: (markdown: string, palette: unknown) => string;
};

let emphasisModulePromise: Promise<EmphasisModule | null> | undefined;

function loadPiEmphasis(): Promise<EmphasisModule | null> {
	if (!emphasisModulePromise) {
		emphasisModulePromise = (async () => {
			let agentDir: string;
			try {
				agentDir = getAgentDir();
			} catch {
				agentDir = join(homedir(), ".pi", "agent");
			}
			const candidates = [
				join(agentDir, "git", "github.com", "johnlindquist", "pi-emphasis", "index.ts"),
				join(agentDir, "extensions", "pi-emphasis", "index.ts"),
			];
			for (const p of candidates) {
				if (existsSync(p)) {
					try {
						return (await import(pathToFileURL(p).href)) as EmphasisModule;
					} catch {
						return null;
					}
				}
			}
			return null;
		})();
	}
	return emphasisModulePromise;
}

function buildMarkdownTransform(
	emphasis: EmphasisModule | null,
	theme: Theme,
): ((markdown: string, availableWidth: number) => string) | undefined {
	if (!emphasis?.createPalette || !emphasis?.decorate) return undefined;
	try {
		const palette = emphasis.createPalette(theme, process.env.PI_EMPHASIS_COLOR || "mdLink");
		return (md: string) => {
			try {
				return emphasis.decorate!(md, palette);
			} catch {
				return md;
			}
		};
	} catch {
		return undefined;
	}
}

export default function btwExtension(pi: ExtensionAPI): void {
	pi.registerCommand("btw-model", {
		description: "Search and select a dedicated model for /btw (reuses Pi's /model selector; pass 'reset' or press Ctrl+R to follow main model)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/btw-model requires interactive UI mode.", "warning");
				return;
			}
			const picked = await pickBtwModel(ctx, args);
			if (!picked) return;
			if (!picked.model) {
				ctx.ui.notify("/btw 已设为跟随主模型（当前无活动主模型）。", "info");
				return;
			}
			const label = `${picked.model.provider}/${picked.model.id}`;
			ctx.ui.notify(
				picked.isCustom ? `/btw 追问模型已切换为: ${label}` : `/btw 已恢复跟随主模型 (${label})`,
				"info",
			);
		},
	});

	pi.registerCommand("btw", {
		description: "Ask a quick side question (with multi-turn follow-ups) in the bottom panel; persists history & usage without polluting main context",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/btw requires interactive UI mode.", "warning");
				return;
			}

			const trimmedArgs = args.trim();
			if (trimmedArgs === "model" || trimmedArgs === "--model" || trimmedArgs.startsWith("model ")) {
				const query = trimmedArgs.startsWith("model ") ? trimmedArgs.slice(6).trim() : undefined;
				const picked = await pickBtwModel(ctx, query);
				if (picked?.model) {
					const label = `${picked.model.provider}/${picked.model.id}`;
					ctx.ui.notify(
						picked.isCustom ? `/btw 追问模型已切换为: ${label}` : `/btw 已恢复跟随主模型 (${label})`,
						"info",
					);
				}
				return;
			}

			// Collect active /btw turns persisted since the last clear marker
			// (all earlier entries remain in the session .jsonl, never entering main LLM context)
			let priorTurns: BtwPersistedTurn[] = [];
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "custom" && entry.customType === BTW_CLEAR_ENTRY_TYPE) {
					priorTurns = [];
				} else if (entry.type === "custom" && entry.customType === BTW_ENTRY_TYPE && entry.data) {
					const d = entry.data as Partial<BtwEntryData>;
					if (typeof d.question === "string" && typeof d.answer === "string") {
						priorTurns.push({
							question: d.question,
							answer: d.answer,
							elapsedMs: typeof d.elapsedMs === "number" ? d.elapsedMs : 0,
							cacheRead: d.usage?.cacheRead ?? 0,
							outputTokens: d.usage?.output ?? 0,
						});
					}
				}
			}

			const question = trimmedArgs;
			// Bare `/btw` always opens the panel directly (with prior history if any, or ready for
			// immediate input / model switching via `m` without forcing a separate input modal first).
			const initialHistory: BtwPersistedTurn[] = !question ? priorTurns : [];

			let activeSelection = resolveBtwModel(ctx);
			if (!activeSelection.model) {
				ctx.ui.notify("No active model configured for /btw.", "error");
				return;
			}

			const formatModelLabel = (sel: { model: Model<Api>; isCustom: boolean }) =>
				sel.isCustom ? `${sel.model.provider}/${sel.model.id} (自定义)` : `${sel.model.provider}/${sel.model.id}`;

			// Snapshot current session context read-only and flatten toolCall/toolResult blocks
			// into plain text so tools-disabled /btw calls never fail on any provider/model.
			const rawMessages: Message[] = convertToLlm(ctx.sessionManager.buildSessionContext().messages);
			const baseMessages: Message[] = sanitizeMessagesForNoTools(rawMessages);
			const hasSystemMsg = baseMessages.some((m) => (m as { role?: string }).role === "system");
			const fallbackSystemPrompt = hasSystemMsg ? undefined : ctx.getSystemPrompt();

			// Render inline in Pi's bottom editor/status slot (not a centered modal overlay),
			// matching Claude Code's bottom-docked /btw panel so the main transcript stays visible.
			const emphasis = await loadPiEmphasis();
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
				new BtwOverlayComponent({
					tui,
					theme,
					initialQuestion: question || undefined,
					initialTurns: initialHistory,
					modelLabel: formatModelLabel(activeSelection as { model: Model<Api>; isCustom: boolean }),
					markdownTransform: buildMarkdownTransform(emphasis, theme),
					askSideQuestion: (sideHistory, nextQuestion, signal) => {
						const currentModel = activeSelection.model!;
						const prefix = sideHistory.length === 0 ? BTW_INSTRUCTION : "";
						const userMsg: Message = {
							role: "user",
							content: [{ type: "text", text: `${prefix}${nextQuestion}` }],
							timestamp: Date.now(),
						};
						// If baseMessages ends on a `user` message (e.g. a pending toolResult while main
						// agent is mid-turn), insert a minimal assistant separator so the model cleanly
						// distinguishes the user's new /btw question from the in-progress main turn.
						const needsSep =
							sideHistory.length === 0 &&
							baseMessages.length > 0 &&
							baseMessages[baseMessages.length - 1].role === "user";
						const sepMsg: Message[] = needsSep
							? [
									{
										role: "assistant",
										content: [{ type: "text", text: "(Main task paused; ready for /btw side question.)" }],
										api: currentModel.api,
										provider: currentModel.provider,
										model: currentModel.id,
										usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
										stopReason: "stop",
										timestamp: Date.now(),
									},
								]
							: [];
						const llmContext: Context = {
							...(fallbackSystemPrompt ? { systemPrompt: fallbackSystemPrompt } : {}),
							messages: [...baseMessages, ...sepMsg, ...sideHistory, userMsg],
						};
						return ctx.modelRegistry.streamSimple(currentModel, llmContext, {
							signal,
							reasoning: "low",
							sessionId: ctx.sessionManager.getSessionId(),
						});
					},
					onSelectModel: async () => {
						const picked = await pickBtwModel(ctx);
						if (!picked?.model) return undefined;
						activeSelection = picked;
						return formatModelLabel(picked as { model: Model<Api>; isCustom: boolean });
					},
					onTurnComplete: (turn) => {
						const currentModel = activeSelection.model!;
						// Persist Q&A in session .jsonl as a custom entry (never sent to main LLM)
						const entryData: BtwEntryData = {
							question: turn.question,
							answer: turn.answer,
							provider: currentModel.provider,
							model: currentModel.id,
							elapsedMs: turn.elapsedMs,
							usage: turn.usage,
							timestamp: Date.now(),
						};
						pi.appendEntry(BTW_ENTRY_TYPE, entryData);

						// Record token & cost usage into Pi's session stats (footer totals) without
						// inflating the main conversation's context window percentage.
						if (turn.usage) {
							const sm = ctx.sessionManager as unknown as SessionManagerWithUsage;
							if (typeof sm.appendUsage === "function") {
								try {
									sm.appendUsage(BTW_ENTRY_TYPE, currentModel.provider, currentModel.id, turn.usage, turn.question.slice(0, 80));
								} catch {
									// Ignore if sessionManager implementation rejects usage entry
								}
							}
						}
					},
					onClear: () => {
						pi.appendEntry(BTW_CLEAR_ENTRY_TYPE, { timestamp: Date.now() });
					},
					done: () => done(undefined),
				}),
			);
		},
	});
}
