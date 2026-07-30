// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BUILTIN_TOOL_NAMES, createBuiltinToolBroker } from "./broker.ts";
import {
	CodeModeExecutionError,
	executeCodeCell,
	RuntimeStartupError,
} from "./runtime.ts";
import {
	CODE_MODE_STATE_PATH,
	readCodeModeState,
	writeCodeModeState,
} from "./storage.ts";

const TOOL_NAME = "code_mode_exec";
const LAYER_ID = "code-mode";
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;

const CodeModeParams = Type.Object({
	code: Type.String({
		minLength: 1,
		maxLength: 100_000,
		description:
			"One stateless async JavaScript cell. Use tools.<name>(input) for Pi built-ins and call text(...) or image(...) for explicit output.",
	}),
	timeout: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: MAX_TIMEOUT_SECONDS,
			description: `Wall-clock timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}).`,
		}),
	),
});

interface RuntimeLayerSnapshot {
	id: string;
	priority: number;
	disableTools: string[];
	requireTools: string[];
}

interface ManagerPolicySnapshot {
	sessionReady: boolean;
	baseTools: string[];
	toolNames: string[];
	runtimeLayers: RuntimeLayerSnapshot[];
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function normalizeManagerSnapshot(value: unknown): ManagerPolicySnapshot {
	const data = record(value) ?? {};
	const runtimeLayers: RuntimeLayerSnapshot[] = [];
	if (Array.isArray(data.runtimeLayers)) {
		for (const candidate of data.runtimeLayers) {
			const layer = record(candidate);
			if (!layer || typeof layer.id !== "string") continue;
			let priority = 0;
			if (
				typeof layer.priority === "number" &&
				Number.isFinite(layer.priority)
			) {
				priority = layer.priority;
			}
			runtimeLayers.push({
				id: layer.id,
				priority,
				disableTools: strings(layer.disableTools),
				requireTools: strings(layer.requireTools),
			});
		}
	}
	return {
		sessionReady: data.sessionReady === true,
		baseTools: strings(data.baseTools),
		toolNames: strings(data.toolNames),
		runtimeLayers,
	};
}

function toolDescription(): string {
	return `Execute one stateless, run-to-completion JavaScript cell in an isolated Node child process.

Available globals:
- tools.<name>(input): call a currently enabled Pi built-in and receive { content, details, isError }.
- ALL_TOOLS: exact nested tool metadata available to this cell.
- text(value): explicitly append text to this tool result.
- image(item): explicitly append a Pi/MCP image item or base64 data:image URL.

Built-in signatures supported by the broker:
- read({ path, offset?, limit? })
- bash({ command, timeout? })
- edit({ path, edits: [{ oldText, newText }] })
- write({ path, content })
- grep({ pattern, path?, glob?, ignoreCase?, literal?, context?, limit? })
- find({ pattern, path?, limit? })
- ls({ path?, limit? })

Use await for tool calls and Promise.all for independent calls. Nested tool errors reject their Promise and can be caught. Images returned by nested tools are not forwarded automatically; pass the selected image item to image(...). Return values are ignored and console is unavailable, so call text(...) or image(...) for every intended result. There is no require, import, process, fetch, timers, persistent store, wait, or yield API.`;
}

export default async function codeModeExtension(
	pi: ExtensionAPI,
): Promise<void> {
	let enabled = await readCodeModeState();
	let managerSeen = false;
	let managerPolicy: ManagerPolicySnapshot | undefined;
	let planModeEnabled = false;
	let lastLayerKey: string | undefined;
	let managerTimer: ReturnType<typeof setTimeout> | undefined;

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			"code-mode",
			enabled ? ctx.ui.theme.fg("accent", "⌘ code") : undefined,
		);
	}

	function desiredLayer(): RuntimeLayerSnapshot {
		if (!enabled) {
			return {
				id: LAYER_ID,
				priority: 100,
				disableTools: [TOOL_NAME],
				requireTools: [],
			};
		}
		const discovered = new Set([
			...(managerPolicy?.toolNames ?? []),
			...pi.getAllTools().map((tool) => tool.name),
		]);
		return {
			id: LAYER_ID,
			priority: 100,
			disableTools: Array.from(discovered)
				.filter((name) => name !== TOOL_NAME)
				.sort((a, b) => a.localeCompare(b)),
			requireTools: [TOOL_NAME],
		};
	}

	function applyToolLayer(): void {
		const layer = desiredLayer();
		const key = JSON.stringify(layer);
		if (key === lastLayerKey) return;
		lastLayerKey = key;
		pi.events.emit("config-manager:layer-set", layer);
	}

	function requestManagerSnapshot(): void {
		pi.events.emit("config-manager:request-snapshot", { requester: LAYER_ID });
	}

	function resolveAllowedBuiltins(): Set<string> {
		if (!managerPolicy) return new Set();
		const effective = new Set(managerPolicy.baseTools);
		const orderedLayers = [...managerPolicy.runtimeLayers].sort(
			(a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
		);
		for (const layer of orderedLayers) {
			if (layer.id === LAYER_ID) continue;
			for (const name of layer.disableTools) effective.delete(name);
			for (const name of layer.requireTools) effective.add(name);
		}
		return new Set(BUILTIN_TOOL_NAMES.filter((name) => effective.has(name)));
	}

	async function setEnabled(
		nextEnabled: boolean,
		ctx: ExtensionContext,
		options: { notify?: boolean } = {},
	): Promise<void> {
		if (nextEnabled && !managerSeen) {
			requestManagerSnapshot();
			if (!managerSeen) {
				throw new Error(
					"Code Mode requires the local Pi Config Manager extension to enforce Code-Mode-Only tool visibility.",
				);
			}
		}
		await writeCodeModeState(nextEnabled);
		enabled = nextEnabled;
		lastLayerKey = undefined;
		applyToolLayer();
		updateStatus(ctx);
		if (options.notify !== false) {
			ctx.ui.notify(
				nextEnabled
					? "Code Mode enabled. The model now sees only code_mode_exec."
					: "Code Mode disabled. Normal Pi tools restored.",
				"info",
			);
		}
	}

	async function disableForSafety(
		ctx: ExtensionContext,
		reason: string,
	): Promise<void> {
		enabled = false;
		lastLayerKey = undefined;
		applyToolLayer();
		updateStatus(ctx);
		try {
			await writeCodeModeState(false);
		} catch (storageError) {
			ctx.ui.notify(
				`Code Mode could not persist its fail-safe state: ${storageError instanceof Error ? storageError.message : String(storageError)}`,
				"warning",
			);
		}
		ctx.ui.notify(reason, "error");
	}

	pi.registerTool({
		name: TOOL_NAME,
		label: "Code Mode",
		description: toolDescription(),
		promptSnippet:
			"Execute stateless JavaScript that orchestrates currently enabled Pi built-ins",
		promptGuidelines: [
			"Use code_mode_exec to orchestrate built-in tools with JavaScript; use Promise.all for independent nested calls.",
			"Code Mode output is explicit: call text(...) for text and image(...) for selected images.",
		],
		parameters: CodeModeParams,
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!enabled)
				throw new Error("Code Mode is disabled. Use /code-mode on.");
			if (!managerSeen || !managerPolicy) {
				throw new Error(
					"Code Mode is waiting for Pi Config Manager policy state.",
				);
			}
			const allowedTools = resolveAllowedBuiltins();
			try {
				return await executeCodeCell({
					code: params.code,
					timeoutMs: (params.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1_000,
					createBroker: (runtimeSignal) =>
						createBuiltinToolBroker({
							ctx,
							signal: runtimeSignal,
							allowedTools,
							isPlanModeEnabled: () => planModeEnabled,
						}),
					signal,
					onUpdate,
					toolCallId,
				});
			} catch (error) {
				if (error instanceof RuntimeStartupError) {
					await disableForSafety(
						ctx,
						`Code Mode runtime failed to start and was disabled: ${error.message}`,
					);
				}
				if (error instanceof CodeModeExecutionError) throw error;
				throw new CodeModeExecutionError(
					error instanceof Error ? error.message : String(error),
				);
			}
		},
	});

	pi.registerCommand("code-mode", {
		description: "Enable, disable, or inspect Code Mode",
		getArgumentCompletions: (prefix) => {
			const values = ["on", "off", "status"].filter((value) =>
				value.startsWith(prefix.toLowerCase()),
			);
			return values.length > 0
				? values.map((value) => ({ value, label: value }))
				: null;
		},
		handler: async (args, ctx) => {
			let action = args.trim().toLowerCase();
			if (!action && ctx.hasUI) {
				const choice = await ctx.ui.select("Code Mode", [
					"On — expose only code_mode_exec",
					"Off — restore normal Pi tools",
					"Status — show current policy",
				]);
				if (!choice) return;
				action = choice.split(" ")[0].toLowerCase();
			}
			if (action === "status") {
				const tools = Array.from(resolveAllowedBuiltins()).sort((a, b) =>
					a.localeCompare(b),
				);
				ctx.ui.notify(
					`Code Mode: ${enabled ? "on" : "off"}\nState: ${CODE_MODE_STATE_PATH}\nNested built-ins: ${tools.join(", ") || "none"}`,
					"info",
				);
				return;
			}
			if (action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /code-mode on|off|status", "error");
				return;
			}
			try {
				await setEnabled(action === "on", ctx);
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});

	pi.events.on("config-manager:state-changed", (event) => {
		const policy = normalizeManagerSnapshot(event);
		if (!policy.sessionReady) return;
		managerSeen = true;
		managerPolicy = policy;
		applyToolLayer();
	});
	pi.events.on("plan-mode:state-changed", (event) => {
		planModeEnabled = (event as { enabled?: unknown }).enabled === true;
	});

	pi.on("session_start", async (_event, ctx) => {
		enabled = await readCodeModeState();
		managerSeen = false;
		planModeEnabled = false;
		managerPolicy = undefined;
		lastLayerKey = undefined;
		if (managerTimer) clearTimeout(managerTimer);
		updateStatus(ctx);
		applyToolLayer();
		requestManagerSnapshot();
		managerTimer = setTimeout(() => {
			managerTimer = undefined;
			if (managerSeen || !enabled) return;
			void disableForSafety(
				ctx,
				"Code Mode was disabled because Pi Config Manager did not provide tool policy state.",
			);
		}, 1_000);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (managerTimer) clearTimeout(managerTimer);
		managerTimer = undefined;
		ctx.ui.setStatus("code-mode", undefined);
	});
}
