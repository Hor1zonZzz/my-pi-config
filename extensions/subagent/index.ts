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
import { SubagentViewerController } from "./viewer.ts";

export default function (pi: ExtensionAPI) {
	const taskManager = new SubagentTaskManager(pi);
	const viewer = new SubagentViewerController(taskManager);
	const registerSubagentTool = createSubagentToolRegistrar(pi, taskManager);

	pi.registerMessageRenderer(
		"subagent-task-completion",
		(message, _options, _theme) =>
			new Markdown(message.content, 0, 0, getMarkdownTheme()),
	);

	pi.registerCommand("subagents", {
		description: "Open the current session's subagent task viewer",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					"The subagent viewer is available only in TUI mode.",
					"warning",
				);
				return;
			}
			if (!viewer.activatePicker()) {
				ctx.ui.notify("No subagent tasks in the current session.", "info");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		taskManager.startSession(ctx);
		viewer.startSession(ctx);
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
		viewer.shutdown();
		await taskManager.shutdown();
	});

	registerSubagentTool(process.cwd());
}
