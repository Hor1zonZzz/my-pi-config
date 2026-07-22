import type {
	NativeCompactionRequest,
	ResponsesInputItem,
} from "./serializer.ts";

const EFFECTIVE_CONTEXT_PERCENT = 95;
export const TRUNCATED_TOOL_OUTPUT =
	"Output exceeded the native compaction context budget and was truncated";

export type ShrinkResult = {
	request: NativeCompactionRequest;
	rewrittenToolOutputs: number;
	estimatedTokensBefore: number;
	estimatedTokensAfter: number;
	budgetTokens: number;
	fitsBudget: boolean;
};

type RewriteCandidate = {
	index: number;
	estimatedTokens: number;
	replacement: ResponsesInputItem;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function estimateTokens(value: unknown): number {
	const serialized = typeof value === "string" ? value : JSON.stringify(value);
	if (!serialized) return 0;
	// UTF-8 bytes are a conservative upper bound for BPE token count,
	// including high-entropy encrypted checkpoint content.
	return new TextEncoder().encode(serialized).byteLength;
}

function rewriteCandidate(
	item: ResponsesInputItem,
	index: number,
): RewriteCandidate | undefined {
	if (item.type === "function_call_output") {
		if (item.output === TRUNCATED_TOOL_OUTPUT) return undefined;
		return {
			index,
			estimatedTokens: estimateTokens(item.output),
			replacement: { ...item, output: TRUNCATED_TOOL_OUTPUT },
		};
	}
	if (item.type === "custom_tool_call_output") {
		if (item.output === TRUNCATED_TOOL_OUTPUT) return undefined;
		return {
			index,
			estimatedTokens: estimateTokens(item.output),
			replacement: { ...item, output: TRUNCATED_TOOL_OUTPUT },
		};
	}
	if (item.type === "tool_search_output" && Array.isArray(item.tools)) {
		if (item.tools.length === 0) return undefined;
		return {
			index,
			estimatedTokens: estimateTokens(item.tools),
			replacement: { ...item, tools: [] },
		};
	}
	return undefined;
}

function collectCandidates(
	input: readonly ResponsesInputItem[],
): RewriteCandidate[] {
	const candidates: RewriteCandidate[] = [];
	for (let index = 0; index < input.length; index++) {
		const item = input[index];
		if (!item || !isRecord(item)) continue;
		const candidate = rewriteCandidate(item, index);
		if (candidate) candidates.push(candidate);
	}
	return candidates.sort(
		(left, right) => right.estimatedTokens - left.estimatedTokens,
	);
}

export function shrinkNativeCompactionRequest(
	request: NativeCompactionRequest,
	contextWindow: number,
): ShrinkResult {
	const budgetTokens = Math.floor(
		contextWindow * (EFFECTIVE_CONTEXT_PERCENT / 100),
	);
	const estimatedTokensBefore = estimateTokens(request);
	if (estimatedTokensBefore <= budgetTokens) {
		return {
			request,
			rewrittenToolOutputs: 0,
			estimatedTokensBefore,
			estimatedTokensAfter: estimatedTokensBefore,
			budgetTokens,
			fitsBudget: true,
		};
	}

	const input = [...request.input];
	let estimatedTokensAfter = estimatedTokensBefore;
	let rewrittenToolOutputs = 0;
	for (const candidate of collectCandidates(input)) {
		if (estimatedTokensAfter <= budgetTokens) break;
		const previous = input[candidate.index];
		if (!previous) continue;
		const previousTokens = estimateTokens(previous);
		const replacementTokens = estimateTokens(candidate.replacement);
		if (replacementTokens >= previousTokens) continue;
		input[candidate.index] = candidate.replacement;
		estimatedTokensAfter = estimateTokens({ ...request, input });
		rewrittenToolOutputs++;
	}

	return {
		request: rewrittenToolOutputs > 0 ? { ...request, input } : request,
		rewrittenToolOutputs,
		estimatedTokensBefore,
		estimatedTokensAfter,
		budgetTokens,
		fitsBudget: estimatedTokensAfter <= budgetTokens,
	};
}
