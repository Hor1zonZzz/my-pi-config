export const NATIVE_COMPACTION_STRATEGY =
	"openai-codex-responses-compact-v1" as const;

export type NativeCompactionModelIdentity = {
	provider: "openai-codex";
	api: "openai-codex-responses";
	model: string;
	baseUrl: string;
};

export type NativeCompactionIdentity = NativeCompactionModelIdentity & {
	accountIdHash: string;
};

export type NativeCompactionDetails = NativeCompactionIdentity & {
	strategy: typeof NATIVE_COMPACTION_STRATEGY;
	compactedWindow: Record<string, unknown>[];
	compactResponseId?: string;
	createdAt: string;
	requestMeta: {
		reason: "manual" | "threshold" | "overflow";
		tokensBefore: number;
		firstKeptEntryId: string;
		previousNativeCheckpoint: boolean;
		rewrittenToolOutputs: number;
		fallbackMode?: "pi-summary";
	};
};

export type NativeCompactionEntry = {
	type: "compaction";
	id: string;
	parentId: string | null;
	timestamp: string;
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details: NativeCompactionDetails;
};

type CompactionEntryLike = Omit<NativeCompactionEntry, "details"> & {
	details?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

const MAX_STRUCTURED_DEPTH = 32;
const MAX_COMPACTED_WINDOW_ITEMS = 10_000;
export const MAX_COMPACTED_WINDOW_BYTES = 16 * 1024 * 1024;
// The stock Codex endpoint currently returns `compaction_summary`, while the
// public Responses compact contract uses `compaction`.
const COMPACTION_ITEM_TYPES = new Set(["compaction", "compaction_summary"]);
function isStructuredValue(value: unknown, depth = 0): boolean {
	if (depth > MAX_STRUCTURED_DEPTH) return false;
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.every((nested) => isStructuredValue(nested, depth + 1));
	}
	return (
		isRecord(value) &&
		Object.values(value).every((nested) => isStructuredValue(nested, depth + 1))
	);
}

export function cloneStructuredValue(value: unknown, depth = 0): unknown {
	if (depth > MAX_STRUCTURED_DEPTH) {
		throw new Error("Compacted value exceeds the maximum nesting depth");
	}
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((nested) => cloneStructuredValue(nested, depth + 1));
	}
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, nested]) => [
				key,
				cloneStructuredValue(nested, depth + 1),
			]),
		);
	}
	throw new Error(`Unsupported compacted value: ${typeof value}`);
}

function isNativeRequestMeta(
	value: unknown,
): value is NativeCompactionDetails["requestMeta"] {
	if (!isRecord(value)) return false;
	const validReason =
		value.reason === "manual" ||
		value.reason === "threshold" ||
		value.reason === "overflow";
	const validTokens =
		typeof value.tokensBefore === "number" &&
		Number.isFinite(value.tokensBefore) &&
		value.tokensBefore >= 0;
	const validRewriteCount =
		typeof value.rewrittenToolOutputs === "number" &&
		Number.isInteger(value.rewrittenToolOutputs) &&
		value.rewrittenToolOutputs >= 0;
	const validFallback =
		value.fallbackMode === undefined || value.fallbackMode === "pi-summary";
	return (
		validReason &&
		validTokens &&
		validRewriteCount &&
		validFallback &&
		isNonEmptyString(value.firstKeptEntryId) &&
		typeof value.previousNativeCheckpoint === "boolean"
	);
}

function hasNativeIdentity(value: Record<string, unknown>): boolean {
	return (
		value.provider === "openai-codex" &&
		value.api === "openai-codex-responses" &&
		isNonEmptyString(value.model) &&
		isNonEmptyString(value.baseUrl) &&
		isNonEmptyString(value.createdAt) &&
		typeof value.accountIdHash === "string" &&
		/^[a-f0-9]{64}$/.test(value.accountIdHash)
	);
}

function isInputContentPart(value: unknown): boolean {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "input_text") return typeof value.text === "string";
	if (value.type === "input_image") {
		return (
			typeof value.image_url === "string" || typeof value.file_id === "string"
		);
	}
	if (value.type === "input_file") {
		return (
			typeof value.file_id === "string" ||
			typeof value.file_data === "string" ||
			typeof value.file_url === "string"
		);
	}
	return false;
}

function hasUserMessageContent(item: Record<string, unknown>): boolean {
	return (
		typeof item.content === "string" ||
		(Array.isArray(item.content) &&
			item.content.length > 0 &&
			item.content.every(isInputContentPart))
	);
}

