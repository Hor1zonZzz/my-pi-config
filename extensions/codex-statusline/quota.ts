import { createHash } from "node:crypto";

const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";
const WEEK_SECONDS = 7 * 24 * 60 * 60;
export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export interface Account {
	key: string;
	accountId: string;
	userId?: string;
	label: string;
}

export interface WeeklyQuota {
	remainingPercent: number;
	resetAt?: number; // Unix milliseconds, not a locally inferred reset time.
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Decode only the resolved request token; never read Codex CLI's auth store. */
export function accountFromToken(token: string): Account | undefined {
	try {
		if (token.length > 64 * 1024) return undefined;
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		if (!isRecord(payload) || !isRecord(payload[AUTH_CLAIM])) return undefined;
		const auth = payload[AUTH_CLAIM];
		const accountId = text(auth.chatgpt_account_id);
		if (!accountId) return undefined;
		const userId = text(auth.chatgpt_user_id) ?? text(auth.user_id);
		const profile = payload[PROFILE_CLAIM];
		const email = text(payload.email) ?? (isRecord(profile) ? text(profile.email) : undefined);
		// Different users in one workspace can have different quotas. Token refresh
		// must not change the key; email and credentials never enter the cache file.
		// JWT sub is only a cache discriminator, not necessarily the API's user_id.
		const identity = userId ?? text(payload.sub) ?? email ?? null;
		const key = createHash("sha256").update(JSON.stringify([USAGE_URL, accountId, identity])).digest("hex");
		const label = (email ?? `acct-${accountId.slice(-8)}`)
			.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 160);
		return { key, accountId, userId, label };
	} catch {
		return undefined;
	}
}

/** Do not forward a proxy/custom-provider credential to ChatGPT. */
export function isSupportedCodexEndpoint(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.origin === "https://chatgpt.com" && !url.username && !url.password && !url.search && !url.hash
			&& /^\/backend-api(?:\/codex(?:\/responses)?)?\/?$/.test(url.pathname);
	} catch {
		return false;
	}
}

export function parseWeeklyQuota(payload: unknown): WeeklyQuota | undefined {
	if (!isRecord(payload)) throw new Error("Invalid Codex usage response");
	const limits = payload.rate_limit;
	if (!isRecord(limits)) return undefined;
	const primary = isRecord(limits.primary_window) ? limits.primary_window : undefined;
	const secondary = isRecord(limits.secondary_window) ? limits.secondary_window : undefined;
	const isWeekly = (window: Record<string, unknown> | undefined) => {
		const seconds = window?.limit_window_seconds;
		return typeof seconds === "number" && Number.isFinite(seconds)
			&& seconds >= WEEK_SECONDS * 0.95 && seconds <= WEEK_SECONDS * 1.05;
	};
	// Match the CLI's window-duration lookup. Its secondary fallback is useful
	// when duration is absent, but never label an explicitly non-weekly limit weekly.
	const window = [primary, secondary].find(isWeekly)
		?? (secondary?.limit_window_seconds == null ? secondary : undefined);
	if (!window) return undefined;
	const used = window.used_percent;
	if (typeof used !== "number" || !Number.isFinite(used)) throw new Error("Invalid Codex weekly usage");
	const resetAt = typeof window.reset_at === "number" && Number.isFinite(window.reset_at) && window.reset_at > 0
		? window.reset_at * 1000 : undefined;
	return { remainingPercent: Math.round(Math.max(0, Math.min(100, 100 - used))), resetAt };
}

export async function fetchWeeklyQuota(
	account: Account,
	token: string,
	signal: AbortSignal,
	fetchFn: typeof fetch = fetch,
): Promise<WeeklyQuota | undefined> {
	const response = await fetchFn(USAGE_URL, {
		method: "GET",
		redirect: "error",
		headers: {
			authorization: `Bearer ${token}`,
			"chatgpt-account-id": account.accountId,
			accept: "application/json",
			"user-agent": "pi-codex-statusline",
		},
		signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
	});
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		throw new Error("Codex usage unavailable");
	}
	// Keep unexpected backend/proxy responses bounded, and never log their body.
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 64 * 1024) throw new Error("Codex usage response too large");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (isRecord(payload)) {
		if ((text(payload.account_id) && payload.account_id !== account.accountId)
			|| (account.userId && text(payload.user_id) && payload.user_id !== account.userId)) {
			throw new Error("Codex usage account mismatch");
		}
	}
	return parseWeeklyQuota(payload);
}
