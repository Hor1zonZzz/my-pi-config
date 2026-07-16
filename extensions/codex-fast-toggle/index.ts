import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";

const OPENAI_CODEX_PROVIDER = "openai-codex";

type FastState = {
	enabled: boolean;
};

const FAST_STATE_PATH = join(getAgentDir(), "codex-fast.json");

function isCodexProvider(provider: string | undefined): boolean {
	return provider === OPENAI_CODEX_PROVIDER;
}

function applyFastServiceTier(
	payload: unknown,
	enabled: boolean,
): unknown | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return undefined;
	}

	const request = payload as Record<string, unknown>;
	if (enabled) {
		return { ...request, service_tier: "priority" };
	}
	if (!("service_tier" in request)) {
		return undefined;
	}

	const nextRequest = { ...request };
	delete nextRequest.service_tier;
	return nextRequest;
}

async function readFastState(): Promise<boolean> {
	try {
		const parsed = JSON.parse(
			await readFile(FAST_STATE_PATH, "utf8"),
		) as Partial<FastState>;
		return parsed.enabled === true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(
				`[codex-fast-toggle] Failed to read ${FAST_STATE_PATH}:`,
				error,
			);
		}
		return true;
	}
}

async function writeFastState(enabled: boolean): Promise<void> {
	await mkdir(dirname(FAST_STATE_PATH), { recursive: true });
	const temporaryPath = `${FAST_STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(
			temporaryPath,
			`${JSON.stringify({ enabled }, null, 2)}\n`,
			"utf8",
		);
		await rename(temporaryPath, FAST_STATE_PATH);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

function createFastAutocompleteProvider(
	current: AutocompleteProvider,
	isAvailable: () => boolean,
): AutocompleteProvider {
	return {
		triggerCharacters: [
			...new Set([...(current.triggerCharacters ?? []), "/"]),
		],

		async getSuggestions(lines, cursorLine, cursorCol, options) {
			if (!isAvailable()) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const currentLine = lines[cursorLine] ?? "";
			const beforeCursor = currentLine.slice(0, cursorCol);
			const commandMatch = beforeCursor.match(/^\/([^\s]*)$/);
			if (commandMatch) {
				const base = await current.getSuggestions(
					lines,
					cursorLine,
					cursorCol,
					options,
				);
				const query = commandMatch[1].toLowerCase();
				if (!"fast".startsWith(query)) {
					return base;
				}
				const fastItem = {
					value: "fast",
					label: "fast",
					description: "Toggle OpenAI Codex priority service tier",
				};
				return {
					prefix: beforeCursor,
					items: [
						fastItem,
						...(base?.items.filter((item) => item.value !== "fast") ?? []),
					],
				};
			}

			const argumentMatch = beforeCursor.match(/^\/fast\s+([^\s]*)$/);
			if (argumentMatch) {
				const query = argumentMatch[1].toLowerCase();
				const items = [
					{
						value: "on",
						label: "on",
						description: "Use priority service tier",
					},
					{
						value: "off",
						label: "off",
						description: "Use default service tier",
					},
				].filter((item) => item.value.startsWith(query));
				return items.length > 0 ? { items, prefix: argumentMatch[1] } : null;
			}

			return current.getSuggestions(lines, cursorLine, cursorCol, options);
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(
				lines,
				cursorLine,
				cursorCol,
				item,
				prefix,
			);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return (
				current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
				true
			);
		},
	};
}

export default async function (pi: ExtensionAPI) {
	let fastEnabled = await readFastState();

	pi.on("before_provider_request", (event, ctx) => {
		if (!isCodexProvider(ctx.model?.provider)) {
			return undefined;
		}
		return applyFastServiceTier(event.payload, fastEnabled);
	});

	function updateStatus(ctx: ExtensionContext): void {
		const showFast = fastEnabled && isCodexProvider(ctx.model?.provider);
		ctx.ui.setStatus(
			"codex-fast",
			showFast ? ctx.ui.theme.fg("accent", "⚡ fast") : undefined,
		);
	}

	async function refreshState(ctx: ExtensionContext): Promise<void> {
		fastEnabled = await readFastState();
		updateStatus(ctx);
	}

	async function setFastMode(
		enabled: boolean,
		ctx: ExtensionContext,
	): Promise<void> {
		fastEnabled = enabled;
		await writeFastState(enabled);
		updateStatus(ctx);
		ctx.ui.notify(
			`Codex Fast: ${enabled ? "On (priority)" : "Off (default)"}`,
			"info",
		);
	}

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) =>
			createFastAutocompleteProvider(current, () =>
				isCodexProvider(ctx.model?.provider),
			),
		);
		await refreshState(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		await refreshState(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		await refreshState(ctx);
	});

	pi.on("input", async (event, ctx) => {
		const match = event.text.trim().match(/^\/fast(?:\s+(\S+))?$/i);
		if (!match) {
			return { action: "continue" as const };
		}

		if (!isCodexProvider(ctx.model?.provider)) {
			ctx.ui.notify(
				"/fast is only available for OpenAI Codex models",
				"warning",
			);
			return { action: "handled" as const };
		}

		let requested = match[1]?.toLowerCase();
		if (!requested) {
			if (!ctx.hasUI) {
				ctx.ui.notify("Usage: /fast on|off", "error");
				return { action: "handled" as const };
			}
			const selection = await ctx.ui.select("Codex Fast", [
				"On — priority service tier",
				"Off — default service tier",
			]);
			if (!selection) {
				return { action: "handled" as const };
			}
			requested = selection.startsWith("On") ? "on" : "off";
		}

		if (requested !== "on" && requested !== "off") {
			ctx.ui.notify("Usage: /fast on|off", "error");
			return { action: "handled" as const };
		}

		await setFastMode(requested === "on", ctx);
		return { action: "handled" as const };
	});
}
