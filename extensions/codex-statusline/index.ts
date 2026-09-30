import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSharedQuota, REFRESH_MS, type QuotaCache } from "./cache.ts";
import {
	fetchAccountEmail,
	formatReset,
	identityFromToken,
	isChatGPTSignIn,
	PROVIDER as CHATGPT_PROVIDER,
	usageLimitFromError,
} from "./chatgpt.ts";
import { accountFromToken, fetchWeeklyQuota, isSupportedCodexEndpoint, type Account } from "./quota.ts";

const PROVIDER = "openai-codex";
const STATUS_KEY = "codex-quota";
// Local auth/cache checks are not quota requests. The cross-process cache owns
// the five-minute network cadence, including failures and concurrent startup.
const LOCAL_CHECK_MS = 15_000;

function weekly(cached: QuotaCache | undefined, now: number): { text: string; stale: boolean } {
	if (cached?.quota) {
		const stale = cached.state !== "ok" || cached.nextCheckAt <= now
			|| (cached.quota.resetAt !== undefined && cached.quota.resetAt <= now);
		return { text: `weekly ${cached.quota.remainingPercent}% left`, stale };
	}
	const loading = !cached || (cached.state === "pending" && now - cached.attemptedAt < 15_000);
	return { text: `weekly ${loading ? "loading" : "unavailable"}`, stale: false };
}

export function formatStatus(label: string, cached: QuotaCache | undefined, now = Date.now()): string {
	const { text, stale } = weekly(cached, now);
	return `${label} · ${text}${stale ? " (stale)" : ""}`;
}

export interface ChatGPTStatus {
	label?: string;
	limit?: { resetAt?: number };
	/** Present only when the legacy Codex login belongs to the same email. */
	codex?: { cached?: QuotaCache };
}

/** The `openai` login has no usage endpoint: show a limit only after the server reports one. */
export function formatChatGPTStatus(status: ChatGPTStatus, now = Date.now()): string {
	const label = status.label ?? "ChatGPT account";
	if (status.limit) {
		const { resetAt } = status.limit;
		return `${label} · limit reached${resetAt !== undefined && resetAt > now ? ` · resets ${formatReset(resetAt, now)}` : ""}`;
	}
	if (!status.codex) return label;
	const { text, stale } = weekly(status.codex.cached, now);
	return `${label} · plan ${text} (via Codex${stale ? ", stale" : ""})`;
}

