import type { Api, Model } from "@earendil-works/pi-ai";
import { serializeCompactionPlaceholder } from "./serializer.ts";
import type { NativeCompactionEntry } from "./types.ts";
import { cloneStructuredValue } from "./types.ts";

export type ResponsesPayload = {
	model: string;
	input: unknown[];
	instructions?: unknown;
	[key: string]: unknown;
};

export type ReplayResult =
	| { ok: true; payload: ResponsesPayload }
	| {
			ok: false;
			reason:
				| "unsupported-payload"
				| "payload-model-mismatch"
				| "placeholder-not-found"
				| "ambiguous-placeholder";
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isResponsesPayload(value: unknown): value is ResponsesPayload {
	return (
		isRecord(value) &&
		typeof value.model === "string" &&
		Array.isArray(value.input)
	);
}

function equivalent(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function matchingIndexes(
	input: readonly unknown[],
	needle: readonly unknown[],
): number[] {
	if (needle.length === 0 || needle.length > input.length) return [];
	const matches: number[] = [];
	for (let start = 0; start <= input.length - needle.length; start++) {
		const candidate = input.slice(start, start + needle.length);
		if (equivalent(candidate, needle)) matches.push(start);
	}
	return matches;
}

function cloneItems(items: readonly unknown[]): unknown[] {
	return items.map(cloneStructuredValue);
}

export function rewritePayloadWithNativeCheckpoint(args: {
	payload: unknown;
	model: Model<Api>;
	entry: NativeCompactionEntry;
}): ReplayResult {
	if (!isResponsesPayload(args.payload)) {
		return { ok: false, reason: "unsupported-payload" };
	}
	if (args.payload.model !== args.entry.details.model) {
		return { ok: false, reason: "payload-model-mismatch" };
	}
	const placeholder = serializeCompactionPlaceholder(args.model, args.entry);
	const matches = matchingIndexes(args.payload.input, placeholder);
	if (matches.length === 0) {
		return { ok: false, reason: "placeholder-not-found" };
	}
	if (matches.length > 1) {
		return { ok: false, reason: "ambiguous-placeholder" };
	}
	const start = matches[0] ?? 0;
	return {
		ok: true,
		payload: {
			...args.payload,
			input: [
				...args.payload.input.slice(0, start),
				...cloneItems(args.entry.details.compactedWindow),
				...args.payload.input.slice(start + placeholder.length),
			],
		},
	};
}

function textFromContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.map((item) =>
			isRecord(item) &&
			item.type === "input_text" &&
			typeof item.text === "string"
				? item.text
				: "",
		)
		.join("\n");
}

export function isPiCompactionSummarizationPayload(
	payload: ResponsesPayload,
): boolean {
	const instructions =
		typeof payload.instructions === "string" ? payload.instructions : "";
	if (/compact|summar/i.test(instructions)) return true;
	return payload.input.some((item) => {
		if (!isRecord(item)) return false;
		const text = textFromContent(item.content);
		return (
			(item.role === "user" &&
				/<conversation>|previous-summary|summary/i.test(text)) ||
			((item.role === "system" || item.role === "developer") &&
				/compact|summar/i.test(text))
		);
	});
}

export function injectNativeCheckpointIntoFallback(
	payload: ResponsesPayload,
	compactedWindow: readonly unknown[],
): ResponsesPayload {
	let insertAt = 0;
	for (const item of payload.input) {
		if (
			!isRecord(item) ||
			(item.role !== "system" && item.role !== "developer")
		) {
			break;
		}
		insertAt++;
	}
	return {
		...payload,
		input: [
			...payload.input.slice(0, insertAt),
			...cloneItems(compactedWindow),
			...payload.input.slice(insertAt),
		],
	};
}

export function blockedPayload(_payload: unknown): ResponsesPayload {
	return {
		model: "pi-native-compaction-request-blocked",
		input: [],
		instructions:
			"Request blocked locally because its native compaction checkpoint is incompatible.",
	};
}
