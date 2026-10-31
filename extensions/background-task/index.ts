import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	createLocalBashOperations,
	defineTool,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { firstLine, formatDuration, outcomeText, startedMessage } from "./format.ts";
import {
	ensureScratchpad,
	pruneScratchpads,
	scratchpadPromptSection,
	scratchpadRoot,
	sessionScratchpad,
} from "./scratchpad.ts";
import { BackgroundTaskManager, MESSAGE_TYPE } from "./task-manager.ts";

const STATUS_KEY = "background-task";
const PROMPT_SECTION = "scratchpad";

export default function (pi: ExtensionAPI) {
	// Pi's own shell backend: same shell resolution, PATH (including <agent-dir>/bin), and
	// process-group tracking as the built-in bash tool, so Pi kills leftovers when it exits.
	const operations = createLocalBashOperations();
	const manager = new BackgroundTaskManager(
		(command, cwd, options) => operations.exec(command, cwd, options),
		(message, options) => pi.sendMessage(message, options),
	);
	let scratchpad: string | undefined;

	pi.registerTool(
		defineTool({
			name: "background_task",
			label: "Background Task",
			description:
				"Run a shell command in the background and return immediately. Output goes to a log file in the session scratchpad; when the command exits, its exit code and the end of its log are reported automatically.",
			promptSnippet: "Run long shell commands in the background; their exit is reported automatically",
			promptGuidelines: [
				"Use background_task instead of bash for commands likely to take more than about 30 seconds (builds, full test suites, installs, downloads) and for servers or watchers that keep running.",
				"After starting a background task, continue with other work or end your turn. Do not poll, sleep, or tail the log in a loop waiting for it; its exit is reported automatically.",
				"Read a background task's log with read; the exit report gives its line count, so use an offset near the end. Stop a task with `kill -- -<pgid>`, and stop servers you started once they are no longer needed.",
			],
			parameters: Type.Object({
				command: Type.String({ description: "Shell command to run in the background" }),
				cwd: Type.Optional(
					Type.String({
						description: "Working directory, absolute or relative to the session directory (default: the session directory)",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const task = await manager.start(params.command, resolve(ctx.cwd, params.cwd ?? "."));
				return {
					content: [{ type: "text", text: startedMessage(task) }],
					details: { taskId: task.id, pgid: task.pgid, logPath: task.logPath },
				};
			},
		}),
	);

	pi.registerMessageRenderer(
		MESSAGE_TYPE,
		(message) => new Markdown(String(message.content), 0, 0, getMarkdownTheme()),
	);

	pi.registerCommand("bg", {
		description: "List this session's background tasks, or stop one with /bg stop <id>",
		getArgumentCompletions: (prefix) => {
			const [action = "", partial = ""] = prefix.trimStart().split(/\s+/, 2);
			if (!prefix.includes(" ")) {
				return "stop".startsWith(action) ? [{ value: "stop ", label: "stop", description: "Stop a running task" }] : null;
			}
			if (action !== "stop") return null;
			return manager
				.runningIds()
				.filter((id) => id.startsWith(partial))
				.map((id) => ({ value: `stop ${id}`, label: id }));
		},
		handler: async (args, ctx) => {
			const [action, id] = args.trim().split(/\s+/);
			if (action === "stop") {
				if (!id) {
					ctx.ui.notify("Usage: /bg stop <task id>", "warning");
				} else if (manager.stop(id)) {
					ctx.ui.notify(`Stopping ${id}.`, "info");
				} else {
					ctx.ui.notify(`${id} is not a running background task.`, "warning");
				}
				return;
			}
			const tasks = manager.list();
			if (tasks.length === 0) {
				ctx.ui.notify("No background tasks in this session.", "info");
				return;
			}
			const now = Date.now();
			const lines = tasks.map((task) => {
				const elapsed = formatDuration((task.endedAt ?? now) - task.startedAt);
				return `${task.id}  ${outcomeText(task)}  ${elapsed}  ${firstLine(task.command, 60)}`;
			});
			if (scratchpad) lines.push("", `Logs: ${manager.taskDir}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const agentDir = getAgentDir();
		const sessionId = ctx.sessionManager.getSessionId();
		const dir = sessionScratchpad(agentDir, sessionId);
		try {
			await ensureScratchpad(dir);
			scratchpad = dir;
		} catch (error) {
			scratchpad = undefined;
			if (ctx.hasUI) ctx.ui.notify(`Could not create the session scratchpad: ${String(error)}`, "warning");
		}
		manager.startSession({
			sessionId,
			scratchpad: dir,
			setStatus: ctx.hasUI
				? (text) => ctx.ui.setStatus(STATUS_KEY, text && ctx.ui.theme.fg("accent", `⏵ ${text}`))
				: undefined,
		});
		void pruneScratchpads(scratchpadRoot(agentDir), dir).catch(() => {});
	});

	pi.on("before_agent_start", (event) => {
		if (scratchpad) {
			event.systemPromptOptions.sections ??= {};
			event.systemPromptOptions.sections[PROMPT_SECTION] = scratchpadPromptSection(scratchpad);
		}
	});

	pi.on("session_shutdown", async () => {
		await manager.shutdown();
	});
}