export default function codexStatusline(pi: ExtensionAPI) {
	let stop = () => {};
	let checkNow = () => {};
	let onResponse = (_status: number) => {};
	let onAssistantError = (_message: string) => {};
	// Per-process state for the `openai` login, keyed by its hashed identity. Emails
	// stay in memory only; the shared cache never stores them.
	const emails = new Map<string, { email?: string; retryAt: number; busy: boolean }>();
	const limits = new Map<string, { resetAt?: number }>();

	function start(ctx: ExtensionContext): void {
		stop();
		checkNow = () => {};
		onResponse = () => {};
		onAssistantError = () => {};
		if (ctx.mode !== "tui") return;
		if (ctx.model?.provider === PROVIDER) startCodex(ctx);
		else if (ctx.model?.provider === CHATGPT_PROVIDER) startChatGPT(ctx);
	}

	function startCodex(ctx: ExtensionContext): void {
		const root = join(getAgentDir(), "cache", "codex-statusline");
		let stopped = false;
		let authBusy = false;
		let active: { account: Account; controller: AbortController; busy: boolean } | undefined;
		ctx.ui.setStatus(STATUS_KEY, "Codex · weekly loading");

		async function check(): Promise<void> {
			if (stopped || authBusy || ctx.model?.provider !== PROVIDER) return;
			authBusy = true;
			try {
				const model = ctx.model;
				// Public Pi auth resolution honors the current provider and handles
				// OAuth refresh. No independent login, credential store, or token writes.
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (stopped) return;
				const account = auth.ok && auth.apiKey
					&& isSupportedCodexEndpoint(auth.baseUrl ?? model.baseUrl)
					? accountFromToken(auth.apiKey) : undefined;
				if (!account || !auth.ok || !auth.apiKey) {
					active?.controller.abort();
					active = undefined;
					ctx.ui.setStatus(STATUS_KEY, "Codex · weekly unavailable");
					return;
				}
				if (active?.account.key !== account.key) {
					active?.controller.abort();
					active = { account, controller: new AbortController(), busy: false };
					ctx.ui.setStatus(STATUS_KEY, formatStatus(account.label, undefined));
				} else {
					active.account = account;
				}
				if (active.busy) return;
				const current = active;
				const token = auth.apiKey;
				current.busy = true;
				// Do not await network work here: local auth checks can detect an
				// account change and cancel this request while it is still in flight.
				void getSharedQuota({
					root, key: account.key, signal: current.controller.signal,
					query: () => fetchWeeklyQuota(account, token, current.controller.signal),
				}).then((cached) => {
					if (!stopped && active === current) {
						ctx.ui.setStatus(STATUS_KEY, formatStatus(current.account.label, cached));
					}
				}).catch(() => {
					if (!stopped && active === current) {
						ctx.ui.setStatus(STATUS_KEY, `${current.account.label} · weekly unavailable`);
					}
				}).finally(() => { current.busy = false; });
			} catch {
				if (!stopped) {
					active?.controller.abort();
					active = undefined;
					ctx.ui.setStatus(STATUS_KEY, "Codex · weekly unavailable");
				}
			} finally {
				authBusy = false;
			}
		}

		const timer = setInterval(() => { void check(); }, LOCAL_CHECK_MS);
		timer.unref();
		stop = () => {
			stopped = true;
			clearInterval(timer);
			active?.controller.abort();
			ctx.ui.setStatus(STATUS_KEY, undefined);
		};
		checkNow = () => { void check(); };
		checkNow();
	}

	function startChatGPT(ctx: ExtensionContext): void {
		const root = join(getAgentDir(), "cache", "codex-statusline");
		let stopped = false;
		let authBusy = false;
		let identity: { key: string; controller: AbortController } | undefined;
		let codex: { account: Account; controller: AbortController; busy: boolean; cached?: QuotaCache } | undefined;

		const render = () => {
			if (stopped) return;
			if (!identity) {
				ctx.ui.setStatus(STATUS_KEY, "ChatGPT · loading");
				return;
			}
			const email = emails.get(identity.key)?.email;
			let limit = limits.get(identity.key);
			if (limit?.resetAt !== undefined && limit.resetAt <= Date.now()) {
				limits.delete(identity.key);
				limit = undefined;
			}
			const borrowed = email && codex && codex.account.label.toLowerCase() === email.toLowerCase()
				? { cached: codex.cached } : undefined;
			ctx.ui.setStatus(STATUS_KEY, formatChatGPTStatus({ label: email, limit, codex: borrowed }));
		};

		const clearCodex = () => {
			codex?.controller.abort();
			codex = undefined;
		};

		async function check(): Promise<void> {
			if (stopped || authBusy || ctx.model?.provider !== CHATGPT_PROVIDER) return;
			authBusy = true;
			try {
				const model = ctx.model;
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (stopped) return;
				// API-key users and custom endpoints are out of scope: show nothing.
				if (!auth.ok || !auth.apiKey || !isChatGPTSignIn(auth.baseUrl ?? model.baseUrl, auth.apiKey)) {
					identity?.controller.abort();
					identity = undefined;
					clearCodex();
					ctx.ui.setStatus(STATUS_KEY, undefined);
					return;
				}
				const token = auth.apiKey;
				const next = identityFromToken(token);
				if (!next) {
					identity?.controller.abort();
					identity = undefined;
					clearCodex();
					ctx.ui.setStatus(STATUS_KEY, "ChatGPT account");
					return;
				}
				if (identity?.key !== next.key) {
					identity?.controller.abort();
					identity = { key: next.key, controller: new AbortController() };
					clearCodex();
				}
				const current = identity;
				const entry = emails.get(current.key) ?? { retryAt: 0, busy: false };
				emails.set(current.key, entry);
				if (!entry.email && !entry.busy && entry.retryAt <= Date.now()) {
					entry.busy = true;
					// Not awaited: a later auth check can switch accounts and abort it.
					void fetchAccountEmail(token, current.controller.signal).then((email) => {
						entry.email = email;
						if (!email) entry.retryAt = Date.now() + REFRESH_MS;
					}, () => { entry.retryAt = Date.now() + REFRESH_MS; }).finally(() => {
						entry.busy = false;
						if (identity === current) checkNow();
					});
				}

				// Borrow the plan's weekly quota from the legacy Codex login, through the
				// same shared cache, only once its email is known to match.
				const codexModel = entry.email
					? ctx.modelRegistry.getAvailable().find((candidate) => candidate.provider === PROVIDER) : undefined;
				const codexAuth = codexModel ? await ctx.modelRegistry.getApiKeyAndHeaders(codexModel) : undefined;
				if (stopped || identity !== current) return;
				const codexToken = codexAuth?.ok ? codexAuth.apiKey : undefined;
				const codexBaseUrl = codexAuth?.ok ? codexAuth.baseUrl : undefined;
				const account = codexModel && codexToken
					&& isSupportedCodexEndpoint(codexBaseUrl ?? codexModel.baseUrl)
					? accountFromToken(codexToken) : undefined;
				if (!account || !codexToken || account.label.toLowerCase() !== entry.email?.toLowerCase()) {
					clearCodex();
				} else {
					if (codex?.account.key !== account.key) {
						clearCodex();
						codex = { account, controller: new AbortController(), busy: false };
					} else {
						codex.account = account;
					}
					if (!codex.busy) {
						const borrowed = codex;
						borrowed.busy = true;
						void getSharedQuota({
							root, key: account.key, signal: borrowed.controller.signal,
							query: () => fetchWeeklyQuota(account, codexToken, borrowed.controller.signal),
						}).then((cached) => { borrowed.cached = cached; }, () => {
							borrowed.cached = { version: 1, attemptedAt: Date.now(), nextCheckAt: Date.now() + REFRESH_MS, state: "error" };
						}).finally(() => {
							borrowed.busy = false;
							if (codex === borrowed) render();
						});
					}
				}
				render();
			} catch {
				if (!stopped) {
					identity?.controller.abort();
					identity = undefined;
					clearCodex();
					ctx.ui.setStatus(STATUS_KEY, "ChatGPT account");
				}
			} finally {
				authBusy = false;
			}
		}

		ctx.ui.setStatus(STATUS_KEY, "ChatGPT · loading");
		const timer = setInterval(() => { void check(); }, LOCAL_CHECK_MS);
		timer.unref();
		stop = () => {
			stopped = true;
			clearInterval(timer);
			identity?.controller.abort();
			clearCodex();
			ctx.ui.setStatus(STATUS_KEY, undefined);
		};
		checkNow = () => { void check(); };
		// A successful response means the plan accepted requests again.
		onResponse = (status) => {
			if (identity && status >= 200 && status < 300 && limits.delete(identity.key)) render();
		};
		onAssistantError = (message) => {
			const limit = usageLimitFromError(message);
			if (!identity || !limit) return;
			limits.set(identity.key, limit);
			render();
		};
		checkNow();
	}

	const unsubscribeAccounts = pi.events.on("codex-accounts:changed", () => { checkNow(); });
	pi.on("session_start", (_event, ctx) => { start(ctx); });
	pi.on("model_select", (_event, ctx) => { start(ctx); });
	pi.on("agent_start", () => { checkNow(); });
	pi.on("agent_settled", () => { checkNow(); });
	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model?.provider === CHATGPT_PROVIDER) onResponse(event.status);
	});
	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; provider?: string; stopReason?: string; errorMessage?: string };
		if (message.role === "assistant" && message.provider === CHATGPT_PROVIDER
			&& message.stopReason === "error" && typeof message.errorMessage === "string") {
			onAssistantError(message.errorMessage);
		}
	});
	pi.on("session_shutdown", () => {
		unsubscribeAccounts();
		stop();
		stop = () => {};
		checkNow = () => {};
		onResponse = () => {};
		onAssistantError = () => {};
	});
}
