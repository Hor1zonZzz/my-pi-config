// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import * as os from "node:os";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentExtensionMode } from "./agents.ts";
import { getFinalOutput, isFailedResult } from "./runner.ts";
import type { SingleResult, SubagentDetails } from "./types.ts";

const COLLAPSED_ITEM_COUNT = 10;

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatExtensionPolicy(
	mode: AgentExtensionMode | undefined,
	sources: string[] | undefined,
	verbose = false,
): string {
	if (mode !== "isolated") return "extensions: auto";
	const configuredSources = sources ?? [];
	if (configuredSources.length === 0) return "extensions: none";
	return verbose
		? `extensions: ${configuredSources.join(", ")}`
		: `extensions: allowlist (${configuredSources.length})`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns)
		parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatReadToolCall(
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
	shortenPath: (path: string) => string,
): string {
	const rawPath = (args.file_path || args.path || "...") as string;
	const filePath = shortenPath(rawPath);
	const offset = args.offset as number | undefined;
	const limit = args.limit as number | undefined;
	let text = themeFg("accent", filePath);
	if (offset !== undefined || limit !== undefined) {
		const startLine = offset ?? 1;
		const endLine = limit !== undefined ? startLine + limit - 1 : "";
		text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
	}
	return themeFg("muted", "read ") + text;
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview =
				command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read":
			return formatReadToolCall(args, themeFg, shortenPath);
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return (
				themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath))
			);
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview =
				argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

function getDisplayItems(messages: SingleResult["messages"]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({
						type: "toolCall",
						name: part.name,
						args: part.arguments,
					});
			}
		}
	}
	return items;
}

