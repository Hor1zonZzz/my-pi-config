import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { extractAccountId, buildWebSocketHeaders, PI_CODEX_CONVERSION_ORIGINATOR, resolveCodexRequestRouting, resolveCodexWebSocketUrl } from "./openai-codex/headers.ts";
import { noThrowCodexDiagnosticsSink } from "./openai-codex/diagnostic-failure.ts";
import { buildRequestBody } from "./openai-codex/request-body.ts";
import type { CodexDiagnosticsSink, CodexPrewarmDiagnostics, CodexPrewarmResult, OpenAICodexStreamOptions, ResponsesBody } from "./openai-codex/types.ts";
import { closeOpenAICodexWebSocketSessions, recordWebSocketSseFallback } from "./openai-codex/websocket.ts";
import { isWebSocketMessageTooBigError, isWebSocketUpgradeRequiredError } from "./openai-codex/websocket-connection.ts";
import { codexCacheKeepaliveSocketSessionId, prewarmWebSocket } from "./openai-codex/websocket-stream.ts";
import { type CodexTurnState, withCodexTurnState } from "./openai-codex/turn-state.ts";
import { withRemoteCompactionV2Feature } from "./openai-responses/compaction-v2-feature.ts";
import { normalizeResponsesToolHistory } from "./openai-responses/tool-history.ts";
import {
	createCodexTransportStream,
	getEffectiveCodexTransport,
	type CodexProviderRuntimeConfig,
} from "./openai-codex/transport-recovery.ts";

export { buildRequestBody } from "./openai-codex/request-body.ts";
export { parseSSE } from "./openai-codex/sse.ts";
export { buildCachedWebSocketRequestBody } from "./openai-codex/websocket-continuation.ts";
export { closeOpenAICodexWebSocketSessions };
export type { ResponsesBody } from "./openai-codex/types.ts";

export function closeOpenAICodexKeepaliveWebSocketSession(sessionId: string): void {
	closeOpenAICodexWebSocketSessions(codexCacheKeepaliveSocketSessionId(sessionId));
}

async function prepareCodexRequestBody<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: OpenAICodexStreamOptions | undefined,
): Promise<ResponsesBody> {
	let body = buildRequestBody(model, context, options);
	const nextBody = await options?.onPayload?.(body, model);
	if (nextBody !== undefined) body = nextBody as ResponsesBody;
	if (!body.previous_response_id) {
		const input = normalizeResponsesToolHistory(body.input ?? []);
		if (input !== body.input) body = { ...body, input };
	}
	return body;
}

export async function prewarmOpenAICodexWebSocket<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: OpenAICodexStreamOptions,
	deps: {
		getConfig?: () => CodexProviderRuntimeConfig | undefined;
		turnState?: CodexTurnState | undefined;
		getDiagnostics?: (() => CodexDiagnosticsSink | undefined) | undefined;
		preserveContinuation?: boolean | undefined;
		retainSocket?: boolean | undefined;
		generate?: boolean | undefined;
		prewarmDiagnostics?: CodexPrewarmDiagnostics | undefined;
	},
): Promise<CodexPrewarmResult | undefined> {
	const runtimeConfig = deps.getConfig?.();
	if (getEffectiveCodexTransport(options.transport, runtimeConfig?.openai, options.sessionId) === "sse") return;
	if (!options.apiKey || !options.sessionId) return;
	const effectiveOptions = runtimeConfig?.compaction?.responsesCompaction
		? { ...options, headers: withRemoteCompactionV2Feature(options.headers) }
		: options;
	const body = await prepareCodexRequestBody(model, context, effectiveOptions);
	const accountId = extractAccountId(options.apiKey);
	const routing = resolveCodexRequestRouting({
		model: body.model,
		fast: runtimeConfig?.openai?.fast === true,
		serviceTier: body.service_tier,
		normalOriginator: runtimeConfig?.openai?.harnessIdentifierHeader ? PI_CODEX_CONVERSION_ORIGINATOR : "pi",
	});
	const headers = buildWebSocketHeaders(model.headers, effectiveOptions.headers, accountId, options.apiKey, options.sessionId, routing.originator, routing.routingHint);
	const turnState = deps.preserveContinuation ? undefined : deps.turnState;
	const websocketBody = withCodexTurnState(body, turnState);
	const diagnostics = noThrowCodexDiagnosticsSink(deps.getDiagnostics?.());
	try {
		return await prewarmWebSocket(
			resolveCodexWebSocketUrl(model.baseUrl),
			websocketBody,
			headers,
			accountId,
			effectiveOptions,
			turnState,
			diagnostics,
			deps.preserveContinuation,
			deps.prewarmDiagnostics,
			deps.generate,
			deps.retainSocket,
		);
	} catch (error) {
		if (!options.signal?.aborted && (isWebSocketUpgradeRequiredError(error) || isWebSocketMessageTooBigError(error))) {
			recordWebSocketSseFallback(options.sessionId);
			return;
		}
		throw error;
	}
}

export function registerOpenAICodexCustomProvider(pi: ExtensionAPI, options: {
	getConfig?: () => CodexProviderRuntimeConfig | undefined;
	turnState?: CodexTurnState | undefined;
	onPreparedPayload?: ((payload: ResponsesBody) => void) | undefined;
	getDiagnostics?: (() => CodexDiagnosticsSink | undefined) | undefined;
}): void {
	pi.registerProvider("openai-codex", {
		api: "openai-codex-responses",
		streamSimple: (model, context, streamOptions) => createCodexTransportStream(model, context, streamOptions, {
			prepareRequestBody: prepareCodexRequestBody,
			...(options.getConfig ? { getConfig: options.getConfig } : {}),
			...(options.turnState ? { turnState: options.turnState } : {}),
			...(options.onPreparedPayload ? { onPreparedPayload: options.onPreparedPayload } : {}),
			...(options.getDiagnostics ? { getDiagnostics: options.getDiagnostics } : {}),
		}),
	});
}
