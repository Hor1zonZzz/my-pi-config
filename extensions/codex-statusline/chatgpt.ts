import { createHash } from "node:crypto";

export const PROVIDER = "openai";
export const API_BASE_URL = "https://api.openai.com/v1";
export const ME_URL = "https://api.openai.com/v1/me";
export const LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";

export interface ChatGPTIdentity {
	key: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function sanitizeLabel(value: string): string {
	return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim().slice(0, 160);
}

/** Mirrors Pi's own check: a non-`sk-` credential sent directly to OpenAI is a Sign in with ChatGPT token. */
export function isChatGPTSignIn(baseUrl: string, apiKey: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.origin === "https://api.openai.com" && /^\/v1\/?$/.test(url.pathname)
			&& !url.username && !url.password && !url.search && !url.hash && !apiKey.startsWith("sk-");
	} catch {
		return false;
	}
}

/**
 * Sign in with ChatGPT access tokens are opaque apart from documented standard claims.
 * `sub` and `client_id` survive refresh, so they key the saved authorization without
 * storing the rotating token or any personal data.
 */
export function identityFromToken(token: string): ChatGPTIdentity | undefined {
	try {
		if (token.length > 64 * 1024) return undefined;
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		if (!isRecord(payload)) return undefined;
		const sub = text(payload.sub);
		const clientId = text(payload.client_id);
		if (!sub || !clientId) return undefined;
		return { key: createHash("sha256").update(JSON.stringify([ME_URL, sub, clientId])).digest("hex") };
	} catch {
		return undefined;
	}
}

/** Reads only the account email from OpenAI's account endpoint; the body is bounded and never logged. */
export async function fetchAccountEmail(
	token: string,
	signal: AbortSignal,
	fetchFn: typeof fetch = fetch,
): Promise<string | undefined> {
	const response = await fetchFn(ME_URL, {
		method: "GET",
		redirect: "error",
		headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "pi-codex-statusline" },
		signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
	});
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		throw new Error("OpenAI account unavailable");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 256 * 1024) throw new Error("OpenAI account response too large");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	const email = isRecord(payload) ? text(payload.email) : undefined;
	return email && sanitizeLabel(email) ? sanitizeLabel(email) : undefined;
}

/**
 * The usage-limit error carries the response body. Use its `resets_at` (Unix seconds,
 * milliseconds, or ISO time) when present; never guess a reset time.
 */
export function usageLimitFromError(message: string, now = Date.now()): { resetAt?: number } | undefined {
	if (!message.includes(LIMIT_CODE)) return undefined;
	const match = /["']?resets_at["']?\s*[:=]\s*"?([0-9]{9,13}(?:\.[0-9]+)?|\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)/.exec(message);
	if (!match) return {};
	const raw = match[1];
	const numeric = Number(raw);
	const resetAt = /^\d/.test(raw) && !raw.includes("-")
		? (numeric < 1e12 ? numeric * 1000 : numeric)
		: Date.parse(raw);
	return Number.isFinite(resetAt) && resetAt > now ? { resetAt: Math.round(resetAt) } : {};
}

export function formatReset(resetAt: number, now = Date.now()): string {
	const date = new Date(resetAt);
	const pad = (value: number) => String(value).padStart(2, "0");
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return resetAt - now < 24 * 60 * 60 * 1000 ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}
