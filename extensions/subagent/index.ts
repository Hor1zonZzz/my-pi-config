// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

/**
 * Subagent Tool - Delegate tasks to specialized agents in isolated Pi processes.
 */

import {
	type ExtensionAPI,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { SubagentTaskManager } from "./task-manager.ts";
import { createSubagentToolRegistrar } from "./tool.ts";

export default function (pi: ExtensionAPI) {
	const taskManager = new SubagentTaskManager(pi);
	const registerSubagentTool = createSubagentToolRegistrar(pi, taskManager);

	pi.registerMessageRenderer(
		"subagent-task-completion",
		(message, _options, _theme) =>
			new Markdown(message.content, 0, 0, getMarkdownTheme()),
	);

	pi.on("session_start", (_event, ctx) => {
		taskManager.startSession(ctx);
		registerSubagentTool(ctx.cwd);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		registerSubagentTool(ctx.cwd);
	});

	pi.on("agent_settled", () => {
		taskManager.deliverPendingCompletions();
	});

	pi.on("session_before_tree", (_event, ctx) =>
		taskManager.guardTreeNavigation(ctx),
	);

	pi.on("session_shutdown", async () => {
		await taskManager.shutdown();
	});

	registerSubagentTool(process.cwd());
}
