// Adapted from pi-openai-server-compaction by Alexis Gallagher (MIT).
// This local variant intentionally supports only OpenAI Codex Responses.
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	calculateCost,
	type Model,
	type ProviderHeaders,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	convertToLlm,
	sessionEntryToContextMessages,
	type SessionEntry,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

export type JsonRecord = Record<string, unknown>;
export type ResponseItem = JsonRecord & { type?: string };
export type ResponsesReasoningConfig = Record<string, unknown>;
export type ResponsesTextConfig = Record<string, unknown>;
export type RemoteCompactionUsageSnapshot = Usage;

export type RemoteCompactionDetails = {
	version: 2;
	provider: "openai-responses-compaction";
	implementation: "responses_compaction_v2";
	modelKey: string;
	accountKey?: string;
	replacementHistory: ResponseItem[];
	usage?: RemoteCompactionUsageSnapshot;
};

export type RemoteCompactionSessionState = {
	compactionEntryId: string;
	modelKey: string;
	replacementHistory: ResponseItem[];
	explicitHistory: ResponseItem[];
};

export type RemoteCompactionResult = {
	output: ResponseItem[];
	usage?: RemoteCompactionUsageSnapshot;
};

const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_CODEX_API = "openai-codex-responses";
const REMOTE_COMPACTION_V2_FEATURE = "remote_compaction_v2";
const RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;
const IMAGE_CONTENT_OMITTED_PLACEHOLDER =
	"image content omitted because you do not support image input";
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_REMOTE_COMPACTION_TIMEOUT_MS = 5 * 60 * 1_000;

export function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOpenAICodexResponsesModel(
	model: unknown,
): model is Model<any> {
	return (
		isRecord(model) &&
		model.provider === OPENAI_CODEX_PROVIDER &&
		model.api === OPENAI_CODEX_API
	);
}

export function modelKey(model: Model<any>): string {
	return `${model.provider}:${model.api}:${model.id}`;
}

export function messageMatchesModel(
	message: unknown,
	model: Model<any>,
): boolean {
	return (
		isRecord(message) &&
		message.provider === model.provider &&
		message.api === model.api &&
		message.model === model.id
	);
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
	const trimmed = baseUrl?.trim();
	return (trimmed || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
}

export function remoteCompactionV2EndpointUrl(
	model: Model<any>,
	resolvedBaseUrl?: string,
): string {
	if (!isOpenAICodexResponsesModel(model)) {
		throw new Error("Codex remote compaction v2 requires an openai-codex model.");
	}
	const baseUrl = normalizeBaseUrl(resolvedBaseUrl || model.baseUrl);
	if (baseUrl.endsWith("/codex/responses")) return baseUrl;
	if (baseUrl.endsWith("/codex")) return `${baseUrl}/responses`;
	return `${baseUrl}/codex/responses`;
}

function resolveCodexHome(): string {
	const configured = process.env.CODEX_HOME?.trim();
	return configured || join(homedir(), ".codex");
}

/**
 * Reuses Codex CLI's installation UUID when valid, otherwise creates a UUID in
 * the same CODEX_HOME location. The identifier is client metadata, not a secret.
 */
export function resolveCodexInstallationId(): string {
	const path = join(resolveCodexHome(), "installation_id");
	try {
		if (existsSync(path)) {
			const existing = readFileSync(path, "utf8").trim();
			if (UUID_RE.test(existing)) return existing.toLowerCase();
		}
	} catch {
		// Match Codex's invalid/unreadable-file behavior by regenerating below.
	}

	const installationId = randomUUID();
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, installationId, { encoding: "utf8", mode: 0o644 });
		chmodSync(path, 0o644);
	} catch {
		// The installation id is a parity hint, not a reason to fail compaction.
	}
	return installationId;
}

function extractCodexAccountId(token: string): string {
	const parts = token.split(".");
	if (parts.length !== 3) {
		throw new Error("Failed to extract accountId from Codex token");
	}
	const payload = JSON.parse(
		Buffer.from(parts[1], "base64url").toString("utf8"),
	) as JsonRecord;
	const auth = isRecord(payload["https://api.openai.com/auth"])
		? payload["https://api.openai.com/auth"]
		: undefined;
	const accountId = auth?.chatgpt_account_id;
	if (typeof accountId !== "string" || !accountId) {
		throw new Error("Failed to extract accountId from Codex token");
	}
	return accountId;
}

