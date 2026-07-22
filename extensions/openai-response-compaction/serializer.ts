import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	ExtensionAPI,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
	clampThinkingLevel,
	type Api,
	type Model,
	type ModelThinkingLevel,
	type Tool,
} from "@earendil-works/pi-ai";
import type { NativeCompactionEntry } from "./types.ts";

type ResponsesSharedModule =
	typeof import("@earendil-works/pi-ai/api/openai-responses-shared");

let sharedModule: ResponsesSharedModule | undefined;

/**
 * Pi 0.81 aliases every extension import beginning with @earendil-works/pi-ai
 * to the compat root, including exported subpaths. Resolve that installed root
 * and load the public shared serializer by file URL so compact/replay
 * serialization stays identical to the active provider.
 */
export async function initializeResponsesSerializer(): Promise<void> {
	if (sharedModule) return;
	const piAIEntry = import.meta.resolve("@earendil-works/pi-ai");
	const modulePath = join(
		dirname(fileURLToPath(piAIEntry)),
		"api",
		"openai-responses-shared.js",
	);
	sharedModule = (await import(
		pathToFileURL(modulePath).href
	)) as ResponsesSharedModule;
}

function responsesShared(): ResponsesSharedModule {
	if (!sharedModule) {
		throw new Error("OpenAI Responses serializer was not initialized");
	}
	return sharedModule;
}

const CODEX_TOOL_CALL_PROVIDERS = new Set([
	"openai",
	"openai-codex",
	"opencode",
]);

export type ResponsesInputItem = Record<string, unknown>;

export type NativeCompactionRequest = {
	model: string;
	input: ResponsesInputItem[];
	instructions: string;
	parallel_tool_calls: true;
	prompt_cache_key: string;
	service_tier?: "priority";
	text: { verbosity: "low" };
	tools?: unknown[];
	reasoning?: { effort: string; summary: "auto" };
};

type CompactionMessages =
	SessionBeforeCompactEvent["preparation"]["messagesToSummarize"];

function cloneInputItems(items: readonly unknown[]): ResponsesInputItem[] {
	return items.map((item) => structuredClone(item) as ResponsesInputItem);
}

export function serializeMessagesToResponsesInput(
	model: Model<Api>,
	messages: CompactionMessages,
): ResponsesInputItem[] {
	const llmMessages = convertToLlm(messages);
	return responsesShared().convertResponsesMessages(
		model,
		{ messages: llmMessages },
		CODEX_TOOL_CALL_PROVIDERS,
		{ includeSystemPrompt: false },
	) as unknown as ResponsesInputItem[];
}

export function serializeCompactionPlaceholder(
	model: Model<Api>,
	entry: NativeCompactionEntry,
): ResponsesInputItem[] {
	const messages = sessionEntryToContextMessages(entry);
	return serializeMessagesToResponsesInput(model, messages);
}

export function serializeFallbackSummary(
	model: Model<Api>,
	summary: string,
): ResponsesInputItem[] {
	const message = {
		role: "user" as const,
		content: [
			{
				type: "text" as const,
				text: `Additional history compacted by Pi:\n\n<summary>\n${summary}\n</summary>`,
			},
		],
		timestamp: Date.now(),
	};
	return serializeMessagesToResponsesInput(model, [message]);
}

function activeTools(pi: ExtensionAPI): Tool[] {
	const activeNames = new Set(pi.getActiveTools());
	const tools: Tool[] = [];
	for (const tool of pi.getAllTools()) {
		if (!activeNames.has(tool.name)) continue;
		tools.push({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		});
	}
	return tools;
}

function requestTools(pi: ExtensionAPI): unknown[] | undefined {
	const tools = activeTools(pi);
	return tools.length > 0
		? responsesShared().convertResponsesTools(tools, { strict: null })
		: undefined;
}

function requestReasoning(
	pi: Pick<ExtensionAPI, "getThinkingLevel">,
	model: Model<Api>,
): NativeCompactionRequest["reasoning"] {
	const requested = pi.getThinkingLevel();
	if (!model.reasoning || requested === "off") return undefined;
	const clamped = clampThinkingLevel(model, requested as ModelThinkingLevel);
	const mapped = model.thinkingLevelMap?.[clamped] ?? clamped;
	if (mapped === null || typeof mapped !== "string") return undefined;
	return { effort: mapped, summary: "auto" };
}

function clampCacheKey(value: string): string {
	return Array.from(value).slice(0, 64).join("");
}

export function buildNativeCompactionRequest(args: {
	pi: ExtensionAPI;
	model: Model<Api>;
	event: SessionBeforeCompactEvent;
	previousCompactedWindow?: readonly unknown[];
	instructions: string;
	sessionId: string;
	fastEnabled: boolean;
}): NativeCompactionRequest {
	const newWindow = serializeMessagesToResponsesInput(args.model, [
		...args.event.preparation.messagesToSummarize,
		...args.event.preparation.turnPrefixMessages,
	]);
	let previousWindow: ResponsesInputItem[] = [];
	if (args.previousCompactedWindow) {
		previousWindow = cloneInputItems(args.previousCompactedWindow);
	} else if (args.event.preparation.previousSummary?.trim()) {
		previousWindow = serializeFallbackSummary(
			args.model,
			args.event.preparation.previousSummary,
		);
	}
	const tools = requestTools(args.pi);
	const reasoning = requestReasoning(args.pi, args.model);
	return {
		model: args.model.id,
		input: [...previousWindow, ...newWindow],
		instructions: args.instructions,
		parallel_tool_calls: true,
		prompt_cache_key: clampCacheKey(args.sessionId),
		...(args.fastEnabled ? { service_tier: "priority" as const } : {}),
		text: { verbosity: "low" },
		...(tools ? { tools } : {}),
		...(reasoning ? { reasoning } : {}),
	};
}
