// Adapted from pi-openai-server-compaction by Alexis Gallagher (MIT).
// This local variant intentionally supports only OpenAI Codex Responses.
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, ProviderHeaders } from "@earendil-works/pi-ai";
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
	buildToolsPayload,
	callRemoteCompactionEndpoint,
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
	tools?: JsonRecord[];
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
		...(Array.isArray(payload.tools)
			? { tools: payload.tools.filter(isRecord) }
			: {}),
		...(typeof payload.parallel_tool_calls === "boolean"
			? { parallelToolCalls: payload.parallel_tool_calls }
			: {}),
	};
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
	pi.on("session_start", (_event, ctx) => {
		requestShapeBySessionId.delete(getSessionId(ctx));
	});

	pi.on("session_tree", (_event, ctx) => {
		requestShapeBySessionId.delete(getSessionId(ctx));
	});
	pi.on("model_select", (_event, ctx) => {
		requestShapeBySessionId.delete(getSessionId(ctx));
	});

	pi.on("session_shutdown", () => {
		requestShapeBySessionId.clear();
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

		const sessionId = getSessionId(ctx);
		const branchEntries = event.branchEntries as BranchEntry[];
		const remoteState = reconstructRemoteCompactionStateFromBranch({
			branchEntries,
			model,
		});
		const observedShape = requestShapeBySessionId.get(sessionId);
		const responseItems = remoteState
			? remoteState.explicitHistory
			: messagesToResponseItems(getPiContextMessages(ctx), model);
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
		const tools =
			observedShape?.tools ??
			buildToolsPayload(pi.getAllTools(), pi.getActiveTools());

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
			sessionId,
		);
		const remotePromise = callRemoteCompactionEndpoint({
			model,
			resolvedBaseUrl: auth.baseUrl,
			apiKey: auth.apiKey,
			headers: auth.headers,
			sessionId,
			input: promptResponseItems,
			instructions: ctx.getSystemPrompt(),
			tools,
			parallelToolCalls: observedShape?.parallelToolCalls ?? true,
			reasoning,
			text: observedShape?.text,
			serviceTier,
			signal: event.signal,
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

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (
			!model ||
			!isOpenAICodexResponsesModel(model) ||
			!isRecord(event.payload)
		) {
			return undefined;
		}
		const sessionId = getSessionId(ctx);
		requestShapeBySessionId.set(sessionId, extractRequestShape(event.payload));
		// Pi already keeps the session branch in memory. Reconstruct on demand so
		// every entry type participates without a second history cache.
		const remoteState = reconstructRemoteCompactionStateFromBranch({
			branchEntries: getBranchEntries(ctx),
			model,
		});
		if (!remoteState) return undefined;
		// Always provide the exact explicit artifact history here. Pi's cached
		// WebSocket transport runs after this hook and converts a matching prefix
		// into previous_response_id + delta when its live continuation is valid.
		return applyRemoteHistoryPayloadPatch({
			payload: event.payload,
			explicitHistory: normalizeResponseItemsForPrompt(
				remoteState.explicitHistory,
				model,
			),
		});
	});
}
