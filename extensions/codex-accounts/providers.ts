import { createHash } from "node:crypto";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { accountFromToken, isSupportedCodexEndpoint } from "../codex-statusline/quota.ts";

export type AccountProvider = "openai-codex" | "openai";
export const ACCOUNT_PROVIDERS: Record<AccountProvider, { label: string; vault: string }> = {
	"openai": { label: "OpenAI — Sign in with ChatGPT", vault: "openai-accounts.json" },
	"openai-codex": { label: "OpenAI Codex — legacy", vault: "codex-accounts.json" },
};

export interface ManagedAccount {
	key: string;
	label: string;
	detail: string;
}

export function accountProvider(value: string): AccountProvider | undefined {
	return value === "openai" || value === "openai-codex" ? value : undefined;
}

export function supportedEndpoint(provider: AccountProvider, baseUrl: string): boolean {
	if (provider === "openai-codex") return isSupportedCodexEndpoint(baseUrl);
	try {
		const url = new URL(baseUrl);
		return url.origin === "https://api.openai.com" && /^\/v1\/?$/.test(url.pathname)
			&& !url.username && !url.password && !url.search && !url.hash;
	} catch { return false; }
}

export function accountLabel(value: string): string {
	return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim().slice(0, 160);
}

/** New ChatGPT OAuth permits opaque access tokens and does not persist the ID token.
 * Each native login registers a client; clientId survives refresh and identifies the
 * saved authorization, not necessarily a unique person. Never key by a rotating token
 * or pretend a user-entered email establishes account identity.
 */
export function accountForCredential(provider: AccountProvider, value: OAuthCredential): ManagedAccount | undefined {
	if (provider === "openai-codex") {
		const account = accountFromToken(value.access);
		return account && { key: account.key, label: account.label, detail: account.accountId.slice(-8) };
	}
	if (typeof value.clientId !== "string" || !value.clientId.trim() || value.clientId.length > 4096
		|| !Array.isArray(value.scopes) || !value.scopes.every((scope) => typeof scope === "string")
		|| !value.scopes.includes("chatgpt.tokens.use.direct")) return undefined;
	const key = createHash("sha256").update(JSON.stringify([provider, value.clientId])).digest("hex");
	let label = "ChatGPT account";
	try {
		const parts = value.access.split(".");
		if (parts.length === 3 && value.access.length <= 64 * 1024) {
			const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
			const email = payload?.email ?? payload?.["https://api.openai.com/profile"]?.email;
			if (typeof email === "string" && accountLabel(email)) label = accountLabel(email);
		}
	} catch { /* An opaque token is valid; use a local account label. */ }
	return { key, label, detail: key.slice(0, 8) };
}
