/**
 * /btw — Claude Code-style ephemeral side question overlay.
 * Reuses the active conversation context (and prompt cache prefix) to answer a quick
 * side question without adding anything to the main session context or interrupting work.
 */
import type { Context, Message } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BtwOverlayComponent } from "./overlay.ts";

const BTW_INSTRUCTION =
	"[Side question via /btw — ephemeral, NOT added to conversation history. Answer the user's question directly and concisely based on the conversation context above. Do not call tools or suggest edits unless asked.]\n\n";

export default function btwExtension(pi: ExtensionAPI): void {
	pi.registerCommand("btw", {
		description: "Ask a quick side question in a dismissible overlay without adding it to context",
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
			const sessionCtx = ctx.sessionManager.buildSessionContext();
			const baseMessages: Message[] = convertToLlm(sessionCtx.messages);
			const sideMessage: Message = {
				role: "user",
				content: [{ type: "text", text: `${BTW_INSTRUCTION}${question}` }],
				timestamp: Date.now(),
			};

			const llmContext: Context = {
				systemPrompt: ctx.getSystemPrompt(),
				messages: [...baseMessages, sideMessage],
			};

			const abortController = new AbortController();
			const stream = ctx.modelRegistry.streamSimple(model, llmContext, {
				signal: abortController.signal,
				reasoning: "low",
			});

			const modelLabel = `${model.provider}/${model.id}`;

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new BtwOverlayComponent({
						tui,
						theme,
						question,
						modelLabel,
						stream,
						abortController,
						done: () => done(undefined),
					}),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "82%",
						maxHeight: "75%",
					},
				},
			);
		},
	});
}
