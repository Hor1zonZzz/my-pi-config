import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AuthPrompt, LoginOptions, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { AccountStore } from "./store.ts";
import { ACCOUNT_PROVIDERS, accountForCredential, accountLabel, accountProvider, supportedEndpoint, type AccountProvider } from "./providers.ts";

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

async function loginAccount(ctx: ExtensionCommandContext, oauth: OAuthAuth, controller: AbortController, options?: LoginOptions): Promise<OAuthCredential> {
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
		}, options);
	} finally {
		dismiss.abort();
		await deviceDialog;
	}
}

async function nameAccount(ctx: ExtensionCommandContext, provider: AccountProvider, identity: { label: string }, signal: AbortSignal): Promise<string | undefined> {
	if (provider === "openai-codex") return identity.label;
	const value = await ctx.ui.input("Name this ChatGPT login (email or account label)", identity.label, { signal });
	return value === undefined ? undefined : accountLabel(value) || identity.label;
}

export default function codexAccounts(pi: ExtensionAPI): void {
	let operation: AbortController | undefined;
	pi.on("session_shutdown", () => { operation?.abort(); });

	pi.registerCommand("codex-accounts", {
		description: "Manage ChatGPT and legacy Codex subscription accounts (global login switch)",
		getArgumentCompletions(prefix) {
			return Object.entries(ACCOUNT_PROVIDERS).filter(([id]) => id.startsWith(prefix))
				.map(([id, info]) => ({ value: id, label: id, description: info.label }));
		},
		async handler(args, ctx) {
			const requested = args.trim();
			if (requested && !accountProvider(requested)) { ctx.ui.notify("Usage: /codex-accounts [openai|openai-codex]", "warning"); return; }
			if (ctx.mode !== "tui") { ctx.ui.notify("/codex-accounts requires the TUI", "warning"); return; }
			if (operation || !ctx.isIdle()) {
				ctx.ui.notify("Wait until Pi is idle before managing Codex accounts.", "warning"); return;
			}
			const controller = new AbortController();
			operation = controller;
			const signal = controller.signal;
			try {
				const choices = Object.entries(ACCOUNT_PROVIDERS);
				const selection = requested || await ctx.ui.select("Account login type", choices.map(([, info]) => info.label), { signal });
				const selected = accountProvider(selection ?? "")
					?? accountProvider(choices.find(([, info]) => info.label === selection)?.[0] ?? "");
				if (!selected || signal.aborted) return;
				if (!ctx.isIdle()) { ctx.ui.notify("Pi became busy; reopen /codex-accounts when idle.", "warning"); return; }
				const provider = ctx.modelRegistry.getProvider(selected);
				if (!provider || !supportedEndpoint(selected, provider.baseUrl ?? "")) {
					ctx.ui.notify("Account management supports only the official OpenAI and Codex backends.", "warning"); return;
				}
				if (ctx.modelRegistry.getProviderAuthStatus(selected).source === "runtime") {
					ctx.ui.notify("Remove the runtime API-key override before managing OAuth accounts.", "warning"); return;
				}
				const authFlow = provider.auth.oauth;
				if (!authFlow) { ctx.ui.notify("ChatGPT OAuth is unavailable in this provider.", "warning"); return; }
				const store = new AccountStore(getAgentDir(), authFlow, selected);
				const list = await store.list();
				signal.throwIfAborted();
				const rows = list.accounts.map((account, index) =>
						`${account.key === list.current?.key ? "● " : "  "}${index + 1}. ${account.label} · ${account.detail.replace(/[\x00-\x1f\x7f-\x9f]/g, "")}`);
				const canImport = list.current && !list.accounts.some((account) => account.key === list.current?.key);
				const choice = await ctx.ui.select(`${ACCOUNT_PROVIDERS[selected].label} — shared by ALL sessions in this Pi directory`, [
					...rows, ...(canImport ? [IMPORT] : []), ADD,
				], { signal });
				if (!choice || signal.aborted) return;
				if (!ctx.isIdle()) { ctx.ui.notify("Pi became busy; reopen /codex-accounts when idle.", "warning"); return; }

				let changed = false;
				if (choice === IMPORT) {
					if (!await ctx.ui.confirm("Import current login?", `Save ${list.current!.label} in the local account store? OAuth tokens stay on this machine.`, { signal })) return;
					const label = await nameAccount(ctx, selected, list.current!, signal);
					if (label === undefined || signal.aborted) return;
					if (!ctx.isIdle()) { ctx.ui.notify("Pi became busy; import cancelled.", "warning"); return; }
					await store.importCurrent(list.current!.key, signal, label);
					ctx.ui.notify("Current login saved. Reopen /codex-accounts to select an account.", "info");
				} else if (choice === ADD) {
					try {
						// Use the same public settings API as Pi's own /login. A project
						// must not supply the installation identity or write it to this repo.
						const settings = selected === "openai" ? SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: false }) : undefined;
						const options = settings ? { getDeviceId: () => settings.getOrCreateDeviceId() } : undefined;
						const result = await loginAccount(ctx, authFlow, controller, options);
						signal.throwIfAborted();
						const identity = accountForCredential(selected, result);
						if (!identity) throw new Error("Login returned unsupported credentials");
						const label = await nameAccount(ctx, selected, identity, signal);
						if (label === undefined || signal.aborted) return;
						if (!ctx.isIdle()) throw new Error("Pi became busy");
						changed = await store.add(result, signal, label);
						ctx.ui.notify(changed ? "Active account reauthorized." : "Account saved; the active login is unchanged. Reopen /codex-accounts to switch.", "info");
					} catch {
						if (!signal.aborted) ctx.ui.notify("Login cancelled or could not be saved. Reopen /codex-accounts to check the current account.", "warning");
						return;
					}
				} else {
					const account = list.accounts[rows.indexOf(choice)];
					if (!account) return;
					if (account.key === list.current?.key) {
						await store.switchTo(account.key, list.currentKey, signal);
						return;
					}
					const apiKeyWarning = list.replacesApiKey ? " This replaces the saved API key for this provider; API keys are not saved in the account vault." : "";
					if (!await ctx.ui.confirm(`Switch ${selected} globally?`, `Use ${account.label} for future ${selected} requests in all sessions sharing this Pi directory, including their existing conversation context? Already-running requests keep their existing account.${apiKeyWarning}`, { signal })) return;
					if (!ctx.isIdle()) { ctx.ui.notify("Pi became busy; switch cancelled.", "warning"); return; }
					ctx.ui.notify(`Validating the account and updating the global ${selected} login…`, "info");
					changed = await store.switchTo(account.key, list.currentKey, signal);
					ctx.ui.notify(`Global ${selected} login changed. Model and thinking are unchanged.`, "info");
				}
				if (changed && !signal.aborted) {
					// Pi 0.86.0 detects atomic auth-file replacement on the next read.
					// Refresh local availability and notify quota without reloading the session.
					pi.events.emit(`${selected === "openai-codex" ? "codex" : "openai"}-accounts:changed`, undefined);
					try {
						const result = await ctx.modelRegistry.refresh({ providers: [selected], allowNetwork: false, signal });
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