function applyProviderHeaders(
	headers: Headers,
	providerHeaders: ProviderHeaders | undefined,
): void {
	for (const [name, value] of Object.entries(providerHeaders ?? {})) {
		if (value === null) headers.delete(name);
		else headers.set(name, value);
	}
}

export function buildRemoteCompactionHeaders(params: {
	model: Model<any>;
	apiKey: string;
	headers?: ProviderHeaders;
	sessionId: string;
	serviceTier?: string;
}): Record<string, string> {
	if (!isOpenAICodexResponsesModel(params.model)) {
		throw new Error("Codex remote compaction headers require an openai-codex model.");
	}

	const headers = new Headers();
	applyProviderHeaders(headers, params.headers);
	headers.set("authorization", `Bearer ${params.apiKey}`);
	headers.set("chatgpt-account-id", extractCodexAccountId(params.apiKey));
	headers.set("x-codex-installation-id", resolveCodexInstallationId());
	headers.set("x-codex-window-id", `${params.sessionId}:0`);
	headers.set("session-id", params.sessionId);
	headers.set("x-client-request-id", params.sessionId);
	headers.set("originator", "pi");
	headers.set(
		"user-agent",
		`pi-codex-server-compaction (${platform()} ${release()}; ${arch()})`,
	);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");

	const features = (headers.get("x-codex-beta-features") ?? "")
		.split(",")
		.map((feature) => feature.trim())
		.filter(Boolean);
	headers.set(
		"x-codex-beta-features",
		[...new Set([...features, REMOTE_COMPACTION_V2_FEATURE])].join(","),
	);

	const routingHint = params.serviceTier
		? `model=${params.model.id};tier=${params.serviceTier}`
		: `model=${params.model.id}`;
	headers.set("x-codex-routing-hint", routingHint);

	return Object.fromEntries(headers.entries());
}

function isResponseItem(value: unknown): value is ResponseItem {
	return isRecord(value) && typeof value.type === "string";
}

function cloneResponseItem(item: ResponseItem): ResponseItem {
	return JSON.parse(JSON.stringify(item)) as ResponseItem;
}

function parseTextSignature(value: unknown): {
	id: string;
	phase?: "commentary" | "final_answer";
} | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	if (value.startsWith("{")) {
		try {
			const parsed = JSON.parse(value) as {
				v?: unknown;
				id?: unknown;
				phase?: unknown;
			};
			if (parsed.v === 1 && typeof parsed.id === "string") {
				return {
					id: parsed.id,
					...(parsed.phase === "commentary" || parsed.phase === "final_answer"
						? { phase: parsed.phase }
						: {}),
				};
			}
		} catch {
			// Fall through to the legacy plain-string ID.
		}
	}
	return { id: value };
}

function baseMessageToResponseItems(
	message: AgentMessage,
	messageIndex = 0,
): ResponseItem[] {
	if (message.role === "user") {
		const content: JsonRecord[] = [];
		if (typeof message.content === "string") {
			if (message.content) {
				content.push({ type: "input_text", text: message.content });
			}
		} else {
			for (const part of message.content) {
				if (part.type === "text") {
					content.push({ type: "input_text", text: part.text });
				} else if (part.type === "image") {
					content.push({
						type: "input_image",
						image_url: `data:${part.mimeType};base64,${part.data}`,
					});
				}
			}
		}
		// Match Pi's canonical Responses Easy Input shape. The omitted `type`
		// matters to the cached WebSocket continuation prefix comparison.
		return content.length > 0 ? [{ role: "user", content }] : [];
	}

	if (message.role === "assistant") {
		const items: ResponseItem[] = [];
		let textBlockIndex = 0;
		for (const block of message.content) {
			if (block.type === "text") {
				const signature = parseTextSignature(block.textSignature);
				const fallbackId =
					textBlockIndex === 0
						? `msg_pi_${messageIndex}`
						: `msg_pi_${messageIndex}_${textBlockIndex}`;
				textBlockIndex++;
				items.push({
					type: "message",
					role: "assistant",
					content: [
						{ type: "output_text", text: block.text, annotations: [] },
					],
					status: "completed",
					id: signature?.id ?? fallbackId,
					...(signature?.phase ? { phase: signature.phase } : {}),
				});
				continue;
			}
			if (block.type === "thinking") {
				if (!block.thinkingSignature) continue;
				try {
					const parsed = JSON.parse(block.thinkingSignature);
					if (isResponseItem(parsed) && parsed.type === "reasoning") {
						items.push(parsed);
					}
				} catch {
					// A malformed/foreign signature is not replayable.
				}
				continue;
			}
			if (block.type === "toolCall") {
				const [callId, itemId] = block.id.split("|");
				items.push({
					type: "function_call",
					...(itemId?.startsWith("fc_") ? { id: itemId } : {}),
					name: block.name,
					call_id: callId,
					arguments: JSON.stringify(block.arguments ?? {}),
					...(block.namespace ? { namespace: block.namespace } : {}),
				});
			}
		}
		return items;
	}

	if (message.role === "toolResult") {
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		return [
			{
				type: "function_call_output",
				call_id: message.toolCallId.split("|", 1)[0],
				output: text || "(no tool output)",
			},
		];
	}

	return [];
}

