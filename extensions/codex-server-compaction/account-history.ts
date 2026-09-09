import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { extractRemoteCompactionDetails, isRecord, type JsonRecord } from "./remote-compaction.ts";

export const ACCOUNT_CONTEXT_ENTRY = "codex-account-context";
export interface AccountHistoryEntry {
	type: string;
	customType?: unknown;
	data?: unknown;
	details?: unknown;
	message?: AgentMessage;
}

export function latestHistoryAccount(entries: AccountHistoryEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && entry.customType === ACCOUNT_CONTEXT_ENTRY) {
			return isRecord(entry.data) && typeof entry.data.accountKey === "string" ? entry.data.accountKey : undefined;
		}
		if (entry.type === "compaction") return extractRemoteCompactionDetails(entry.details)?.accountKey;
	}
	return undefined;
}

/** Only reasoning from an attributable, same-account active context is reusable. */
export function hasForeignAccountHistory(entries: AccountHistoryEntry[], accountKey: string): boolean {
	const lastCompaction = entries.findLastIndex((entry) => entry.type === "compaction");
	let owner: string | undefined;
	for (const entry of entries.slice(Math.max(0, lastCompaction))) {
		if (entry.type === "compaction") {
			owner = extractRemoteCompactionDetails(entry.details)?.accountKey;
			if (owner !== accountKey) return true;
		} else if (entry.type === "custom" && entry.customType === ACCOUNT_CONTEXT_ENTRY) {
			owner = isRecord(entry.data) && typeof entry.data.accountKey === "string" ? entry.data.accountKey : undefined;
		} else if (entry.message?.role === "assistant" && entry.message.provider === "openai-codex" && owner !== accountKey) {
			return true;
		}
	}
	return false;
}

export function stripOpaqueAccountInput(payload: JsonRecord): JsonRecord {
	const next = { ...payload };
	delete next.previous_response_id;
	if (Array.isArray(payload.input)) {
		next.input = payload.input.filter((item) => !isRecord(item) || (item.type !== "reasoning" && item.type !== "compaction"));
	}
	return next;
}
