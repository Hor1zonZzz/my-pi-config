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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	convertToLlm,
	sessionEntryToContextMessages,
	type SessionEntry,
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

const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_CODEX_API = "openai-codex-responses";
const RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;
const IMAGE_CONTENT_OMITTED_PLACEHOLDER =
	"image content omitted because you do not support image input";
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
	// Fallback message ids must match the provider's numbering, which skips the
	// leading system message that Pi 0.86.0 puts at the head of every transcript.
	const llmMessages = convertToLlm(messages);
	const items: ResponseItem[] = [];
	let messageIndex = 0;
	for (const [index, message] of llmMessages.entries()) {
		items.push(...baseMessageToResponseItems(message, messageIndex));
		if (index !== 0 || message.role !== "system") messageIndex++;
	}
	return items;
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

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
	// Opaque history has no entry-ID provenance, so we cannot safely patch it
	// when Pi edits context. Keep the canonical Pi projection until a fresh
	// compaction incorporates those edits. This rule survives resume/tree.
	if (params.branchEntries.slice(latestCompactionIndex + 1).some((entry) => entry.type === "context_edit")) {
		return undefined;
	}
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
