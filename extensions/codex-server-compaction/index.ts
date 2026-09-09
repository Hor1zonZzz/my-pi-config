// Adapted from pi-openai-server-compaction by Alexis Gallagher (MIT) and
// @howaboua/pi-codex-conversion by Igor Warzocha and contributors (MIT).
// This local variant intentionally supports only OpenAI Codex Responses.
import { randomUUID } from "node:crypto";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { calculateCost, type Model, type ProviderHeaders, type Usage } from "@earendil-works/pi-ai";
import {
	compact,
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	applyRemoteHistoryPayloadPatch,
	buildCompactionSummaryText,
	buildRemoteCompactionDetails,
	buildRemoteCompactionV2History,
	combineUsage,
	isOpenAICodexResponsesModel,
	isRecord,
	messagesToResponseItems,
	normalizeResponseItemsForPrompt,
	reconstructRemoteCompactionStateFromBranch,
	type JsonRecord,
	type ResponsesReasoningConfig,
	type ResponsesTextConfig,
} from "./remote-compaction.ts";
import { executeRemoteCompactionV2 } from "./vendor/howaboua/adapter/compaction/remote-v2-client.ts";
import {
	closeOpenAICodexWebSocketSessions,
	registerOpenAICodexCustomProvider,
} from "./vendor/howaboua/providers/openai-codex-custom-provider.ts";
import {
	canonicalCompactionPromptInput,
} from "./vendor/howaboua/providers/openai-codex/session-continuity.ts";
import { extractAccountId, resolveCodexWebSocketUrl } from "./vendor/howaboua/providers/openai-codex/headers.ts";
import { accountFromToken } from "../codex-statusline/quota.ts";
import { ACCOUNT_CONTEXT_ENTRY, hasForeignAccountHistory, latestHistoryAccount, stripOpaqueAccountInput } from "./account-history.ts";
import type { ResponsesBody } from "./vendor/howaboua/providers/openai-codex/types.ts";

const FAST_STATE_ENTRY_TYPE = "codex-fast";

type BranchEntry = {
	type: string;
	id: string;
	details?: unknown;
	message?: AgentMessage;
	thinkingLevel?: unknown;
	customType?: unknown;
	data?: unknown;
};

type ResponsesRequestShapeState = {
	reasoning?: ResponsesReasoningConfig;
	text?: ResponsesTextConfig;
	serviceTier?: string;
	parallelToolCalls?: boolean;
};

type ResolvedAuth = {
	apiKey: string;
	headers?: ProviderHeaders;
	baseUrl?: string;
	env?: Record<string, string>;
};

const requestShapeBySessionId = new Map<string, ResponsesRequestShapeState>();

function getSessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

function getBranchEntries(ctx: ExtensionContext): BranchEntry[] {
	return ctx.sessionManager.getBranch() as BranchEntry[];
}

function getPiContextMessages(ctx: ExtensionContext): AgentMessage[] {
	return ctx.sessionManager.buildContextEntries().flatMap((entry) => {
		try {
			return sessionEntryToContextMessages(entry);
		} catch {
			return [];
		}
	});
}

function getBranchThinkingLevel(
	branchEntries: BranchEntry[],
): ThinkingLevel | undefined {
	for (let index = branchEntries.length - 1; index >= 0; index--) {
		const entry = branchEntries[index];
		if (entry?.type !== "thinking_level_change") continue;
		const level = entry.thinkingLevel;
		if (
			level === "minimal" ||
			level === "low" ||
			level === "medium" ||
			level === "high" ||
			level === "xhigh" ||
			level === "max"
		) {
			return level;
		}
	}
	return undefined;
}

function getFastState(branchEntries: BranchEntry[]): boolean | undefined {
	let enabled: boolean | undefined;
	for (const entry of branchEntries) {
		if (entry.type !== "custom" || entry.customType !== FAST_STATE_ENTRY_TYPE) {
			continue;
		}
		if (isRecord(entry.data) && typeof entry.data.enabled === "boolean") {
			enabled = entry.data.enabled;
		}
	}
	return enabled;
}

function resolveServiceTier(
	branchEntries: BranchEntry[],
	observed: ResponsesRequestShapeState | undefined,
): string | undefined {
	const fastState = getFastState(branchEntries);
	if (fastState !== undefined) return fastState ? "priority" : undefined;
	return observed?.serviceTier;
}

function thinkingLevelToResponsesReasoning(
	model: Model<any>,
	thinkingLevel: ThinkingLevel | undefined,
): ResponsesReasoningConfig | undefined {
	if (!thinkingLevel || !model.reasoning) return undefined;
	const mapped = model.thinkingLevelMap?.[thinkingLevel] ?? thinkingLevel;
	if (mapped === null || mapped === "off") return undefined;
	return { effort: mapped, summary: "auto" };
}

function extractRequestShape(payload: JsonRecord): ResponsesRequestShapeState {
	return {
		...(isRecord(payload.reasoning) ? { reasoning: payload.reasoning } : {}),
		...(isRecord(payload.text) ? { text: payload.text } : {}),
		...(typeof payload.service_tier === "string"
			? { serviceTier: payload.service_tier }
			: {}),
		...(typeof payload.parallel_tool_calls === "boolean"
			? { parallelToolCalls: payload.parallel_tool_calls }
			: {}),
	};
}

