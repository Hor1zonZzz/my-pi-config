/**
 * /btw — Claude Code-style ephemeral side question panel with multi-turn follow-ups.
 * Renders inline in Pi's bottom editor/status area (above the footer, without covering
 * the main transcript) and reuses the active conversation context (and prompt cache prefix)
 * without adding anything to the main session context.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context, Message, Usage } from "@earendil-works/pi-ai";
import { convertToLlm, getAgentDir, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { BtwOverlayComponent, type BtwPersistedTurn } from "./overlay.ts";

const BTW_ENTRY_TYPE = "btw";

const BTW_INSTRUCTION =
	"[Side question via /btw — ephemeral, NOT added to main conversation history. Answer the user's question directly and concisely based on the conversation context above. Do not call tools or suggest edits unless asked.]\n\n";

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
	pi.registerCommand("btw", {
		description: "Ask a quick side question (with multi-turn follow-ups) in the bottom panel; persists history & usage without polluting main context",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/btw requires interactive UI mode.", "warning");
				return;
			}

			// Collect prior /btw turns persisted in this session (custom entries never enter main LLM context)
			const priorTurns: BtwPersistedTurn[] = [];
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "custom" && entry.customType === BTW_ENTRY_TYPE && entry.data) {
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

			let question = args.trim();
			let initialHistory: BtwPersistedTurn[] = [];
			if (!question) {
				if (priorTurns.length > 0) {
					// Bare `/btw` opens this session's /btw history for review or follow-up
					initialHistory = priorTurns;
				} else {
					const entered = await ctx.ui.input("btw", "Ask a quick side question (won't enter context)…");
					if (!entered || !entered.trim()) return;
					question = entered.trim();
				}
			}

			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No active model configured for /btw.", "error");
				return;
			}

			// Snapshot current session context read-only so main prompt cache prefix is reused
			// without mutating sessionManager or polluting the main conversation.
			const systemPrompt = ctx.getSystemPrompt();
			const baseMessages: Message[] = convertToLlm(ctx.sessionManager.buildSessionContext().messages);
			const modelLabel = `${model.provider}/${model.id}`;

			// Render inline in Pi's bottom editor/status slot (not a centered modal overlay),
			// matching Claude Code's bottom-docked /btw panel so the main transcript stays visible.
			const emphasis = await loadPiEmphasis();
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
				new BtwOverlayComponent({
					tui,
					theme,
					initialQuestion: question || undefined,
					initialTurns: initialHistory,
					modelLabel,
					markdownTransform: buildMarkdownTransform(emphasis, theme),
					askSideQuestion: (sideHistory, nextQuestion, signal) => {
						const prefix = sideHistory.length === 0 ? BTW_INSTRUCTION : "";
						const userMsg: Message = {
							role: "user",
							content: [{ type: "text", text: `${prefix}${nextQuestion}` }],
							timestamp: Date.now(),
						};
						const llmContext: Context = {
							systemPrompt,
							messages: [...baseMessages, ...sideHistory, userMsg],
						};
						return ctx.modelRegistry.streamSimple(model, llmContext, {
							signal,
							reasoning: "low",
						});
					},
					onTurnComplete: (turn) => {
						// Persist Q&A in session .jsonl as a custom entry (never sent to main LLM)
						const entryData: BtwEntryData = {
							question: turn.question,
							answer: turn.answer,
							provider: model.provider,
							model: model.id,
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
									sm.appendUsage(BTW_ENTRY_TYPE, model.provider, model.id, turn.usage, turn.question.slice(0, 80));
								} catch {
									// Ignore if sessionManager implementation rejects usage entry
								}
							}
						}
					},
					done: () => done(undefined),
				}),
			);
		},
	});
}