export function renderSubagentCall(args, theme, _context) {
	if (
		args.action === "list" ||
		args.action === "status" ||
		args.action === "cancel"
	) {
		return new Text(
			theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", args.action) +
				(args.taskId ? theme.fg("dim", ` ${args.taskId}`) : ""),
			0,
			0,
		);
	}
	const executionLabel = theme.fg("warning", ` ${args.action ?? "block"}`);
	if (args.chain && args.chain.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `chain (${args.chain.length} steps)`) +
			executionLabel;
		for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
			const step = args.chain[i];
			const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
			const preview =
				cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
			text +=
				"\n  " +
				theme.fg("muted", `${i + 1}.`) +
				" " +
				theme.fg("accent", step.agent) +
				theme.fg("dim", ` ${preview}`);
		}
		if (args.chain.length > 3)
			text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}
	if (args.tasks && args.tasks.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
			executionLabel;
		for (const task of args.tasks.slice(0, 3)) {
			const preview =
				task.task.length > 40 ? `${task.task.slice(0, 40)}...` : task.task;
			text += `\n  ${theme.fg("accent", task.agent)}${theme.fg("dim", ` ${preview}`)}`;
		}
		if (args.tasks.length > 3)
			text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}
	const agentName = args.agent || "...";
	const preview = args.task
		? args.task.length > 60
			? `${args.task.slice(0, 60)}...`
			: args.task
		: "...";
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", agentName) +
		executionLabel;
	text += `\n  ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
}

export function renderSubagentResult(result, { expanded }, theme, _context) {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	}

	const mdTheme = getMarkdownTheme();

	const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
		const toShow = limit ? items.slice(-limit) : items;
		const skipped = limit && items.length > limit ? items.length - limit : 0;
		let text = "";
		if (skipped > 0)
			text += theme.fg("muted", `... ${skipped} earlier items\n`);
		for (const item of toShow) {
			if (item.type === "text") {
				const preview = expanded
					? item.text
					: item.text.split("\n").slice(0, 3).join("\n");
				text += `${theme.fg("toolOutput", preview)}\n`;
			} else {
				text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
			}
		}
		return text.trimEnd();
	};

	if (details.mode === "single" && details.results.length === 1) {
		const current = details.results[0];
		const isRunning = current.exitCode === -1;
		const isError = !isRunning && isFailedResult(current);
		const icon = isRunning
			? theme.fg("warning", "⏳")
			: isError
				? theme.fg("error", "✗")
				: theme.fg("success", "✓");
		const displayItems = getDisplayItems(current.messages);
		const finalOutput = getFinalOutput(current.messages);

		if (expanded) {
			const container = new Container();
			let header = `${icon} ${theme.fg("toolTitle", theme.bold(current.agent))}${theme.fg("muted", ` (${current.agentSource}; ${formatExtensionPolicy(current.extensionMode, current.extensionSources)})`)}`;
			if (isError && current.stopReason)
				header += ` ${theme.fg("error", `[${current.stopReason}]`)}`;
			container.addChild(new Text(header, 0, 0));
			if (
				current.extensionMode === "isolated" &&
				current.extensionSources.length > 0
			)
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							formatExtensionPolicy(
								current.extensionMode,
								current.extensionSources,
								true,
							),
						),
						0,
						0,
					),
				);
			if (isError && current.errorMessage)
				container.addChild(
					new Text(theme.fg("error", `Error: ${current.errorMessage}`), 0, 0),
				);
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
			container.addChild(new Text(theme.fg("dim", current.task), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
			if (displayItems.length === 0 && !finalOutput) {
				container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
			} else {
				for (const item of displayItems) {
					if (item.type === "toolCall")
						container.addChild(
							new Text(
								theme.fg("muted", "→ ") +
									formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0,
								0,
							),
						);
				}
				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}
			}
			const usage = formatUsageStats(current.usage, current.model);
			if (usage) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", usage), 0, 0));
			}
			return container;
		}

		let text = `${icon} ${theme.fg("toolTitle", theme.bold(current.agent))}${theme.fg("muted", ` (${current.agentSource}; ${formatExtensionPolicy(current.extensionMode, current.extensionSources)})`)}`;
		if (isError && current.stopReason)
			text += ` ${theme.fg("error", `[${current.stopReason}]`)}`;
		if (isError && current.errorMessage)
			text += `\n${theme.fg("error", `Error: ${current.errorMessage}`)}`;
		else if (displayItems.length === 0)
			text += `\n${theme.fg("muted", "(no output)")}`;
		else {
			text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
			if (displayItems.length > COLLAPSED_ITEM_COUNT)
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		}
		const usage = formatUsageStats(current.usage, current.model);
		if (usage) text += `\n${theme.fg("dim", usage)}`;
		return new Text(text, 0, 0);
	}

	const aggregateUsage = (results: SingleResult[]) => {
		const total = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			turns: 0,
		};
		for (const current of results) {
			total.input += current.usage.input;
			total.output += current.usage.output;
			total.cacheRead += current.usage.cacheRead;
			total.cacheWrite += current.usage.cacheWrite;
			total.cost += current.usage.cost;
			total.turns += current.usage.turns;
		}
		return total;
	};

	if (details.mode === "chain") {
		const successCount = details.results.filter(
			(current) => current.exitCode === 0,
		).length;
		const runningCount = details.results.filter(
			(current) => current.exitCode === -1,
		).length;
		const icon =
			runningCount > 0
				? theme.fg("warning", "⏳")
				: successCount === details.results.length
					? theme.fg("success", "✓")
					: theme.fg("error", "✗");

		if (expanded) {
			const container = new Container();
			container.addChild(
				new Text(
					icon +
						" " +
						theme.fg("toolTitle", theme.bold("chain ")) +
						theme.fg(
							"accent",
							`${successCount}/${details.results.length} steps`,
						),
					0,
					0,
				),
			);

			for (const current of details.results) {
				const resultIcon =
					current.exitCode === -1
						? theme.fg("warning", "⏳")
						: current.exitCode === 0
							? theme.fg("success", "✓")
							: theme.fg("error", "✗");
				const displayItems = getDisplayItems(current.messages);
				const finalOutput = getFinalOutput(current.messages);

				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						`${theme.fg("muted", `─── Step ${current.step}: `) + theme.fg("accent", current.agent)} ${resultIcon}`,
						0,
						0,
					),
				);
				container.addChild(
					new Text(
						theme.fg("muted", "Task: ") + theme.fg("dim", current.task),
						0,
						0,
					),
				);
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							formatExtensionPolicy(
								current.extensionMode,
								current.extensionSources,
								true,
							),
						),
						0,
						0,
					),
				);

				for (const item of displayItems) {
					if (item.type === "toolCall") {
						container.addChild(
							new Text(
								theme.fg("muted", "→ ") +
									formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0,
								0,
							),
						);
					}
				}

				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}

				const usage = formatUsageStats(current.usage, current.model);
				if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
			}

			const usage = formatUsageStats(aggregateUsage(details.results));
			if (usage) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${usage}`), 0, 0));
			}
			return container;
		}

		let text =
			icon +
			" " +
			theme.fg("toolTitle", theme.bold("chain ")) +
			theme.fg("accent", `${successCount}/${details.results.length} steps`);
		for (const current of details.results) {
			const resultIcon =
				current.exitCode === -1
					? theme.fg("warning", "⏳")
					: current.exitCode === 0
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");
			const displayItems = getDisplayItems(current.messages);
			text += `\n\n${theme.fg("muted", `─── Step ${current.step}: `)}${theme.fg("accent", current.agent)} ${resultIcon}${theme.fg("dim", ` [${formatExtensionPolicy(current.extensionMode, current.extensionSources)}]`)}`;
			if (displayItems.length === 0)
				text += `\n${theme.fg("muted", "(no output)")}`;
			else text += `\n${renderDisplayItems(displayItems, 5)}`;
		}
		const usage = formatUsageStats(aggregateUsage(details.results));
		if (usage) text += `\n\n${theme.fg("dim", `Total: ${usage}`)}`;
		text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		return new Text(text, 0, 0);
	}

	if (details.mode === "parallel") {
		const running = details.results.filter(
			(current) => current.exitCode === -1,
		).length;
		const successCount = details.results.filter(
			(current) => current.exitCode !== -1 && !isFailedResult(current),
		).length;
		const failCount = details.results.filter(
			(current) => current.exitCode !== -1 && isFailedResult(current),
		).length;
		const isRunning = running > 0;
		const icon = isRunning
			? theme.fg("warning", "⏳")
			: failCount > 0
				? theme.fg("warning", "◐")
				: theme.fg("success", "✓");
		const status = isRunning
			? `${successCount + failCount}/${details.results.length} done, ${running} running`
			: `${successCount}/${details.results.length} tasks`;

		if (expanded && !isRunning) {
			const container = new Container();
			container.addChild(
				new Text(
					`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
					0,
					0,
				),
			);

			for (const current of details.results) {
				const resultIcon = isFailedResult(current)
					? theme.fg("error", "✗")
					: theme.fg("success", "✓");
				const displayItems = getDisplayItems(current.messages);
				const finalOutput = getFinalOutput(current.messages);

				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						`${theme.fg("muted", "─── ") + theme.fg("accent", current.agent)} ${resultIcon}`,
						0,
						0,
					),
				);
				container.addChild(
					new Text(
						theme.fg("muted", "Task: ") + theme.fg("dim", current.task),
						0,
						0,
					),
				);
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							formatExtensionPolicy(
								current.extensionMode,
								current.extensionSources,
								true,
							),
						),
						0,
						0,
					),
				);

				for (const item of displayItems) {
					if (item.type === "toolCall") {
						container.addChild(
							new Text(
								theme.fg("muted", "→ ") +
									formatToolCall(item.name, item.args, theme.fg.bind(theme)),
								0,
								0,
							),
						);
					}
				}

				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}

				const usage = formatUsageStats(current.usage, current.model);
				if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
			}

			const usage = formatUsageStats(aggregateUsage(details.results));
			if (usage) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${usage}`), 0, 0));
			}
			return container;
		}

		let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
		for (const current of details.results) {
			const resultIcon =
				current.exitCode === -1
					? theme.fg("warning", "⏳")
					: isFailedResult(current)
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
			const displayItems = getDisplayItems(current.messages);
			text +=
				`\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", current.agent)} ${resultIcon}` +
				theme.fg(
					"dim",
					` [${formatExtensionPolicy(current.extensionMode, current.extensionSources)}]`,
				);
			if (displayItems.length === 0)
				text += `\n${theme.fg("muted", current.exitCode === -1 ? "(running...)" : "(no output)")}`;
			else text += `\n${renderDisplayItems(displayItems, 5)}`;
		}
		if (!isRunning) {
			const usage = formatUsageStats(aggregateUsage(details.results));
			if (usage) text += `\n\n${theme.fg("dim", `Total: ${usage}`)}`;
		}
		if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		return new Text(text, 0, 0);
	}

	const text = result.content[0];
	return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
}