export function messageToResponseItems(
	message: AgentMessage,
	_model: Model<any>,
): ResponseItem[] {
	return convertToLlm([message]).flatMap((normalized, index) =>
		baseMessageToResponseItems(normalized, index),
	);
}

export function messagesToResponseItems(
	messages: AgentMessage[],
	_model: Model<any>,
): ResponseItem[] {
	return convertToLlm(messages).flatMap((message, index) =>
		baseMessageToResponseItems(message, index),
	);
}

function responseItemCallId(item: ResponseItem): string | undefined {
	return typeof item.call_id === "string" && item.call_id ? item.call_id : undefined;
}

function outputTypeForCallType(type: string | undefined): string | undefined {
	if (type === "function_call" || type === "local_shell_call") {
		return "function_call_output";
	}
	if (type === "tool_search_call") return "tool_search_output";
	if (type === "custom_tool_call") return "custom_tool_call_output";
	return undefined;
}

function syntheticOutputForCall(item: ResponseItem): ResponseItem | undefined {
	const callId = responseItemCallId(item);
	if (!callId) return undefined;
	if (item.type === "function_call" || item.type === "local_shell_call") {
		return {
			type: "function_call_output",
			call_id: callId,
			output: "aborted",
		};
	}
	if (item.type === "tool_search_call") {
		return {
			type: "tool_search_output",
			call_id: callId,
			status: "completed",
			execution: "client",
			tools: [],
		};
	}
	if (item.type === "custom_tool_call") {
		return {
			type: "custom_tool_call_output",
			call_id: callId,
			output: "aborted",
		};
	}
	return undefined;
}

function ensureCallOutputsPresent(items: ResponseItem[]): ResponseItem[] {
	const normalized: ResponseItem[] = [];
	for (const item of items) {
		normalized.push(item);
		const outputType = outputTypeForCallType(item.type);
		const callId = responseItemCallId(item);
		if (!outputType || !callId) continue;
		const hasOutput = items.some(
			(candidate) =>
				candidate.type === outputType && responseItemCallId(candidate) === callId,
		);
		if (!hasOutput) {
			const synthetic = syntheticOutputForCall(item);
			if (synthetic) normalized.push(synthetic);
		}
	}
	return normalized;
}

function removeOrphanOutputs(items: ResponseItem[]): ResponseItem[] {
	const callsByOutputType = new Map<string, Set<string>>();
	for (const item of items) {
		const outputType = outputTypeForCallType(item.type);
		const callId = responseItemCallId(item);
		if (!outputType || !callId) continue;
		const calls = callsByOutputType.get(outputType) ?? new Set<string>();
		calls.add(callId);
		callsByOutputType.set(outputType, calls);
	}

	return items.filter((item) => {
		if (
			item.type !== "function_call_output" &&
			item.type !== "custom_tool_call_output" &&
			item.type !== "tool_search_output"
		) {
			return true;
		}
		if (item.type === "tool_search_output" && item.execution === "server") {
			return true;
		}
		const callId = responseItemCallId(item);
		return Boolean(callId && callsByOutputType.get(item.type)?.has(callId));
	});
}

function stripImagesFromValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripImagesFromValue);
	if (!isRecord(value)) return value;
	if (value.type === "input_image") {
		return { type: "input_text", text: IMAGE_CONTENT_OMITTED_PLACEHOLDER };
	}
	if (value.type === "image_generation_call" && typeof value.result === "string") {
		return { ...value, result: "" };
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [key, stripImagesFromValue(entry)]),
	);
}

