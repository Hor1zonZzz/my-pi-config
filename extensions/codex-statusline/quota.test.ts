import assert from "node:assert/strict";
import test from "node:test";
import { accountFromToken, fetchWeeklyQuota, isSupportedCodexEndpoint, parseWeeklyQuota, USAGE_URL } from "./quota.ts";

function token(auth: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
	return `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": auth, ...extra })).toString("base64url")}.signature`;
}
const auth = { chatgpt_account_id: "workspace-12345678", chatgpt_user_id: "user-1" };
const access = token(auth, { "https://api.openai.com/profile": { email: "person@example.com" } });
const window = (used: number, seconds: number) => ({ used_percent: used, limit_window_seconds: seconds, reset_at: 2_000_000_000 });

test("identity follows the resolved token, shows full email, and isolates workspace users", () => {
	const account = accountFromToken(access)!;
	assert.equal(account.label, "person@example.com");
	assert.equal(account.accountId, auth.chatgpt_account_id);
	assert.match(account.key, /^[a-f0-9]{64}$/);
	assert.equal(accountFromToken(token(auth, { exp: 100, email: "renamed@example.com" }))?.key, account.key);
	assert.notEqual(accountFromToken(token({ ...auth, chatgpt_user_id: "user-2" }))?.key, account.key);
	assert.notEqual(accountFromToken(token({ ...auth, chatgpt_account_id: "workspace-other" }))?.key, account.key);
	assert.equal(accountFromToken(token(auth))?.label, "acct-12345678");
	assert.equal(accountFromToken(token(auth, { email: "a\n\u001b@example.com" }))?.label, "a@example.com");
	for (const invalid of ["", "api-key", "x.invalid.y", token({}), "x".repeat(70_000)]) {
		assert.equal(accountFromToken(invalid), undefined);
	}
});

test("only the official Codex backend is eligible for usage queries", () => {
	for (const path of ["/backend-api", "/backend-api/", "/backend-api/codex", "/backend-api/codex/responses"]) {
		assert.equal(isSupportedCodexEndpoint(`https://chatgpt.com${path}`), true);
	}
	for (const url of ["http://chatgpt.com/backend-api", "https://proxy.test/backend-api", "https://chatgpt.com.evil.test/backend-api",
		"https://chatgpt.com/backend-api?token=x", "https://user:pass@chatgpt.com/backend-api", "https://chatgpt.com/other"]) {
		assert.equal(isSupportedCodexEndpoint(url), false);
	}
});

test("weekly selection checks duration in either window and ignores additional model limits", () => {
	const primary = window(13.4, 7 * 86400);
	const secondary = window(95, 5 * 3600);
	assert.deepEqual(parseWeeklyQuota({ rate_limit: { primary_window: primary, secondary_window: secondary } }), {
		remainingPercent: 87, resetAt: 2_000_000_000_000,
	});
	assert.equal(parseWeeklyQuota({ rate_limit: { primary_window: secondary, secondary_window: primary } })?.remainingPercent, 87);
	assert.equal(parseWeeklyQuota({ rate_limit: { secondary_window: window(20, 7 * 86400 * 1.04) } })?.remainingPercent, 80);
	assert.equal(parseWeeklyQuota({ rate_limit: { secondary_window: { used_percent: 20 } } })?.remainingPercent, 80);
	assert.equal(parseWeeklyQuota({ rate_limit: { secondary_window: secondary } }), undefined);
	assert.equal(parseWeeklyQuota({ additional_rate_limits: [{ rate_limit: { secondary_window: primary } }] }), undefined);
	assert.equal(parseWeeklyQuota({ rate_limit: null }), undefined);
	assert.equal(parseWeeklyQuota({ rate_limit: { secondary_window: { used_percent: 101 } } })?.remainingPercent, 0);
	assert.equal(parseWeeklyQuota({ rate_limit: { secondary_window: { used_percent: -1 } } })?.remainingPercent, 100);
	assert.throws(() => parseWeeklyQuota({ rate_limit: { secondary_window: { used_percent: "20" } } }));
	assert.throws(() => parseWeeklyQuota(null));
});

test("usage GET carries current account auth and validates response identity", async () => {
	const account = accountFromToken(access)!;
	const signal = new AbortController().signal;
	const mockFetch: typeof fetch = async (input, options) => {
		assert.equal(input, USAGE_URL);
		assert.equal(options?.method, "GET");
		assert.equal(options?.redirect, "error");
		assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${access}`);
		assert.equal(new Headers(options?.headers).get("chatgpt-account-id"), account.accountId);
		return Response.json({ account_id: account.accountId, user_id: account.userId, rate_limit: { secondary_window: window(20, 604800) } });
	};
	assert.equal((await fetchWeeklyQuota(account, access, signal, mockFetch))?.remainingPercent, 80);
	await assert.rejects(fetchWeeklyQuota(account, access, signal, async () => Response.json({ account_id: "other" })), /mismatch/);
	await assert.rejects(fetchWeeklyQuota(account, access, signal, async () => Response.json({ user_id: "other" })), /mismatch/);
});

test("HTTP, oversized, and malformed responses fail without exposing backend bodies", async () => {
	const account = accountFromToken(access)!;
	const signal = new AbortController().signal;
	for (const status of [401, 403, 429, 500]) {
		await assert.rejects(fetchWeeklyQuota(account, access, signal, async () => new Response("secret body", { status })), /Codex usage unavailable/);
	}
	await assert.rejects(fetchWeeklyQuota(account, access, signal, async () => new Response("x".repeat(65537))), /too large/);
	await assert.rejects(fetchWeeklyQuota(account, access, signal, async () => new Response("not json")));
});
