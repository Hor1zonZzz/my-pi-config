// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import {
	type ExtensionAPI,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import registerIntegrationCheck from "./integration-check.ts";
import { HerdrBackgroundTaskManager } from "./task-manager.ts";

const PROMPT_MARKER = "Herdr asynchronous prompt policy:";
const PROMPT_GUIDANCE = [
	PROMPT_MARKER,
	'- When Herdr work should continue asynchronously, call `herdr_agent` with `action: "prompt"` and explicit `wait: false`.',
	"- After dispatching an asynchronous sub-agent, do not poll or wait. Continue with other useful work, or stop if none remains; completion will be reported automatically.",
	"- Do not submit another asynchronous prompt to the same Herdr pane until its completion follow-up unless the prompts intentionally belong to one grouped run.",
].join("\n");

function enabled(): boolean {
	return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_PANE_ID);
}

export default function (pi: ExtensionAPI) {
	registerIntegrationCheck(pi);
	if (!enabled()) return;

	const taskManager = new HerdrBackgroundTaskManager(pi);

	pi.registerMessageRenderer(
		"herdr-background-completion",
		(message, _options, _theme) =>
			new Markdown(message.content, 0, 0, getMarkdownTheme()),
	);

	pi.on("session_start", (_event, ctx) => {
		taskManager.startSession(ctx);
	});

	pi.on("before_agent_start", (event) => {
		if (
			!pi.getActiveTools().includes("herdr_agent") ||
			event.systemPrompt.includes(PROMPT_MARKER)
		) {
			return;
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${PROMPT_GUIDANCE}` };
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName === "herdr_agent") {
			taskManager.trackPromptResult(event, ctx);
		}
	});

	pi.on("agent_settled", () => {
		taskManager.deliverPendingCompletions();
	});

	pi.on("session_shutdown", async () => {
		await taskManager.shutdown();
	});
}