export function normalizeResponseItemsForPrompt(
	items: ResponseItem[],
	model: Model<any>,
): ResponseItem[] {
	const withoutGhostSnapshots = items
		.filter((item) => item.type !== "ghost_snapshot")
		.map(cloneResponseItem);
	const withCallOutputs = ensureCallOutputsPresent(withoutGhostSnapshots);
	const withoutOrphans = removeOrphanOutputs(withCallOutputs);
	return model.input.includes("image")
		? withoutOrphans
		: (withoutOrphans.map(stripImagesFromValue) as ResponseItem[]);
}

function isRealUserMessage(item: ResponseItem): boolean {
	if ((item.type !== undefined && item.type !== "message") || item.role !== "user") return false;
	if (typeof item.content === "string") return item.content.trim().length > 0;
	return Array.isArray(item.content) && item.content.length > 0;
}

function responseMessageText(item: ResponseItem): string {
	if (item.type !== "message" || !Array.isArray(item.content)) return "";
	return item.content
		.flatMap((part) =>
			isRecord(part) &&
			(part.type === "input_text" || part.type === "output_text") &&
			typeof part.text === "string"
				? [part.text]
				: [],
		)
		.join("");
}

function approximateMessageTokens(item: ResponseItem): number {
	return Math.max(1, Math.ceil(responseMessageText(item).length / 4));
}

function truncateMessageToTokenBudget(
	item: ResponseItem,
	maxTokens: number,
): ResponseItem | undefined {
	if (item.type !== "message" || !Array.isArray(item.content)) {
		return cloneResponseItem(item);
	}
	let remainingCharacters = Math.max(0, maxTokens * 4);
	const content = item.content.flatMap((part) => {
		if (!isRecord(part)) return [];
		if (part.type === "input_image") return [part];
		if (typeof part.text !== "string" || remainingCharacters === 0) return [];
		const text = part.text.slice(0, remainingCharacters);
		remainingCharacters -= text.length;
		return text ? [{ ...part, text }] : [];
	});
	return content.length > 0
		? { ...cloneResponseItem(item), content }
		: undefined;
}

function truncateRetainedMessages(
	items: ResponseItem[],
	maxTokens: number,
): ResponseItem[] {
	let remainingTokens = maxTokens;
	const retainedReversed: ResponseItem[] = [];
	for (const item of [...items].reverse()) {
		if (remainingTokens === 0) break;
		const tokenCount = approximateMessageTokens(item);
		if (tokenCount <= remainingTokens) {
			retainedReversed.push(cloneResponseItem(item));
			remainingTokens -= tokenCount;
			continue;
		}
		const truncated = truncateMessageToTokenBudget(item, remainingTokens);
		if (truncated) retainedReversed.push(truncated);
		remainingTokens = 0;
	}
	return retainedReversed.reverse();
}

export function buildRemoteCompactionV2History(
	input: ResponseItem[],
	compactionItem: ResponseItem,
): ResponseItem[] {
	if (compactionItem.type !== "compaction") {
		throw new Error("Codex remote compaction v2 did not return a compaction item.");
	}
	const retainedUserMessages = input.filter(isRealUserMessage);
	return [
		...truncateRetainedMessages(
			retainedUserMessages,
			RETAINED_MESSAGE_TOKEN_BUDGET,
		),
		cloneResponseItem(compactionItem),
	];
}

export function buildToolsPayload(
	allTools: ToolInfo[],
	activeToolNames: string[],
): JsonRecord[] {
	const active = new Set(activeToolNames);
	return allTools
		.filter((tool) => active.has(tool.name))
		.map((tool) => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));
}

export function buildRemoteCompactionRequestBody(params: {
	model: Model<any>;
	input: ResponseItem[];
	instructions?: string;
	tools: JsonRecord[];
	parallelToolCalls: boolean;
	reasoning?: ResponsesReasoningConfig;
	text?: ResponsesTextConfig;
	serviceTier?: string;
	sessionId: string;
}): JsonRecord {
	return {
		model: params.model.id,
		input: [...params.input, { type: "compaction_trigger" }],
		instructions: params.instructions,
		tools: params.tools,
		parallel_tool_calls: params.parallelToolCalls,
		tool_choice: "auto",
		stream: true,
		store: false,
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: params.sessionId,
		...(params.reasoning ? { reasoning: params.reasoning } : {}),
		...(params.text ? { text: params.text } : {}),
		...(params.serviceTier ? { service_tier: params.serviceTier } : {}),
	};
}

