import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	NativeCompactionIdentity,
	NativeCompactionModelIdentity,
} from "./types.ts";

export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const OPENAI_CODEX_COMPACT_URL =
	"https://chatgpt.com/backend-api/codex/responses/compact";

export type NativeCompactionRuntime = NativeCompactionIdentity & {
	modelConfig: Model<Api>;
	accountId: string;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
};

export type RuntimeResolution =
	| { ok: true; runtime: NativeCompactionRuntime }
	| {
			ok: false;
			reason: "unsupported-model" | "missing-authentication";
	  };

export function normalizeBaseUrl(
	value: string | undefined,
): string | undefined {
	const normalized = value?.trim().replace(/\/+$/, "");
	return normalized || undefined;
}

function authorizationToken(
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
): string | undefined {
	if (apiKey) return apiKey;
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (name.toLowerCase() !== "authorization") continue;
		const match = value.match(/^Bearer\s+(.+)$/i);
		if (match?.[1]?.trim()) return match[1].trim();
	}
	return undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const parsed = JSON.parse(
			Buffer.from(parts[1] ?? "", "base64url").toString("utf8"),
		) as unknown;
		return parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function resolveAccountId(token: string): string | undefined {
	const claims = decodeJwtPayload(token)?.["https://api.openai.com/auth"];
	if (claims === null || typeof claims !== "object" || Array.isArray(claims)) {
		return undefined;
	}
	const accountId = (claims as Record<string, unknown>).chatgpt_account_id;
	return typeof accountId === "string" && accountId.trim()
		? accountId.trim()
		: undefined;
}

function accountIdHash(accountId: string): string {
	return createHash("sha256").update(accountId, "utf8").digest("hex");
}

export function currentModelIdentity(
	ctx: ExtensionContext,
): NativeCompactionModelIdentity | undefined {
	const model = ctx.model;
	const baseUrl = normalizeBaseUrl(model?.baseUrl);
	if (
		model?.provider !== "openai-codex" ||
		model.api !== "openai-codex-responses" ||
		baseUrl !== OPENAI_CODEX_BASE_URL
	) {
		return undefined;
	}
	return {
		provider: "openai-codex",
		api: "openai-codex-responses",
		model: model.id,
		baseUrl,
	};
}

export function identitiesMatch(
	left: NativeCompactionIdentity,
	right: NativeCompactionIdentity,
): boolean {
	return (
		left.provider === right.provider &&
		left.api === right.api &&
		left.model === right.model &&
		left.accountIdHash === right.accountIdHash &&
		normalizeBaseUrl(left.baseUrl) === normalizeBaseUrl(right.baseUrl)
	);
}

export async function resolveRuntime(
	ctx: ExtensionContext,
): Promise<RuntimeResolution> {
	const modelIdentity = currentModelIdentity(ctx);
	if (!modelIdentity || !ctx.model) {
		return { ok: false, reason: "unsupported-model" };
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) return { ok: false, reason: "missing-authentication" };
	const token = authorizationToken(auth.apiKey, auth.headers);
	const accountId = token ? resolveAccountId(token) : undefined;
	if (!token || !accountId) {
		return { ok: false, reason: "missing-authentication" };
	}
	return {
		ok: true,
		runtime: {
			...modelIdentity,
			accountId,
			accountIdHash: accountIdHash(accountId),
			modelConfig: ctx.model,
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
		},
	};
}
