import assert from "node:assert/strict";
import test from "node:test";
import {
	fetchAccountEmail,
	formatReset,
	identityFromToken,
	isChatGPTSignIn,
	LIMIT_CODE,
	ME_URL,
	usageLimitFromError,
} from "./chatgpt.ts";

const jwt = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

test("recognizes only a non-sk credential sent directly to OpenAI", () => {
	assert.equal(isChatGPTSignIn("https://api.openai.com/v1", "eyJ.opaque.token"), true);
	assert.equal(isChatGPTSignIn("https://api.openai.com/v1/", "eyJ.opaque.token"), true);
	assert.equal(isChatGPTSignIn("https://api.openai.com/v1", "sk-proj-123"), false);
	assert.equal(isChatGPTSignIn("https://proxy.test/v1", "eyJ.opaque.token"), false);
	assert.equal(isChatGPTSignIn("https://api.openai.com/v1?x=1", "eyJ.opaque.token"), false);
	assert.equal(isChatGPTSignIn("not a url", "eyJ.opaque.token"), false);
});

test("identity survives token refresh and separates users and saved authorizations", () => {
	const a = identityFromToken(jwt({ sub: "user-a", client_id: "client-1", jti: "1", exp: 1 }));
	const refreshed = identityFromToken(jwt({ sub: "user-a", client_id: "client-1", jti: "2", exp: 2 }));
	assert.ok(a);
	assert.equal(a.key, refreshed?.key);
	assert.notEqual(a.key, identityFromToken(jwt({ sub: "user-b", client_id: "client-1" }))?.key);
	assert.notEqual(a.key, identityFromToken(jwt({ sub: "user-a", client_id: "client-2" }))?.key);
	assert.equal(identityFromToken(jwt({ sub: "user-a" })), undefined);
	assert.equal(identityFromToken("opaque"), undefined);
	assert.equal(identityFromToken(`h.${"x".repeat(70_000)}.s`), undefined);
});

test("account email comes from /v1/me, is sanitized, and failures never leak the body", async () => {
	let seen: { url?: unknown; init?: RequestInit } = {};
	const email = await fetchAccountEmail("tok", AbortSignal.timeout(1000), async (url, init) => {
		seen = { url, init };
		return Response.json({ id: "user-1", email: "  alice@example.com\u001b[31m ", orgs: { data: [] } });
	});
	assert.equal(email, "alice@example.com[31m");
	assert.equal(seen.url, ME_URL);
	assert.equal(new Headers(seen.init?.headers).get("authorization"), "Bearer tok");
	assert.equal(seen.init?.redirect, "error");
	assert.equal(await fetchAccountEmail("tok", AbortSignal.timeout(1000), async () => Response.json({ id: "x" })), undefined);
	await assert.rejects(
		fetchAccountEmail("tok", AbortSignal.timeout(1000), async () => new Response("secret", { status: 401 })),
		(error: Error) => !error.message.includes("secret"),
	);
	await assert.rejects(fetchAccountEmail("tok", AbortSignal.timeout(1000), async () => new Response("x".repeat(300 * 1024))),
		/too large/);
});

test("usage limit is detected only from its error code, with a reset time only when the server gives one", () => {
	const now = Date.UTC(2026, 8, 30, 12, 0, 0);
	const seconds = Math.floor(now / 1000) + 3600;
	const body = (extra: string) => `OpenAI API error (429): {"error":{"code":"${LIMIT_CODE}","message":"limit"${extra}}}`;
	assert.equal(usageLimitFromError("OpenAI API error (429): rate_limit_exceeded", now), undefined);
	assert.deepEqual(usageLimitFromError(body(""), now), {});
	assert.deepEqual(usageLimitFromError(body(`,"resets_at":${seconds}`), now), { resetAt: seconds * 1000 });
	assert.deepEqual(usageLimitFromError(body(`,"resets_at":${seconds * 1000}`), now), { resetAt: seconds * 1000 });
	assert.deepEqual(usageLimitFromError(body(`,"resets_at":"2026-09-30T13:00:00Z"`), now), { resetAt: Date.UTC(2026, 8, 30, 13) });
	// A past or unparseable reset time is dropped rather than guessed.
	assert.deepEqual(usageLimitFromError(body(`,"resets_at":${Math.floor(now / 1000) - 60}`), now), {});
});

test("reset time is short within a day and dated beyond it", () => {
	const now = new Date(2026, 8, 30, 12, 0).getTime();
	assert.equal(formatReset(new Date(2026, 8, 30, 14, 5).getTime(), now), "14:05");
	assert.equal(formatReset(new Date(2026, 9, 3, 9, 30).getTime(), now), "10-03 09:30");
});
