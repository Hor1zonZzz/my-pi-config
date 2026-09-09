# Global Codex subscription accounts

English | [中文](README.zh-CN.md)

`/codex-accounts` opens a TUI account menu. This is a **global login switch for
one Pi agent directory**, not session-specific account selection. The provider
remains `openai-codex`; model, thinking, and Fast settings are unchanged.
Install it together with this repository's updated `codex-statusline` and
`codex-server-compaction` directories: they provide the shared identity decoder,
immediate quota updates, and account-safe native history. This directory is not
an independently packaged replacement for the third-party switcher.

## Menu

- **Import current Pi login**: appears when the current login is not saved;
  asks for confirmation before saving its latest credentials.
- **Add account / sign in again**: uses the current provider's public OAuth
  implementation (Pi's built-in Codex flow in this configuration). Open the
  displayed authorization URL (or use the offered device flow). During device
  login, press **Esc** or select **Cancel login** to stop polling; the waiting
  dialog closes automatically on completion or failure. Cancelling saves nothing
  and lets you reopen the account menu. A new account is saved without switching; signing in again to the
  active identity updates that identity's active credentials.
- **Select a saved account**: confirms the global scope, preserves the current
  login's latest tokens, refreshes the target if needed, then changes the login.
  Selecting the current account is a no-op, never a restore of an older snapshot.

Reopen the menu after adding/importing an account. Full email is shown where
available, with an account-ID suffix to distinguish workspaces. Account identity
includes the user as well as the workspace; labels are not used as credential keys.
There are no automatic failovers, account deletions, renames, or batch quota queries.

Use this menu to add/switch accounts after setup. Directly replacing auth.json,
using another switcher, or running `/login openai-codex` outside this workflow can
bypass snapshot synchronization; an older saved grant may then require sign-in
again. The third-party `pi-codex-account` store format is not migrated or overwritten.

## Scope and safety

- New and resumed sessions use the **current global login**, not a historical
  choice. No credential or selected-account preference is written to a session.
  Future requests send the existing visible conversation context under the selected
  account; switching does not clear conversations.
- Already-bound/in-flight requests retain their original account. Other running
  Pi 0.85.1 processes observe the replaced credential on their next auth read.
- Management is TUI-only and requires the current Pi session to be idle. It does
  not stop requests in other processes. Runtime API-key overrides and nonstandard
  Codex backends are not supported.
- The existing quota extension receives a local change notification; other TUI
  sessions detect the change through their regular auth checks. Its per-identity,
  shared five-minute quota cache remains intact.
- Normal Pi login storage is `auth.json`; the account vault is
  `<agent-dir>/codex-accounts.json`, resolved with public `getAgentDir()`.
  Different agent directories are isolated.

The vault contains sensitive OAuth tokens. It is runtime-only, excluded from Git,
never copied/reset by the installer, and written with `0600` permissions. Do not
share or commit it. Auth and vault writes use temporary `0600` files and atomic
rename; unrelated provider entries are preserved. Corrupt/unreadable files are
errors, never silently replaced by an empty store.

The vault is committed before auth.json. If the final auth commit fails, the old
login remains active and both snapshots remain recoverable; there is no second
`active` pointer that can contradict auth.json. A just-returned rotated credential
is preserved even if cancellation prevents the subsequent switch. Expired/revoked
refresh failures never silently fall back to another account. A syntactically valid,
unexpired token is not a guarantee that the server will accept a later request.

## Pi compatibility

Tested against Pi **0.85.1**. Commands, dialogs, OAuth login/refresh, model registry
refresh and events use public APIs. The one compatibility dependency is filesystem
locking: Pi does not expose a public transaction spanning auth.json and a vault.
`store.ts` resolves **Pi's own `proper-lockfile` dependency** via `getPackageDir()`
and uses its `auth.json.lock`, `realpath:false` protocol. This serializes switching
with Pi's OAuth refresh, unlike an independent plugin lock. The lock is heartbeated,
and its ownership/cancellation is checked before committing. Revisit the dependency
and protocol on Pi upgrades. No private runtime objects are modified.

Pi 0.85.1 re-reads credentials when the auth file revision changes. Therefore the
extension neither fabricates `expires: 0` nor reloads the session on each switch.
It refreshes local model availability without network catalog requests.

The repository's companion compaction extension tags new opaque artifacts with an
account fingerprint and validates replay using the **actual request token**. Unknown
legacy ownership or a foreign-account turn uses Pi's text fallback; foreign opaque
reasoning and response references are removed. Same-account Fast and V2 continuation
behavior is preserved. This provenance is not a session account preference.

## Tests and reference

The focused Node tests require Pi's host dependencies in module resolution; use a
disposable copy. They cover import/add/switch, cancellation, malformed stores,
refresh failure/rotation, real Pi auth-lock contention, and a second running Pi
auth runtime observing a switch without reload. Transport tests cover A/B/A replay
and an auth change after a request's token has already been bound. No real accounts
are used by the tests.

The global snapshot workflow was informed by
[fadilsflow/pi-codex-account](https://github.com/fadilsflow/pi-codex-account)
(MIT, reviewed at `35b77b8`); this is an independent implementation, not a vendored
copy. It adds shared auth locking, atomic commits, native OAuth addition, and
account-aware quota/compaction integration rather than its forced-expiry approach.
