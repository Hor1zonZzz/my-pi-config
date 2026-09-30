/**
 * Tools Extension
 *
 * Provides a /tools command to enable/disable tools interactively.
 * Tool selection persists across session reloads and respects branch navigation.
 * Local change: each row also shows the tool's exposure and source, and the
 * selected row shows its full source path and description.
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /tools to open the tool selector
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, truncateToWidth } from "@earendil-works/pi-tui";
import * as path from "node:path";

// State persisted to session
interface ToolsState {
	enabledTools: string[];
}

const DESCRIPTION_LIMIT = 240;

// Short source for the row: "builtin", a package source such as "npm:...", or the extension's name
function sourceLabel(tool: ToolInfo): string {
	const info = tool.sourceInfo;
	if (info.source === "builtin") return "builtin";
	if (info.origin === "package") return info.source;
	const base = path.basename(info.path);
	const name = /^index\.[cm]?[jt]s$/.test(base) ? path.basename(path.dirname(info.path)) : base;
	return info.scope === "project" ? `${name} (project)` : name;
}

function describeTool(tool: ToolInfo): string {
	const info = tool.sourceInfo;
	const source = `source: ${info.source} · scope: ${info.scope} · ${info.path}`;
	const text = (tool.description ?? "").split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
	if (!text) return source;
	return `${source}\n${text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT - 1)}…` : text}`;
}

export default function toolsExtension(pi: ExtensionAPI) {
	// Track enabled tools
	let enabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];

	// Persist current state
	function persistState() {
		pi.appendEntry<ToolsState>("tools-config", {
			enabledTools: Array.from(enabledTools),
		});
	}

	// Apply current tool selection
	function applyTools() {
		pi.setActiveTools(Array.from(enabledTools));
	}

	// Find the last tools-config entry in the current branch
	function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools();

		// Get entries in current branch only
		const branchEntries = ctx.sessionManager.getBranch();
		let savedTools: string[] | undefined;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && entry.customType === "tools-config") {
				const data = entry.data as ToolsState | undefined;
				if (data?.enabledTools) {
					savedTools = data.enabledTools;
				}
			}
		}

		if (savedTools) {
			// Restore saved tool selection (filter to only tools that still exist)
			const allToolNames = allTools.map((t) => t.name);
			enabledTools = new Set(savedTools.filter((t: string) => allToolNames.includes(t)));
			applyTools();
		} else {
			// No saved state - sync with currently active tools
			enabledTools = new Set(pi.getActiveTools());
		}
	}

	// Register /tools command
	pi.registerCommand("tools", {
		description: "Enable/disable tools",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires TUI mode", "error");
				return;
			}

			// Refresh tool list
			allTools = pi.getAllTools();

			await ctx.ui.custom((tui, theme, _kb, done) => {
				// Build settings items for each tool. The status leads the value so a narrow
				// terminal truncates the exposure and source instead of the status.
				const exposureWidth = Math.max(0, ...allTools.map((tool) => tool.exposure.length));
				const items: SettingItem[] = allTools.map((tool) => {
					const details = `${tool.exposure.padEnd(exposureWidth)}  ${sourceLabel(tool)}`;
					const values = [`enabled   ${details}`, `disabled  ${details}`];
					return {
						id: tool.name,
						label: tool.name,
						description: describeTool(tool),
						currentValue: enabledTools.has(tool.name) ? values[0] : values[1],
						values,
					};
				});

				const container = new Container();
				container.addChild(
					new (class {
						render(width: number) {
							return [
								truncateToWidth(theme.fg("accent", theme.bold("Tool Configuration")), width),
								truncateToWidth(theme.fg("dim", "tool · status · exposure · source"), width),
								"",
							];
						}
						invalidate() {}
					})(),
				);

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						// Update enabled state and apply immediately
						if (newValue.startsWith("enabled")) {
							enabledTools.add(id);
						} else {
							enabledTools.delete(id);
						}
						applyTools();
						persistState();
					},
					() => {
						// Close dialog
						done(undefined);
					},
				);

				container.addChild(settingsList);

				const component = {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};

				return component;
			});
		},
	});

	// Restore state on session start
	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	// Restore state when navigating the session tree
	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
}
