import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSharedQuota, type QuotaCache } from "./cache.ts";
import { accountFromToken, fetchWeeklyQuota, isSupportedCodexEndpoint, type Account } from "./quota.ts";

const PROVIDER = "openai-codex";
const STATUS_KEY = "codex-quota";
// Local auth/cache checks are not quota requests. The cross-process cache owns
// the five-minute network cadence, including failures and concurrent startup.
const LOCAL_CHECK_MS = 15_000;

export function formatStatus(label: string, cached: QuotaCache | undefined, now = Date.now()): string {
	if (cached?.quota) {
		const stale = cached.state !== "ok" || cached.nextCheckAt <= now
			|| (cached.quota.resetAt !== undefined && cached.quota.resetAt <= now);
		return `${label} · weekly ${cached.quota.remainingPercent}% left${stale ? " (stale)" : ""}`;
	}
	const loading = !cached || (cached.state === "pending" && now - cached.attemptedAt < 15_000);
	return `${label} · weekly ${loading ? "loading" : "unavailable"}`;
}

export default function codexStatusline(pi: ExtensionAPI) {
	let stop = () => {};
	let checkNow = () => {};

	function start(ctx: ExtensionContext): void {
		stop();
		checkNow = () => {};
		if (ctx.mode !== "tui" || ctx.model?.provider !== PROVIDER) return;

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

	pi.on("session_start", (_event, ctx) => { start(ctx); });
	pi.on("model_select", (_event, ctx) => { start(ctx); });
	pi.on("agent_start", () => { checkNow(); });
	pi.on("agent_settled", () => { checkNow(); });
	pi.on("session_shutdown", () => {
		stop();
		stop = () => {};
		checkNow = () => {};
	});
}
