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
import { MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, monitorOutcomeText, monitorStartedMessage } from "./monitor-format.ts";
import { MONITOR_MESSAGE_TYPE, MonitorManager } from "./monitor-manager.ts";
import {
	ensureScratchpad,
	pruneScratchpads,
	scratchpadPromptSection,
	scratchpadRoot,
	sessionScratchpad,
} from "./scratchpad.ts";
import { BackgroundTaskManager, MESSAGE_TYPE } from "./task-manager.ts";

const STATUS_KEY = "background-task";
const MONITOR_STATUS_KEY = "monitor";
const PROMPT_SECTION = "scratchpad";

export default function (pi: ExtensionAPI) {
	// Pi's own shell backend: same shell resolution, PATH (including <agent-dir>/bin), and
	// process-group tracking as the built-in bash tool, so Pi kills leftovers when it exits.
	const operations = createLocalBashOperations();
	const manager = new BackgroundTaskManager(
		(command, cwd, options) => operations.exec(command, cwd, options),
		(message, options) => pi.sendMessage(message, options),
	);
	const monitors = new MonitorManager(
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

	pi.registerTool(
		defineTool({
			name: "monitor",
			label: "Monitor",
			description:
				"Start a background watch script and return immediately. Each stdout line is delivered to you as an event while you keep working (lines within 200ms are grouped); stderr goes to a file and is not an event. The script's exit ends the watch and is reported. Every monitor expires after timeout_ms (default 5 minutes, at most 30 minutes); start it again if the watch is still needed.",
			promptSnippet: "Watch logs, files, or remote state in the background; each stdout line arrives as an event",
			promptGuidelines: [
				"Use monitor to be told about each occurrence of something (every ERROR line in a log, each new PR comment, each CI job result). To be told once when a condition holds or a command finishes, use background_task with a command that exits then, such as `until grep -q Ready app.log; do sleep 1; done`.",
				"In a monitor script, every pipeline stage must flush per line: `grep --line-buffered`, `awk` with `fflush()`, `sed -u`. Never pipe into `head`. `tail -f`, `while true`, and similar loops never exit on their own, so use them only when every occurrence matters.",
				"A monitor's filter must match every terminal state, not only success: also match errors, tracebacks, crashes, `Killed`, and failed or cancelled statuses, because a silent monitor looks the same as one still waiting. For a command you run directly in the script, add `2>&1` so its errors reach the filter.",
				"Emit only lines you would act on; never stream raw logs. A monitor that produces too many events is stopped. Poll remote APIs no more than every 30 seconds and tolerate transient failures (`|| true`).",
				"Give each monitor a specific description such as `errors in deploy.log`. Stop one early with `kill -- -<pgid>`. After starting one, continue other work or end your turn; do not sleep or poll waiting for its events.",
			],
			parameters: Type.Object({
				command: Type.String({
					description: "Shell script whose stdout lines are events. Its exit ends the monitor.",
				}),
				description: Type.String({
					description: "Short, specific description of what is being watched; shown with every event",
				}),
				timeout_ms: Type.Optional(
					Type.Number({
						description: `Stop the monitor after this many milliseconds (default 300000, ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS})`,
					}),
				),
				cwd: Type.Optional(
					Type.String({
						description: "Working directory, absolute or relative to the session directory (default: the session directory)",
					}),
				),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const monitor = await monitors.start({
					command: params.command,
					description: params.description,
					timeoutMs: params.timeout_ms,
					cwd: resolve(ctx.cwd, params.cwd ?? "."),
				});
				return {
					content: [{ type: "text", text: monitorStartedMessage(monitor) }],
					details: {
						monitorId: monitor.id,
						pgid: monitor.pgid,
						logPath: monitor.logPath,
						stderrPath: monitor.stderrPath,
						timeoutMs: monitor.timeoutMs,
					},
				};
			},
		}),
	);

	for (const type of [MESSAGE_TYPE, MONITOR_MESSAGE_TYPE]) {
		pi.registerMessageRenderer(
			type,
			(message) => new Markdown(String(message.content), 0, 0, getMarkdownTheme()),
		);
	}

	pi.registerCommand("bg", {
		description: "List this session's background tasks and monitors, or stop one with /bg stop <id>",
		getArgumentCompletions: (prefix) => {
			const [action = "", partial = ""] = prefix.trimStart().split(/\s+/, 2);
			if (!prefix.includes(" ")) {
				return "stop".startsWith(action) ? [{ value: "stop ", label: "stop", description: "Stop a running task" }] : null;
			}
			if (action !== "stop") return null;
			return [...manager.runningIds(), ...monitors.runningIds()]
				.filter((id) => id.startsWith(partial))
				.map((id) => ({ value: `stop ${id}`, label: id }));
		},
		handler: async (args, ctx) => {
			const [action, id] = args.trim().split(/\s+/);
			if (action === "stop") {
				if (!id) {
					ctx.ui.notify("Usage: /bg stop <task or monitor id>", "warning");
				} else if (manager.stop(id) || monitors.stop(id)) {
					ctx.ui.notify(`Stopping ${id}.`, "info");
				} else {
					ctx.ui.notify(`${id} is not a running background task or monitor.`, "warning");
				}
				return;
			}
			const now = Date.now();
			const rows = [
				...manager.list().map((task) => ({
					startedAt: task.startedAt,
					text: `${task.id}  ${outcomeText(task)}  ${formatDuration((task.endedAt ?? now) - task.startedAt)}  ${firstLine(task.command, 60)}`,
				})),
				...monitors.list().map((monitor) => ({
					startedAt: monitor.startedAt,
					text: `${monitor.id}  ${monitorOutcomeText(monitor)}  ${formatDuration((monitor.endedAt ?? now) - monitor.startedAt)}  ${monitor.events} events  ${firstLine(monitor.description, 60)}`,
				})),
			].sort((a, b) => a.startedAt - b.startedAt);
			if (rows.length === 0) {
				ctx.ui.notify("No background tasks or monitors in this session.", "info");
				return;
			}
			const lines = rows.map((row) => row.text);
			if (scratchpad) lines.push("", `Logs: ${manager.taskDir}`, `Monitors: ${monitors.monitorDir}`);
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
				? (text) => ctx.ui.setStatus(STATUS_KEY, text && ctx.ui.theme.fg("accent", text))
				: undefined,
		});
		monitors.startSession({
			sessionId,
			scratchpad: dir,
			setStatus: ctx.hasUI
				? (text) => ctx.ui.setStatus(MONITOR_STATUS_KEY, text && ctx.ui.theme.fg("accent", text))
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
		await Promise.all([manager.shutdown(), monitors.shutdown()]);
	});
}
