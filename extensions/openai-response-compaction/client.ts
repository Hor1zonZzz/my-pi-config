import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import type { NativeCompactionRequest } from "./serializer.ts";
import {
	OPENAI_CODEX_COMPACT_URL,
	type NativeCompactionRuntime,
} from "./runtime.ts";
import { cloneStructuredValue, isValidNativeCompactedOutput } from "./types.ts";

const MAX_COMPACT_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

type CompactResponse = {
	id?: string;
	created_at?: number | string;
	output: unknown[];
	usage?: unknown;
};

export type NativeCompactionSuccess = {
	ok: true;
	compactedWindow: Record<string, unknown>[];
	responseId?: string;
	createdAt: string;
	usage?: Usage;
};

export type NativeCompactionFailure = {
	ok: false;
	reason:
		| "aborted"
		| "invalid-authentication"
		| "network-error"
		| "http-error"
		| "empty-response"
		| "response-too-large"
		| "invalid-json"
		| "invalid-output";
	status?: number;
	message?: string;
};

export type NativeCompactionClientResult =
	| NativeCompactionSuccess
	| NativeCompactionFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bearerToken(headers: Headers): string | undefined {
	const match = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || undefined;
}

function buildHeaders(
	runtime: NativeCompactionRuntime,
	sessionId: string,
): { headers?: Headers; error?: string } {
	const headers = new Headers(runtime.modelConfig.headers ?? {});
	for (const [name, value] of Object.entries(runtime.headers ?? {})) {
		headers.set(name, value);
	}
	if (runtime.apiKey) headers.set("authorization", `Bearer ${runtime.apiKey}`);
	const token = runtime.apiKey ?? bearerToken(headers);
	if (!token) return { error: "Codex OAuth token is unavailable" };
	headers.set("accept", "application/json");
	headers.set("content-type", "application/json");
	headers.set("authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", runtime.accountId);
	headers.set("originator", "pi");
	headers.set("user-agent", `pi (${process.platform}; ${process.arch})`);
	headers.set("openai-beta", "responses=experimental");
	headers.set("session-id", sessionId);
	headers.set("thread-id", sessionId);
	headers.set("x-client-request-id", sessionId);
	return { headers };
}

function isoDate(value: number): string | undefined {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeCreatedAt(value: unknown): string {
	if (typeof value === "number" && Number.isFinite(value)) {
		const milliseconds = value > 1_000_000_000_000 ? value : value * 1_000;
		const normalized = isoDate(milliseconds);
		if (normalized) return normalized;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed))
			return isoDate(parsed) ?? new Date().toISOString();
	}
	return new Date().toISOString();
}

function compactedWindow(
	output: readonly unknown[],
): Record<string, unknown>[] | undefined {
	const items: Record<string, unknown>[] = [];
	for (const item of output) {
		if (!isRecord(item)) return undefined;
		try {
			items.push(cloneStructuredValue(item) as Record<string, unknown>);
		} catch {
			return undefined;
		}
	}
	return items;
}

function numeric(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: 0;
}

function parseUsage(
	value: unknown,
	runtime: NativeCompactionRuntime,
	priority: boolean,
): Usage | undefined {
	if (!isRecord(value)) return undefined;
	const inputDetails = isRecord(value.input_tokens_details)
		? value.input_tokens_details
		: undefined;
	const outputDetails = isRecord(value.output_tokens_details)
		? value.output_tokens_details
		: undefined;
	const inputTokens = numeric(value.input_tokens);
	const cacheRead = numeric(inputDetails?.cached_tokens);
	const output = numeric(value.output_tokens);
	const usage: Usage = {
		input: Math.max(0, inputTokens - cacheRead),
		output,
		cacheRead,
		cacheWrite: 0,
		reasoning: outputDetails
			? numeric(outputDetails.reasoning_tokens)
			: undefined,
		totalTokens: numeric(value.total_tokens) || inputTokens + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(runtime.modelConfig, usage);
	if (priority) {
		const multiplier = runtime.model === "gpt-5.5" ? 2.5 : 2;
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

function isAbortError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "AbortError" || error.name === "ABORT_ERR")
	);
}

function responseId(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseCompactResponse(args: {
	response: Response;
	responseText: string;
	runtime: NativeCompactionRuntime;
	priority: boolean;
}): NativeCompactionClientResult {
	if (!args.response.ok) {
		return {
			ok: false,
			reason: "http-error",
			status: args.response.status,
			message:
				args.response.statusText || "Compact endpoint rejected the request",
		};
	}
	if (!args.responseText.trim()) {
		return {
			ok: false,
			reason: "empty-response",
			status: args.response.status,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(args.responseText);
	} catch (error) {
		return {
			ok: false,
			reason: "invalid-json",
			status: args.response.status,
			message: error instanceof Error ? error.message : String(error),
		};
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.output)) {
		return {
			ok: false,
			reason: "invalid-output",
			status: args.response.status,
			message: "Response did not contain an output array",
		};
	}

	const output = compactedWindow(parsed.output);
	if (!output || !isValidNativeCompactedOutput(output)) {
		return {
			ok: false,
			reason: "invalid-output",
			status: args.response.status,
			message: "Response did not contain an encrypted compaction item",
		};
	}

	const envelope = parsed as CompactResponse;
	return {
		ok: true,
		compactedWindow: output,
		responseId: responseId(envelope.id),
		createdAt: normalizeCreatedAt(envelope.created_at),
		usage: parseUsage(envelope.usage, args.runtime, args.priority),
	};
}

async function readBoundedResponseText(
	response: Response,
	maxBytes: number,
): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		bytes += chunk.value.byteLength;
		if (bytes > maxBytes) {
			await reader.cancel();
			throw new Error("response-too-large");
		}
		text += decoder.decode(chunk.value, { stream: true });
	}
	return text + decoder.decode();
}

export async function executeNativeCompaction(args: {
	runtime: NativeCompactionRuntime;
	request: NativeCompactionRequest;
	sessionId: string;
	signal: AbortSignal;
}): Promise<NativeCompactionClientResult> {
	const builtHeaders = buildHeaders(args.runtime, args.sessionId);
	if (!builtHeaders.headers) {
		return {
			ok: false,
			reason: "invalid-authentication",
			message: builtHeaders.error,
		};
	}
	if (args.signal.aborted) return { ok: false, reason: "aborted" };

	let response: Response;
	try {
		response = await fetch(OPENAI_CODEX_COMPACT_URL, {
			method: "POST",
			headers: builtHeaders.headers,
			body: JSON.stringify(args.request),
			signal: args.signal,
		});
	} catch (error) {
		if (isAbortError(error) || args.signal.aborted) {
			return { ok: false, reason: "aborted" };
		}
		return {
			ok: false,
			reason: "network-error",
			message: error instanceof Error ? error.message : String(error),
		};
	}

	let responseText: string;
	try {
		responseText = await readBoundedResponseText(
			response,
			response.ok ? MAX_COMPACT_RESPONSE_BYTES : MAX_ERROR_RESPONSE_BYTES,
		);
	} catch (error) {
		if (isAbortError(error) || args.signal.aborted) {
			return { ok: false, reason: "aborted" };
		}
		return {
			ok: false,
			reason: "response-too-large",
			status: response.status,
			message: "Compact endpoint response exceeded the local size limit",
		};
	}
	return parseCompactResponse({
		response,
		responseText,
		runtime: args.runtime,
		priority: args.request.service_tier === "priority",
	});
}
