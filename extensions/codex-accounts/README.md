# Global ChatGPT and Codex subscription accounts

English | [中文](README.zh-CN.md)

`/codex-accounts` first selects the login type, then opens its TUI account menu:
**OpenAI — Sign in with ChatGPT** (`openai`) or **OpenAI Codex — legacy**
(`openai-codex`). Use `/codex-accounts openai` or `/codex-accounts openai-codex`
to open either menu directly. This is a **global login switch for the selected
provider in one Pi agent directory**. It does not select a model or change the
session's provider or thinking settings. Select an `openai/*` model separately
to use the new login.
Install it together with this repository's `codex-statusline` directory: it
provides the shared identity decoder and immediate quota updates. This directory is not
an independently packaged replacement for the third-party switcher.

## Menu

- **Import current Pi login**: appears when the current login is not saved;
  asks for confirmation before saving its latest credentials.
- **Add account / sign in again**: uses the selected provider's public OAuth
  implementation (Pi's native ChatGPT or legacy Codex flow). Open the
  displayed authorization URL (or use the offered device flow). During device
  login, press **Esc** or select **Cancel login** to stop polling; the waiting
  dialog closes automatically on completion or failure. Cancelling saves nothing
  and lets you reopen the account menu. A new authorization is saved without switching.
  Legacy Codex reauthorization of the active identity updates its active credentials;
  new ChatGPT sign-ins can create separate saved authorizations until selected.
- **Select a saved account**: confirms the global scope, preserves the current
  login's latest tokens, refreshes the target if needed, then changes the login.
  Selecting the current account is a no-op, never a restore of an older snapshot.

Reopen the menu after adding/importing an account. Legacy Codex shows the email
and account-ID suffix, with user/workspace identity unchanged. For new ChatGPT
logins, adding or importing asks for an email or account label. Pi's native flow
does not persist the ID token and permits opaque access tokens, so saved
authorizations are keyed by their issued OAuth `clientId`, which survives refresh.
Labels are display-only. Signing in again can create a separate saved authorization
even for the same person; names do not establish or merge account identity.
There are no automatic failovers, account deletions, renames, or batch quota queries.

Use this menu to add/switch accounts after setup. Directly replacing auth.json,
using another switcher, or running `/login openai` or `/login openai-codex` outside this workflow can
bypass snapshot synchronization; an older saved grant may then require sign-in
again. The third-party `pi-codex-account` store format is not migrated or overwritten.

## Scope and safety

- New and resumed sessions use the **current global login**, not a historical
  choice. No credential or selected-account preference is written to a session.
  Future requests send the existing visible conversation context under the selected
  account; switching does not clear conversations.
- Already-bound/in-flight requests retain their original account. Other running
  Pi processes observe the replaced credential on their next auth read.
- Management is TUI-only and requires the current Pi session to be idle. It does
  not stop requests in other processes. Runtime API-key overrides and nonstandard
  OpenAI/Codex backends are not supported. Replacing a stored OpenAI API key with
  a saved ChatGPT login requires explicit confirmation; API keys are not added to the vault.
- A legacy Codex switch notifies the existing quota extension; other TUI
  sessions detect the change through their regular auth checks. Its per-identity,
  shared five-minute quota cache remains intact.
- Normal Pi login storage is `auth.json`; independent account vaults are
  `<agent-dir>/codex-accounts.json` and `<agent-dir>/openai-accounts.json`,
  resolved with public `getAgentDir()`. Existing version-1 Codex vaults remain readable.
  Different agent directories are isolated.

The two providers require separate authorization. Old Codex credentials are never
copied into the new OpenAI login. New login and refresh use Pi's native OAuth and
preserve `clientId` and all scopes. The native `deviceId` comes from Pi's global
settings API; the installer preserves it, and it is never stored in this repository.

The vaults contain sensitive OAuth tokens. They are runtime-only, excluded from Git,
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

Tested against Pi **0.99.1**. Commands, dialogs, OAuth login/refresh, model registry
refresh and events use public APIs. The one compatibility dependency is filesystem
locking: Pi does not expose a public transaction spanning auth.json and a vault.
`store.ts` resolves **Pi's own `proper-lockfile` dependency** via `getPackageDir()`
and uses its `auth.json.lock`, `realpath:false` protocol. This serializes switching
with Pi's OAuth refresh, unlike an independent plugin lock. The lock is heartbeated,
and its ownership/cancellation is checked before committing. Revisit the dependency
and protocol on Pi upgrades. No private runtime objects are modified.

Pi 0.86.0 re-reads credentials when the auth file revision changes. Therefore the
extension neither fabricates `expires: 0` nor reloads the session on each switch.
It refreshes local model availability without network catalog requests.

## Tests and reference

The focused Node tests require Pi's host dependencies in module resolution; use a
disposable copy. They cover import/add/switch, cancellation, malformed stores,
refresh failure/rotation, real Pi auth-lock contention, and a second running Pi
auth runtime observing a switch without reload. ChatGPT tests exercise Pi's actual
native OAuth login and refresh with simulated token responses, opaque access tokens,
client/scopes preservation, and stable device IDs. `node --test install.test.ts`
checks installation identity and credential-vault preservation in a disposable directory.
Transport tests cover A/B/A replay
and an auth change after a request's token has already been bound. No real accounts
are used by the tests.

The global snapshot workflow was informed by
[fadilsflow/pi-codex-account](https://github.com/fadilsflow/pi-codex-account)
(MIT, reviewed at `35b77b8`); this is an independent implementation, not a vendored
copy. It adds shared auth locking, atomic commits, native OAuth addition, and
account-aware quota integration rather than its forced-expiry approach.
