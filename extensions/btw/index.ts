/**
 * /btw — Claude Code-style ephemeral side question overlay with multi-turn follow-ups.
 * Reuses the active conversation context (and prompt cache prefix) to answer quick
 * side questions without adding anything to the main session context.
 */
import type { Context, Message } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BtwOverlayComponent } from "./overlay.ts";

const BTW_INSTRUCTION =
	"[Side question via /btw — ephemeral, NOT added to main conversation history. Answer the user's question directly and concisely based on the conversation context above. Do not call tools or suggest edits unless asked.]\n\n";

export default function btwExtension(pi: ExtensionAPI): void {
	pi.registerCommand("btw", {
		description: "Ask a quick side question (with multi-turn follow-ups) in an overlay without adding it to context",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/btw requires interactive UI mode.", "warning");
				return;
			}

			let question = args.trim();
			if (!question) {
				const entered = await ctx.ui.input("btw", "Ask a quick side question (won't enter context)…");
				if (!entered || !entered.trim()) return;
				question = entered.trim();
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

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new BtwOverlayComponent({
						tui,
						theme,
						initialQuestion: question,
						modelLabel,
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
						done: () => done(undefined),
					}),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "82%",
						maxHeight: "78%",
					},
				},
			);
		},
	});
}
