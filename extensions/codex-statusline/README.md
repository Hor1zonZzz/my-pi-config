# Codex account and weekly quota status

English | [中文](README.zh-CN.md)

Automatically adds `person@example.com · weekly 82% left` to Pi's existing
footer while an `openai-codex` model is active in the TUI. There is no command
or configuration step. Other models and non-TUI sessions do not poll or display
this status. Existing Fast and other footer entries remain unchanged.

## Account and quota

- Uses Pi's public `ctx.modelRegistry.getApiKeyAndHeaders()` to resolve current
  request authentication, including Pi-managed OAuth refresh. It does not read
  Codex CLI's login files, manage accounts, or switch credentials.
- Displays the full email from the resolved token when available, otherwise
  `acct-<last eight account ID characters>`. The label is terminal-sanitized.
- Queries `GET https://chatgpt.com/backend-api/wham/usage` with that token and
  account ID, not local session token counts or estimated costs.
- Uses only the ordinary `rate_limit` bucket, not additional model-specific
  limits. Searches both windows for a duration within 5% of seven days and
  displays rounded, clamped `100 - used_percent` as the remaining percentage.
- Like the CLI, an unspecified secondary-window duration can serve as the
  fallback. Unlike the CLI's general-purpose limit label, this weekly-only
  display refuses to label an explicitly non-weekly secondary window weekly.
- Unsupported custom/proxy endpoints, missing credentials, or absent weekly
  data display `weekly unavailable`. Credentials are never forwarded from a
  custom endpoint to ChatGPT. API-key billing and other backends are out of scope.

This percentage describes the server's rolling window; it is not a calendar-week
budget, five-hour limit, reset countdown, or promise that the next request is allowed.

The separate [`codex-accounts`](../codex-accounts/README.md) extension can switch
the global login. This statusline receives its local change event; other Pi
processes detect the new identity on their normal auth checks. Neither path
bypasses the new account's existing five-minute quota cache.

## Shared refresh

The cache lives at `<Pi agent directory>/cache/codex-statusline/`, using Pi's
public `getAgentDir()` (normally `~/.pi/agent`, overridden by
`PI_CODING_AGENT_DIR`). All projects/processes using this directory share it;
separate agent directories remain isolated.

- The first TUI session queries if no fresh cache exists. Other sessions reuse
  the result, including when newly started or switching back to Codex.
- One attempt per account/user identity per **five minutes**, including failed
  attempts. Different users of the same workspace do not share quota data.
- Each TUI checks auth and the local cache every **15 seconds**, and at agent
  start/settled events. These local checks are not independent quota requests;
  OAuth refresh, when required, is still owned by Pi. Shared updates and external
  account changes appear on the next local check (subject to auth resolution).
- A cross-process directory lock combines concurrent refreshes. Cache writes
  are atomic. The retry deadline is persisted before the request so a crashed
  querying process does not cause an immediate retry storm. Dead process locks
  are recovered on subsequent checks; live locks are not forcibly stolen.
- Requests time out after 15 seconds, reject redirects, and limit response bodies
  to 64 KiB. No model inference request is needed to obtain quota.
- Failed refreshes retain the last percentage with `(stale)`; without old data,
  show `unavailable`. Reset/expired data is also marked stale, never guessed to be
  100%. Initial/in-flight requests show `loading` briefly.
- Model/session changes, reload, and shutdown cancel local work. Once an account
  change is detected, old results cannot update the new account's footer.

The cache stores only a hashed identity, quota, timestamps, and a generic request
state. It does **not** store emails, tokens, response bodies, or backend error
messages. Cache files use mode `0600`, new cache directories `0700`. There is no
session-history entry, background daemon, or cross-machine synchronization.

## Validation

`quota.test.ts` and `cache.test.ts` run with Node 24's native TypeScript support:

```sh
node --test extensions/codex-statusline/quota.test.ts extensions/codex-statusline/cache.test.ts
```

`index.test.ts` and TypeScript checking additionally need the installed Pi host
packages in module resolution. Use a disposable copy with those dependencies,
not a new dependency installation or credentials in this repository. Tests cover
separate-process deduplication, crashed-lock recovery, failure cooldowns, account
isolation, late results, and lifecycle cleanup without calling the real backend.

Interactive checks: start/reload Pi, switch Codex/non-Codex models, check a narrow
terminal, and open multiple sessions to verify the shared quota display. This
extension does not guarantee backend availability or faster model responses.

## Reference

Independently implemented using OpenAI Codex CLI as a protocol/display reference
(local checkout `38cbebaf3f`):

- `codex-rs/backend-client/src/client/rate_limit_resets.rs`
- `codex-rs/tui/src/chatwidget/status_surfaces.rs`
- `codex-rs/tui/src/chatwidget/status_controls.rs`
- `codex-rs/tui/src/chatwidget/rate_limits.rs`

Upstream: <https://github.com/openai/codex> (Apache-2.0). No Codex source is
vendored. Pi's official `status-line.ts` / `model-status.ts` examples and
`docs/extensions.md` define the extension integration. This implementation keeps
our fixed five-minute refresh, rather than the CLI's adaptive 60/30/15/5-second
polling. The backend usage API is an upstream implementation detail and may change.