function isUserReplayItem(item: Record<string, unknown>): boolean {
	return (
		(item.type === undefined || item.type === "message") &&
		item.role === "user" &&
		hasUserMessageContent(item)
	);
}

function isAllowedReplayItem(item: unknown): item is Record<string, unknown> {
	if (!isRecord(item) || !isStructuredValue(item)) return false;
	return isEncryptedCompactionItem(item) || isUserReplayItem(item);
}

function isEncryptedCompactionItem(item: Record<string, unknown>): boolean {
	return (
		typeof item.type === "string" &&
		COMPACTION_ITEM_TYPES.has(item.type) &&
		typeof item.encrypted_content === "string" &&
		item.encrypted_content.trim().length > 0
	);
}

export function isValidCompactedWindow(
	value: unknown,
): value is Record<string, unknown>[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.length > MAX_COMPACTED_WINDOW_ITEMS ||
		!value.every(isAllowedReplayItem) ||
		value.filter(
			(item): item is Record<string, unknown> =>
				isRecord(item) && isEncryptedCompactionItem(item),
		).length !== 1
	) {
		return false;
	}
	try {
		const serialized = JSON.stringify(value);
		return (
			new TextEncoder().encode(serialized).byteLength <=
			MAX_COMPACTED_WINDOW_BYTES
		);
	} catch {
		return false;
	}
}

export function isValidNativeCompactedOutput(
	value: unknown,
): value is Record<string, unknown>[] {
	if (!isValidCompactedWindow(value)) return false;
	const [last] = value.slice(-1);
	return isEncryptedCompactionItem(last) && isNonEmptyString(last.id);
}

function hasValidCompactedWindow(value: Record<string, unknown>): boolean {
	return isValidCompactedWindow(value.compactedWindow);
}

export function isNativeCompactionDetails(
	value: unknown,
): value is NativeCompactionDetails {
	if (!isRecord(value) || value.strategy !== NATIVE_COMPACTION_STRATEGY) {
		return false;
	}
	const validResponseId =
		value.compactResponseId === undefined ||
		isNonEmptyString(value.compactResponseId);
	return (
		hasNativeIdentity(value) &&
		hasValidCompactedWindow(value) &&
		validResponseId &&
		isNativeRequestMeta(value.requestMeta)
	);
}

function isCompactionEntryLike(entry: unknown): entry is CompactionEntryLike {
	return (
		isRecord(entry) &&
		entry.type === "compaction" &&
		isNonEmptyString(entry.id) &&
		isNonEmptyString(entry.timestamp) &&
		isNonEmptyString(entry.summary) &&
		isNonEmptyString(entry.firstKeptEntryId) &&
		typeof entry.tokensBefore === "number"
	);
}

export function isNativeCompactionEntry(
	entry: unknown,
): entry is NativeCompactionEntry {
	return (
		isCompactionEntryLike(entry) && isNativeCompactionDetails(entry.details)
	);
}

export function findLatestCompactionEntry(
	entries: readonly unknown[],
): CompactionEntryLike | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (isCompactionEntryLike(entry)) return entry;
	}
	return undefined;
}

export type LatestNativeCheckpointState =
	| { kind: "none" }
	| { kind: "invalid" }
	| { kind: "valid"; entry: NativeCompactionEntry };

export function findLatestNativeCheckpointState(
	entries: readonly unknown[],
): LatestNativeCheckpointState {
	let latest: unknown;
	for (let index = entries.length - 1; index >= 0; index--) {
		const candidate = entries[index];
		if (isRecord(candidate) && candidate.type === "compaction") {
			latest = candidate;
			break;
		}
	}
	if (!isRecord(latest) || !isRecord(latest.details)) return { kind: "none" };
	if (latest.details.strategy !== NATIVE_COMPACTION_STRATEGY) {
		return { kind: "none" };
	}
	return isNativeCompactionEntry(latest)
		? { kind: "valid", entry: latest }
		: { kind: "invalid" };
}

export function findLatestNativeCompactionEntry(
	entries: readonly unknown[],
): NativeCompactionEntry | undefined {
	const state = findLatestNativeCheckpointState(entries);
	return state.kind === "valid" ? state.entry : undefined;
}

export function createCheckpointSummary(
	identity: NativeCompactionIdentity,
	tokensBefore: number,
	createdAt: string,
): string {
	return [
		"[OpenAI native compaction checkpoint]",
		`Model: ${identity.provider}/${identity.model}`,
		`Context before compaction: ${tokensBefore} tokens`,
		`Created: ${createdAt}`,
	].join("\n");
}