function toRemoteUsage(model: Model<any>, value: {
	inputTokens: number;
	cachedInputTokens: number;
	cacheWriteInputTokens: number;
	outputTokens: number;
} | undefined, serviceTier?: string): Usage | undefined {
	if (!value) return undefined;
	const usage: Usage = {
		input: Math.max(0, value.inputTokens - value.cachedInputTokens - value.cacheWriteInputTokens),
		output: value.outputTokens,
		cacheRead: value.cachedInputTokens,
		cacheWrite: value.cacheWriteInputTokens,
		totalTokens: value.inputTokens + value.outputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	if (serviceTier === "priority") {
		const multiplier = model.id === "gpt-5.5" ? 2.5 : 2;
		usage.cost.input *= multiplier;
		usage.cost.output *= multiplier;
		usage.cost.cacheRead *= multiplier;
		usage.cost.cacheWrite *= multiplier;
		usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	}
	return usage;
}

function mergeLocalDetails(
	localDetails: unknown,
	remoteCompaction: JsonRecord,
): JsonRecord {
	if (isRecord(localDetails)) {
		return { ...localDetails, remoteCompaction };
	}
	return {
		...(localDetails !== undefined ? { localSummaryDetails: localDetails } : {}),
		remoteCompaction,
	};
}

export default function codexServerCompactionExtension(pi: ExtensionAPI) {
	let activeContext: ExtensionContext | undefined;
	const requestAccounts = new Map<string, string>();
	registerOpenAICodexCustomProvider(pi, {
		transformPayload(body, model, options) {
			// V2 supplies explicit history already checked against its bound auth below.
			if (options?.canonicalCompaction) return body;
			const ctx = activeContext;
			if (!ctx || options?.sessionId !== getSessionId(ctx)) {
				// Isolated Pi text-summary lanes need visible text, not opaque items.
				return stripOpaqueAccountInput(body as unknown as JsonRecord) as unknown as ResponsesBody;
			}
			const accountKey = options.apiKey ? accountFromToken(options.apiKey)?.key : undefined;
			if (!accountKey) throw new Error("Cannot identify the Codex request account.");
			const sessionId = getSessionId(ctx);
			if (requestAccounts.has(sessionId) && requestAccounts.get(sessionId) !== accountKey) {
				closeOpenAICodexWebSocketSessions(sessionId);
				requestShapeBySessionId.delete(sessionId);
			}
			requestAccounts.set(sessionId, accountKey);
			requestShapeBySessionId.set(sessionId, extractRequestShape(body as unknown as JsonRecord));
			const branchEntries = getBranchEntries(ctx);
			const remoteState = reconstructRemoteCompactionStateFromBranch({ branchEntries, model, accountKey });
			let payload = body as unknown as JsonRecord;
			if (remoteState) {
				payload = applyRemoteHistoryPayloadPatch({ payload,
					explicitHistory: normalizeResponseItemsForPrompt(remoteState.explicitHistory, model) });
			} else if (hasForeignAccountHistory(branchEntries, accountKey)) {
				payload = stripOpaqueAccountInput(payload);
			}
			if (latestHistoryAccount(branchEntries) !== accountKey) {
				// Provenance only, not account selection or credentials. Old sessions
				// still follow the global login; this prevents A -> B -> A opaque replay.
				pi.appendEntry(ACCOUNT_CONTEXT_ENTRY, { accountKey });
			}
			return payload as unknown as ResponsesBody;
		},
		getConfig: () => ({
			openai: { forceCachedWebSockets: true },
			compaction: { responsesCompaction: true },
		}),
	});

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		requestAccounts.clear();
		const sessionId = getSessionId(ctx);
		requestShapeBySessionId.delete(sessionId);
		closeOpenAICodexWebSocketSessions(sessionId);
	});

	pi.on("session_tree", (_event, ctx) => {
		activeContext = ctx;
		requestAccounts.clear();
		const sessionId = getSessionId(ctx);
		requestShapeBySessionId.delete(sessionId);
		closeOpenAICodexWebSocketSessions(sessionId);
	});
	pi.on("model_select", (_event, ctx) => {
		activeContext = ctx;
		requestAccounts.clear();
		const sessionId = getSessionId(ctx);
		requestShapeBySessionId.delete(sessionId);
		closeOpenAICodexWebSocketSessions(sessionId);
	});

	pi.on("session_shutdown", () => {
		activeContext = undefined;
		requestAccounts.clear();
		requestShapeBySessionId.clear();
		closeOpenAICodexWebSocketSessions();
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (!model || !isOpenAICodexResponsesModel(model)) return undefined;

		const resolvedAuth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!resolvedAuth.ok || !resolvedAuth.apiKey) return undefined;
		const auth: ResolvedAuth = {
			apiKey: resolvedAuth.apiKey,
			headers: resolvedAuth.headers,
			baseUrl: resolvedAuth.baseUrl,
			env: resolvedAuth.env,
		};

		const accountKey = accountFromToken(auth.apiKey)?.key;
		if (!accountKey) return undefined;
		const sessionId = getSessionId(ctx);
		const branchEntries = event.branchEntries as BranchEntry[];
		if (latestHistoryAccount(branchEntries) !== accountKey
			|| (requestAccounts.has(sessionId) && requestAccounts.get(sessionId) !== accountKey)) {
			closeOpenAICodexWebSocketSessions(sessionId);
			requestShapeBySessionId.delete(sessionId);
		}
		requestAccounts.set(sessionId, accountKey);
		const remoteState = reconstructRemoteCompactionStateFromBranch({
			branchEntries,
			model,
			accountKey,
		});
		const observedShape = requestShapeBySessionId.get(sessionId);
		let responseItems = remoteState
			? remoteState.explicitHistory
			: messagesToResponseItems(getPiContextMessages(ctx), model);
		if (!remoteState && hasForeignAccountHistory(branchEntries, accountKey)) {
			responseItems = stripOpaqueAccountInput({ input: responseItems }).input as typeof responseItems;
		}
		const promptResponseItems = normalizeResponseItemsForPrompt(
			responseItems,
			model,
		);
		const thinkingLevel =
			pi.getThinkingLevel() ?? getBranchThinkingLevel(branchEntries);
		const reasoning =
			observedShape?.reasoning ??
			thinkingLevelToResponsesReasoning(model, thinkingLevel);
		const serviceTier = resolveServiceTier(branchEntries, observedShape);

		const localPromise = compact(
			event.preparation,
			model,
			auth.apiKey,
			// Pi 0.84.3 preserves null header-deletion markers, while compact()
			// still exposes its older string-only declaration.
			auth.headers as Record<string, string> | undefined,
			event.customInstructions,
			event.signal,
			thinkingLevel,
			undefined,
			auth.env,
			undefined,
			undefined,
			`${sessionId}:pi-summary:${randomUUID()}`,
		);
		const canonicalInput = canonicalCompactionPromptInput(
			sessionId,
			model.id,
			{
				url: resolveCodexWebSocketUrl(auth.baseUrl ?? model.baseUrl),
				accountId: extractAccountId(auth.apiKey),
			},
			promptResponseItems,
		);
		const remotePromise = executeRemoteCompactionV2({
			runtime: {
				provider: model.provider,
				api: model.api,
				apiFamily: model.api,
				codexTransport: true,
				model: model.id,
				baseUrl: auth.baseUrl ?? model.baseUrl,
				apiKey: auth.apiKey,
				headers: auth.headers,
				currentModel: model,
			},
			modelRegistry: ctx.modelRegistry,
			context: {
				systemPrompt: ctx.getSystemPrompt(),
				messages: [],
				tools: pi.getAllTools().filter((tool) => pi.getActiveTools().includes(tool.name)) as never,
			},
			promptInput: (canonicalInput ?? promptResponseItems) as never,
			promptInputSource: canonicalInput ? "canonical" : "reconstructed",
			compactionDiagnostic: {
				inputSource: canonicalInput ? "canonical" : "reconstructed",
				canonicalReplay: canonicalInput ? "validated" : "no_state",
				checkpointReused: Boolean(remoteState),
			},
			requestOptions: {
				parallel_tool_calls: observedShape?.parallelToolCalls ?? true,
				prompt_cache_key: sessionId,
				...(reasoning ? { reasoning } : {}),
				...(observedShape?.text ? { text: observedShape.text as { verbosity: string } } : {}),
				...(serviceTier ? { service_tier: serviceTier } : {}),
			},
			tokensBefore: event.preparation.tokensBefore,
			sessionId,
			signal: event.signal,
		}).then((result) => {
			if (!result.ok) throw new Error(result.errorMessage);
			const usage = toRemoteUsage(model, result.usage, serviceTier);
			return {
				output: buildRemoteCompactionV2History(promptResponseItems, result.compaction as never),
				usage,
			};
		});

		const [localResult, remoteResult] = await Promise.allSettled([
			localPromise,
			remotePromise,
		]);

		if (remoteResult.status !== "fulfilled") {
			return localResult.status === "fulfilled"
				? { compaction: localResult.value }
				: undefined;
		}

		const remoteDetails = buildRemoteCompactionDetails(
			model,
			remoteResult.value.output,
			remoteResult.value.usage,
			accountKey,
		);
		const localSummary =
			localResult.status === "fulfilled"
				? localResult.value
				: {
						summary: buildCompactionSummaryText(model),
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					};

		return {
			compaction: {
				summary: localSummary.summary,
				firstKeptEntryId: localSummary.firstKeptEntryId,
				tokensBefore: localSummary.tokensBefore,
				usage: combineUsage(
					localSummary.usage,
					remoteResult.value.usage,
				),
				details: mergeLocalDetails(
					localSummary.details,
					remoteDetails as unknown as JsonRecord,
				),
			},
		};
	});
}
