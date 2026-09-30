import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { ACCOUNT_PROVIDERS, accountForCredential, accountLabel, type AccountProvider, type ManagedAccount } from "./providers.ts";

export interface SavedAccount { credential: OAuthCredential; savedAt: number; label?: string }
interface Vault { version: 1; accounts: Record<string, SavedAccount> }
export interface AccountList { accounts: ManagedAccount[]; current?: ManagedAccount; currentKey?: string; replacesApiKey: boolean }

// Pi 0.86.0 exposes no public auth-file transaction API. Use the host's own
// proper-lockfile dependency and auth.json.lock protocol, not private runtime
// objects or an unrelated lock that would race Pi's OAuth refresh. Revisit this
// dependency/protocol on Pi upgrades; do not independently force token expiry.
const requireHost = createRequire(join(getPackageDir(), "package.json"));
const lockfile = requireHost("proper-lockfile") as {
	lock(path: string, options: Record<string, unknown>): Promise<() => Promise<void>>;
};

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function credential(provider: AccountProvider, value: unknown): OAuthCredential | undefined {
	if (!record(value) || value.type !== "oauth" || typeof value.access !== "string"
		|| !value.access || value.access.length > 64 * 1024
		|| typeof value.refresh !== "string" || !value.refresh || typeof value.expires !== "number"
		|| !Number.isFinite(value.expires) || !accountForCredential(provider, value as unknown as OAuthCredential)) return undefined;
	return value as unknown as OAuthCredential;
}
async function readObject(path: string): Promise<Record<string, unknown>> {
	try {
		const raw = await readFile(path, "utf8");
		if (raw.length > 2 * 1024 * 1024) throw new Error();
		const value: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
		if (!record(value)) throw new Error();
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		// Never fall back to {} for corrupt/unreadable credentials and overwrite them.
		throw new Error("Cannot read account storage safely; no credentials were changed.");
	}
}
async function readVault(path: string, provider: AccountProvider): Promise<Vault> {
	const raw = await readObject(path);
	if (Object.keys(raw).length === 0) return { version: 1, accounts: {} };
	if (raw.version !== 1 || !record(raw.accounts)) throw new Error("Unsupported account store; no credentials were changed.");
	for (const [key, value] of Object.entries(raw.accounts)) {
		if (!record(value) || !credential(provider, value.credential)
			|| (value.label !== undefined && (typeof value.label !== "string" || !value.label || accountLabel(value.label) !== value.label))
			|| accountForCredential(provider, value.credential as OAuthCredential)?.key !== key) {
			throw new Error("Invalid saved account; no credentials were changed.");
		}
	}
	return raw as unknown as Vault;
}
async function atomicWrite(path: string, value: unknown, beforeCommit: () => void): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
		beforeCommit();
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
}