export function parseSseData(text: string): unknown[] {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n\n")
		.flatMap((block) => {
			const data = block
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n")
				.trim();
			if (!data || data === "[DONE]") return [];
			try {
				return [JSON.parse(data) as unknown];
			} catch {
				return [];
			}
		});
}

export function parseRemoteCompactionV2Events(events: unknown[]): {
	compactionItem: ResponseItem;
	usage?: unknown;
} {
	let completed = false;
	let usage: unknown;
	const compactionItems: ResponseItem[] = [];
	for (const event of events) {
		if (!isRecord(event)) continue;
		if (event.type === "error") {
			const message =
				typeof event.message === "string"
					? event.message
					: "Unknown Responses API error";
			throw new Error(`Codex remote compaction v2 failed: ${message}`);
		}
		if (event.type === "response.failed") {
			const response = isRecord(event.response) ? event.response : undefined;
			const error = response && isRecord(response.error) ? response.error : undefined;
			const message =
				typeof error?.message === "string" ? error.message : "Response failed";
			throw new Error(`Codex remote compaction v2 failed: ${message}`);
		}
		if (
			event.type === "response.output_item.done" &&
			isResponseItem(event.item) &&
			event.item.type === "compaction"
		) {
			compactionItems.push(event.item);
			continue;
		}
		if (event.type === "response.completed") {
			completed = true;
			const response = isRecord(event.response) ? event.response : undefined;
			usage = response?.usage;
		}
	}
	if (!completed) {
		throw new Error(
			"Codex remote compaction v2 stream ended before response.completed.",
		);
	}
	if (compactionItems.length !== 1) {
		throw new Error(
			`Codex remote compaction v2 expected exactly one compaction item, got ${compactionItems.length}.`,
		);
	}
	return { compactionItem: compactionItems[0], usage };
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function extractRemoteCompactionUsage(
	model: Model<any>,
	value: unknown,
	serviceTier?: string,
): RemoteCompactionUsageSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	const inputTokens = finiteNumber(value.input_tokens);
	const outputTokens = finiteNumber(value.output_tokens);
	const totalTokens = finiteNumber(value.total_tokens) || inputTokens + outputTokens;
	const inputDetails = isRecord(value.input_tokens_details)
		? value.input_tokens_details
		: undefined;
	const cachedTokens = finiteNumber(inputDetails?.cached_tokens);
	const cacheWriteTokens =
		finiteNumber(inputDetails?.cache_creation_tokens) ||
		finiteNumber(inputDetails?.cache_write_tokens);
	const outputDetails = isRecord(value.output_tokens_details)
		? value.output_tokens_details
		: undefined;
	const reasoningTokens = finiteNumber(outputDetails?.reasoning_tokens);

	const usage: Usage = {
		input: Math.max(0, inputTokens - cachedTokens - cacheWriteTokens),
		output: outputTokens,
		cacheRead: cachedTokens,
		cacheWrite: cacheWriteTokens,
		...(outputDetails && "reasoning_tokens" in outputDetails
			? { reasoning: reasoningTokens }
			: {}),
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	if (serviceTier === "priority") {
		// Keep compaction accounting aligned with Pi 0.84.3's Codex stream pricing.
		const multiplier = model.id === "gpt-5.5" ? 2.5 : 2;
		usage.cost.input *= multiplier;
		usage.cost.output *= multiplier;
		usage.cost.cacheRead *= multiplier;
		usage.cost.cacheWrite *= multiplier;
		usage.cost.total =
			usage.cost.input +
			usage.cost.output +
			usage.cost.cacheRead +
			usage.cost.cacheWrite;
	}
	return usage;
}

export async function callRemoteCompactionEndpoint(params: {
	model: Model<any>;
	resolvedBaseUrl?: string;
	apiKey: string;
	headers?: ProviderHeaders;
	sessionId: string;
	input: ResponseItem[];
	instructions?: string;
	tools: JsonRecord[];
	parallelToolCalls: boolean;
	reasoning?: ResponsesReasoningConfig;
	text?: ResponsesTextConfig;
	serviceTier?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetchFn?: typeof fetch;
}): Promise<RemoteCompactionResult> {
	if (!isOpenAICodexResponsesModel(params.model)) {
		throw new Error("Codex remote compaction v2 requires an openai-codex model.");
	}
	const timeoutSignal = AbortSignal.timeout(
		params.timeoutMs ?? DEFAULT_REMOTE_COMPACTION_TIMEOUT_MS,
	);
	const signal = params.signal
		? AbortSignal.any([params.signal, timeoutSignal])
		: timeoutSignal;
	const response = await (params.fetchFn ?? fetch)(
		remoteCompactionV2EndpointUrl(params.model, params.resolvedBaseUrl),
		{
			method: "POST",
			headers: buildRemoteCompactionHeaders({
				model: params.model,
				apiKey: params.apiKey,
				headers: params.headers,
				sessionId: params.sessionId,
				serviceTier: params.serviceTier,
			}),
			body: JSON.stringify(
				buildRemoteCompactionRequestBody({
					model: params.model,
					input: params.input,
					instructions: params.instructions,
					tools: params.tools,
					parallelToolCalls: params.parallelToolCalls,
					reasoning: params.reasoning,
					text: params.text,
					serviceTier: params.serviceTier,
					sessionId: params.sessionId,
				}),
			),
			signal,
		},
	);
	if (!response.ok) {
		const responseText = await response.text().catch(() => "");
		const bounded = responseText.slice(0, 2_000);
		throw new Error(
			`Codex remote compaction v2 failed (${response.status}): ${bounded || response.statusText}`,
		);
	}
	const parsed = parseRemoteCompactionV2Events(
		parseSseData(await response.text()),
	);
	return {
		output: buildRemoteCompactionV2History(params.input, parsed.compactionItem),
		usage: extractRemoteCompactionUsage(
			params.model,
			parsed.usage,
			params.serviceTier,
		),
	};
}

export function buildRemoteCompactionDetails(
	model: Model<any>,
	replacementHistory: ResponseItem[],
	usage?: RemoteCompactionUsageSnapshot,
	accountKey?: string,
): RemoteCompactionDetails {
	return {
		version: 2,
		provider: "openai-responses-compaction",
		implementation: "responses_compaction_v2",
		modelKey: modelKey(model),
		...(accountKey ? { accountKey } : {}),
		replacementHistory,
		...(usage ? { usage } : {}),
	};
}

function parseUsage(value: unknown): Usage | undefined {
	if (!isRecord(value)) return undefined;
	const costValue = isRecord(value.cost) ? value.cost : {};
	return {
		input: finiteNumber(value.input),
		output: finiteNumber(value.output),
		cacheRead: finiteNumber(value.cacheRead),
		cacheWrite: finiteNumber(value.cacheWrite),
		...(typeof value.reasoning === "number" ? { reasoning: value.reasoning } : {}),
		...(typeof value.cacheWrite1h === "number"
			? { cacheWrite1h: value.cacheWrite1h }
			: {}),
		totalTokens:
			finiteNumber(value.totalTokens) ||
			finiteNumber(value.input) +
				finiteNumber(value.output) +
				finiteNumber(value.cacheRead) +
				finiteNumber(value.cacheWrite),
		cost: {
			input: finiteNumber(costValue.input),
			output: finiteNumber(costValue.output),
			cacheRead: finiteNumber(costValue.cacheRead),
			cacheWrite: finiteNumber(costValue.cacheWrite),
			total:
				finiteNumber(costValue.total) ||
				finiteNumber(costValue.input) +
					finiteNumber(costValue.output) +
					finiteNumber(costValue.cacheRead) +
					finiteNumber(costValue.cacheWrite),
		},
	};
}

export function combineUsage(
	left: Usage | undefined,
	right: Usage | undefined,
): Usage | undefined {
	if (!left) return right;
	if (!right) return left;
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		...(left.cacheWrite1h !== undefined || right.cacheWrite1h !== undefined
			? { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }
			: {}),
		...(left.reasoning !== undefined || right.reasoning !== undefined
			? { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }
			: {}),
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

export function extractRemoteCompactionDetails(
	details: unknown,
): RemoteCompactionDetails | undefined {
	if (!isRecord(details)) return undefined;
	const remote = isRecord(details.remoteCompaction)
		? details.remoteCompaction
		: undefined;
	if (!remote) return undefined;
	const isV2 =
		remote.provider === "openai-responses-compaction" &&
		remote.version === 2 &&
		remote.implementation === "responses_compaction_v2";
	if (!isV2) return undefined;
	if (!Array.isArray(remote.replacementHistory)) return undefined;
	const replacementHistory = remote.replacementHistory.filter(isResponseItem);
	if (replacementHistory.length === 0) return undefined;
	return {
		version: 2,
		provider: "openai-responses-compaction",
		implementation: "responses_compaction_v2",
		modelKey: typeof remote.modelKey === "string" ? remote.modelKey : "",
		...(typeof remote.accountKey === "string" ? { accountKey: remote.accountKey } : {}),
		replacementHistory,
		...(parseUsage(remote.usage) ? { usage: parseUsage(remote.usage) } : {}),
	};
}

function assistantMessageMatchesModelKey(
	message: AgentMessage,
	targetModelKey: string,
): boolean {
	const [provider, api, id] = targetModelKey.split(":", 3);
	return (
		message.role === "assistant" &&
		Boolean(provider && api && id) &&
		message.provider === provider &&
		message.api === api &&
		message.model === id
	);
}

function entryContextMessages(entry: {
	type: string;
	message?: AgentMessage;
}): AgentMessage[] {
	if (entry.type === "message" && entry.message) return [entry.message];
	if (entry.type === "compaction") return [];
	try {
		return sessionEntryToContextMessages(entry as SessionEntry);
	} catch {
		return [];
	}
}

export function reconstructRemoteCompactionStateFromBranch(params: {
	branchEntries: Array<{
		type: string;
		id: string;
		details?: unknown;
		message?: AgentMessage;
		customType?: unknown;
		data?: unknown;
	}>;
	model?: Model<any>;
	accountKey?: string;
}): RemoteCompactionSessionState | undefined {
	let latestCompactionIndex = -1;
	let latestCompactionEntryId = "";
	let latestDetails: RemoteCompactionDetails | undefined;
	params.branchEntries.forEach((entry, index) => {
		if (entry.type !== "compaction") return;
		latestCompactionIndex = index;
		latestCompactionEntryId = entry.id;
		latestDetails = extractRemoteCompactionDetails(entry.details);
	});
	if (!latestDetails || latestCompactionIndex < 0) return undefined;
	// Unknown legacy ownership also falls back to the saved Pi text summary.
	if (params.accountKey && latestDetails.accountKey !== params.accountKey) return undefined;
	if (params.model && latestDetails.modelKey !== modelKey(params.model)) {
		return undefined;
	}

	const trailingMessages: ResponseItem[] = [];
	let pendingTurnItems: ResponseItem[] = [];
	for (const entry of params.branchEntries.slice(latestCompactionIndex + 1)) {
		if (params.accountKey && entry.type === "custom" && entry.customType === "codex-account-context"
			&& (!isRecord(entry.data) || entry.data.accountKey !== params.accountKey)) return undefined;
		for (const message of entryContextMessages(entry)) {
			if (
				message.role === "assistant" &&
				!assistantMessageMatchesModelKey(message, latestDetails.modelKey)
			) {
				// Once another model completes a turn, replaying the older native
				// artifact would omit that turn. Let Pi's text-summary path carry the
				// complete cross-model context until this model compacts again.
				return undefined;
			}
			const targetModel = params.model;
			const items = targetModel
				? messageToResponseItems(message, targetModel)
				: convertToLlm([message]).flatMap((normalized) =>
						baseMessageToResponseItems(normalized),
					);
			if (message.role === "assistant") {
				if (items.length > 0) {
					trailingMessages.push(...pendingTurnItems, ...items);
				}
				pendingTurnItems = [];
				continue;
			}
			if (items.length > 0) pendingTurnItems.push(...items);
		}
	}
	trailingMessages.push(...pendingTurnItems);
	return {
		compactionEntryId: latestCompactionEntryId,
		modelKey: latestDetails.modelKey,
		replacementHistory: latestDetails.replacementHistory,
		explicitHistory: [
			...latestDetails.replacementHistory,
			...trailingMessages,
		],
	};
}

export function applyRemoteHistoryPayloadPatch(params: {
	payload: JsonRecord;
	explicitHistory: ResponseItem[];
}): JsonRecord {
	const nextPayload: JsonRecord = {
		...params.payload,
		input: params.explicitHistory,
	};
	delete nextPayload.messages;
	delete nextPayload.previous_response_id;
	return nextPayload;
}

export function buildCompactionSummaryText(model: Model<any>): string {
	return `Codex remote compaction applied for ${model.provider}/${model.id}. Pi keeps this textual summary for portability, while the original Codex model can use provider-native replacement history stored in compaction details.`;
}
