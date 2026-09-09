import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AuthPrompt, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { AccountStore } from "./store.ts";
import { isSupportedCodexEndpoint } from "../codex-statusline/quota.ts";

const PROVIDER = "openai-codex";
const IMPORT = "Import current Pi login";
const ADD = "Add account / sign in again";

async function promptLogin(ctx: ExtensionCommandContext, prompt: AuthPrompt, signal: AbortSignal): Promise<string> {
	const options = { signal: prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal };
	if (prompt.type === "select") {
		const labels = prompt.options.map((item) => item.label);
		const choice = await ctx.ui.select(prompt.message, labels, options);
		if (choice !== undefined) return prompt.options[labels.indexOf(choice)].id;
	} else {
		const value = await ctx.ui.input(prompt.message, prompt.placeholder, options);
		if (value !== undefined) return value;
	}
	throw new Error("Login cancelled");
}

async function loginAccount(ctx: ExtensionCommandContext, oauth: OAuthAuth, controller: AbortController): Promise<OAuthCredential> {
	const signal = controller.signal;
	const dismiss = new AbortController();
	let deviceDialog: Promise<void> | undefined;
	try {
		return await oauth.login({
			signal,
			prompt: (prompt) => promptLogin(ctx, prompt, signal),
			notify: (event) => {
				if (signal.aborted) return;
				if (event.type === "auth_url") ctx.ui.notify(`Open this URL to sign in:\n${event.url}\n${event.instructions ?? ""}`, "info");
				else if (event.type === "device_code") {
					// Device OAuth polls without another prompt. Keep a native dialog
					// focused so Esc can abort the same signal used by the poller.
					deviceDialog = ctx.ui.select(
						`Open ${event.verificationUri}\nCode: ${event.userCode}\nWaiting for sign-in — Esc to cancel`,
						["Cancel login"], { signal: AbortSignal.any([signal, dismiss.signal]) },
					).then(() => {
						// Completion dismisses the dialog without cancelling valid credentials.
						if (!dismiss.signal.aborted) controller.abort();
					}, () => { controller.abort(); });
				} else ctx.ui.notify(event.message, "info");
			},
		});
	} finally {
		dismiss.abort();
		await deviceDialog;
	}
}

export default function codexAccounts(pi: ExtensionAPI): void {
	let operation: AbortController | undefined;
	pi.on("session_shutdown", () => { operation?.abort(); });

	pi.registerCommand("codex-accounts", {
		description: "Manage Codex subscription accounts (global login switch)",
		async handler(args, ctx) {
			if (args.trim()) { ctx.ui.notify("Usage: /codex-accounts", "warning"); return; }
			if (ctx.mode !== "tui") { ctx.ui.notify("/codex-accounts requires the TUI", "warning"); return; }
			if (operation || !ctx.isIdle()) {
				ctx.ui.notify("Wait until Pi is idle before managing Codex accounts.", "warning"); return;
			}
			const provider = ctx.modelRegistry.getProvider(PROVIDER);
			if (!provider || !isSupportedCodexEndpoint(provider.baseUrl ?? "")) {
				ctx.ui.notify("Account management supports only the official Codex backend.", "warning"); return;
			}
			if (ctx.modelRegistry.getProviderAuthStatus(PROVIDER).source === "runtime") {
				ctx.ui.notify("Remove the runtime API-key override before managing Codex OAuth accounts.", "warning"); return;
			}
			const authFlow = provider.auth.oauth;
			if (!authFlow) { ctx.ui.notify("Codex OAuth is unavailable in this provider.", "warning"); return; }
			const controller = new AbortController();
			operation = controller;
			const signal = controller.signal;
			const store = new AccountStore(getAgentDir(), authFlow);
			try {
				const list = await store.list();
				signal.throwIfAborted();
				const rows = list.accounts.map((account, index) =>
					`${account.key === list.current?.key ? "● " : "  "}${index + 1}. ${account.label} · ${account.accountId.slice(-8).replace(/[\x00-\x1f\x7f-\x9f]/g, "")}`);
				const canImport = list.current && !list.accounts.some((account) => account.key === list.current?.key);
				const choice = await ctx.ui.select("Codex accounts — shared by ALL sessions in this Pi directory", [
					...rows, ...(canImport ? [IMPORT] : []), ADD,
				], { signal });
				if (!choice || signal.aborted) return;
				if (!ctx.isIdle()) { ctx.ui.notify("Pi became busy; reopen /codex-accounts when idle.", "warning"); return; }

				let changed = false;
				if (choice === IMPORT) {
					if (!await ctx.ui.confirm("Import current login?", `Save ${list.current!.label} in the local account store? OAuth tokens stay on this machine.`, { signal })) return;
					await store.importCurrent(list.current!.key, signal);
					ctx.ui.notify("Current login saved. Reopen /codex-accounts to select an account.", "info");
				} else if (choice === ADD) {
					try {
						const result = await loginAccount(ctx, authFlow, controller);
						signal.throwIfAborted();
						if (!ctx.isIdle()) throw new Error("Pi became busy");
						changed = await store.add(result, signal);
						ctx.ui.notify(changed ? "Active account reauthorized." : "Account saved; the active login is unchanged. Reopen /codex-accounts to switch.", "info");
					} catch {
						if (!signal.aborted) ctx.ui.notify("Login cancelled or could not be saved. Reopen /codex-accounts to check the current account.", "warning");
						return;
					}
				} else {
					const account = list.accounts[rows.indexOf(choice)];
					if (!account) return;
					if (account.key === list.current?.key) {
						await store.switchTo(account.key, list.current.key, signal);
						return;
					}
					if (!await ctx.ui.confirm("Switch Codex globally?", `Use ${account.label} for future requests in all sessions sharing this Pi directory, including their existing conversation context? Already-running requests keep their existing account.`, { signal })) return;
					if (!ctx.isIdle()) { ctx.ui.notify("Pi became busy; switch cancelled.", "warning"); return; }
					ctx.ui.notify("Validating the account and updating the global Codex login…", "info");
					changed = await store.switchTo(account.key, list.current?.key, signal);
					ctx.ui.notify("Global Codex login changed. Model, thinking, and Fast are unchanged.", "info");
				}
				if (changed && !signal.aborted) {
					// Pi 0.85.1 detects atomic auth-file replacement on the next read.
					// Refresh local availability and notify quota without reloading the session.
					pi.events.emit("codex-accounts:changed", undefined);
					try {
						const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER], allowNetwork: false, signal });
						if (result.errors.size > 0 && !signal.aborted) {
							ctx.ui.notify("Login was changed, but model availability could not be refreshed. Run /reload.", "warning");
						}
					} catch {
						if (!signal.aborted) ctx.ui.notify("Login was changed, but local auth refresh failed. Run /reload.", "warning");
					}
				}
			} catch (error) {
				if (!signal.aborted) ctx.ui.notify(error instanceof Error ? error.message : "Account operation failed.", "error");
			} finally {
				if (operation === controller) operation = undefined;
			}
		},
	});
}