/** One transaction protects both snapshots and the Pi-owned active credential. */
export class AccountStore {
	private readonly agentDir: string;
	private readonly oauth: OAuthAuth;
	private readonly provider: AccountProvider;
	constructor(agentDir: string, oauth: OAuthAuth, provider: AccountProvider = "openai-codex") {
		this.agentDir = agentDir;
		this.oauth = oauth;
		this.provider = provider;
	}
	private get authPath() { return join(this.agentDir, "auth.json"); }
	private get vaultPath() { return join(this.agentDir, ACCOUNT_PROVIDERS[this.provider].vault); }
	private identity(value: OAuthCredential): ManagedAccount { return accountForCredential(this.provider, value)!; }
	private activeKey(value: unknown): string | undefined {
		const valid = credential(this.provider, value);
		if (valid) return this.identity(valid).key;
		// Detect replacement of an API key/unknown credential between the menu and commit.
		return value === undefined ? undefined : `unmanaged:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
	}

	async list(): Promise<AccountList> {
		const vault = await readVault(this.vaultPath, this.provider);
		const auth = await readObject(this.authPath);
		const stored = auth[this.provider];
		const active = credential(this.provider, stored);
		const current = active ? this.identity(active) : undefined;
		if (current && vault.accounts[current.key]?.label) current.label = vault.accounts[current.key].label!;
		return {
			accounts: Object.values(vault.accounts).map((entry) => ({ ...this.identity(entry.credential), ...(entry.label ? { label: entry.label } : {}) }))
				.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key)),
			current, currentKey: this.activeKey(stored),
			replacesApiKey: record(stored) && stored.type === "api_key",
		};
	}

	private async transaction<T>(signal: AbortSignal, fn: (
		auth: Record<string, unknown>, vault: Vault, check: (includeAbort?: boolean) => void,
	) => Promise<T>): Promise<T> {
		signal.throwIfAborted();
		await mkdir(this.agentDir, { recursive: true, mode: 0o700 });
		// realpath:false permits a missing auth.json; mkdir locking remains atomic.
		let compromised = false;
		const release = await lockfile.lock(this.authPath, {
			realpath: false, stale: 30_000, update: 1000,
			retries: { retries: 25, minTimeout: 50, maxTimeout: 1000 },
			onCompromised: () => { compromised = true; },
		});
		const check = (includeAbort = true) => {
			if (includeAbort) signal.throwIfAborted();
			if (compromised) throw new Error("Account storage lock lost; retry the operation.");
		};
		try {
			check();
			return await fn(await readObject(this.authPath), await readVault(this.vaultPath, this.provider), check);
		} finally {
			await release().catch(() => {});
		}
	}

	async importCurrent(expected: string, signal: AbortSignal, label?: string): Promise<void> {
		await this.transaction(signal, async (auth, vault, check) => {
			const active = credential(this.provider, auth[this.provider]);
			if (!active || this.identity(active).key !== expected) throw new Error("Current login changed; reopen /codex-accounts.");
			vault.accounts[expected] = { credential: active, savedAt: Date.now(), ...(label ? { label: accountLabel(label) } : {}) };
			check();
			await atomicWrite(this.vaultPath, vault, check);
		});
	}

	/** Save a newly authorized grant without switching to a different account. */
	async add(value: OAuthCredential, signal: AbortSignal, label?: string): Promise<boolean> {
		const valid = credential(this.provider, value);
		if (!valid || valid.expires <= Date.now()) throw new Error("Login returned invalid or expired credentials.");
		const key = this.identity(valid).key;
		return this.transaction(signal, async (auth, vault, check) => {
			const active = credential(this.provider, auth[this.provider]);
			const updatesActive = !!active && this.identity(active).key === key;
			vault.accounts[key] = { credential: valid, savedAt: Date.now(), ...(label ? { label: accountLabel(label) } : {}) };
			check();
			await atomicWrite(this.vaultPath, vault, check);
			// Reauthorizing the active identity replaces an invalid grant, not the account.
			if (updatesActive) {
				check();
				await atomicWrite(this.authPath, { ...auth, [this.provider]: valid }, check);
			}
			return updatesActive;
		});
	}

	async switchTo(key: string, expectedCurrent: string | undefined, signal: AbortSignal): Promise<boolean> {
		return this.transaction(signal, async (auth, vault, check) => {
			const active = credential(this.provider, auth[this.provider]);
			const activeKey = this.activeKey(auth[this.provider]);
			if (activeKey !== expectedCurrent) throw new Error("Another process changed the login; reopen /codex-accounts.");
			// A same-account selection must never restore its older refresh-token snapshot.
			if (activeKey === key) return false;
			let target = vault.accounts[key]?.credential;
			if (!target) throw new Error("Saved account is missing; reopen /codex-accounts.");
			if (target.expires <= Date.now() + 5 * 60_000) {
				try {
					target = await this.oauth.refresh(target, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
				} catch {
					throw new Error("Account refresh failed; add/sign in to that account again. Active login is unchanged.");
				}
			}
			if (!credential(this.provider, target) || target.expires <= Date.now() || this.identity(target).key !== key) {
				throw new Error("Refreshed account did not match; active login is unchanged.");
			}
			if (active && activeKey) vault.accounts[activeKey] = { ...vault.accounts[activeKey], credential: active, savedAt: Date.now() };
			vault.accounts[key] = { ...vault.accounts[key], credential: target, savedAt: Date.now() };
			// Write the vault first. A crash/failure before the auth commit leaves the
			// previous login active and both recoverable snapshots saved. No active pointer
			// in the vault can disagree with auth.json, the sole authority for selection.
			// A refresh may have rotated the grant just before cancellation. Preserve
			// that returned credential, but never switch the active login after abort.
			check(false);
			await atomicWrite(this.vaultPath, vault, () => check(false));
			check();
			await atomicWrite(this.authPath, { ...auth, [this.provider]: target }, check);
			return true;
		});
	}
}
