# Third-party notices

## Pi Coding Agent examples

Files adapted or copied from Pi's official extension examples include:

- `extensions/notify.ts`
- `extensions/questionnaire.ts`
- `extensions/subagent/agents.ts` and parts of `extensions/subagent/runner.ts` (the rest of `extensions/subagent/` was rewritten for this repository)
- `extensions/subagent/agents/`
- `extensions/subagent/prompts/`

Upstream project: <https://github.com/earendil-works/pi>

License: see `licenses/pi-LICENSE`.

## pi-openai-codex-fast

`extensions/codex-fast-toggle/` originally derived its fast-mode behavior from `pi-openai-codex-fast` by Kaan Ozdokmeci / 2h2d-co.

Upstream project: <https://github.com/2h2d-co/pi-openai-codex-fast>

License and upstream README are retained in `extensions/codex-fast-toggle/`.

## pi-codex-account (design reference)

The global credential-snapshot workflow in `extensions/codex-accounts/` was
informed by [`pi-codex-account`](https://github.com/fadilsflow/pi-codex-account)
(MIT, reviewed at `35b77b8`). Its source is not vendored; this repository's
implementation uses native Pi OAuth, shared auth locking, and atomic commits.
The lock implementation is supplied by Pi's existing `proper-lockfile` runtime
dependency rather than copied into this repository.

## pi-openai-server-compaction

`extensions/codex-server-compaction/` is a Codex-only adaptation of
`pi-openai-server-compaction` by Alexis Gallagher. It retains the upstream
Remote Compaction V2 protocol, parallel Pi/native compaction, persisted-history,
and replay design while removing direct OpenAI and Azure support and porting
the result to the installed Pi extension API.

The cached `openai-codex` WebSocket/SSE provider, canonical session continuity,
and raw V2 output handling under `vendor/howaboua/` are adapted from
`@howaboua/pi-codex-conversion` by Igor Warzocha and contributors. Tool, prompt,
voice, Code Mode, Notebook, Responses Lite, UI, and cache-keepalive features are
excluded, and their vendor-only implementation paths are not retained.

Upstream projects:

- <https://github.com/algal/pi-openai-server-compaction>
- <https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion>

Licenses:

- `extensions/codex-server-compaction/LICENSE`
- `extensions/codex-server-compaction/vendor/howaboua/LICENSE`

## Herdr skill

`install.sh` downloads the Herdr `SKILL.md` from the upstream repository at
installation time; this repository does not vendor the downloaded skill.

Upstream project: <https://github.com/ogulcancelik/herdr>

The upstream repository states that Herdr is dual-licensed, including
AGPL-3.0-or-later for its open-source distribution. Consult its current
[`LICENSE`](https://github.com/ogulcancelik/herdr/blob/master/LICENSE) before
installing or redistributing the downloaded skill.
