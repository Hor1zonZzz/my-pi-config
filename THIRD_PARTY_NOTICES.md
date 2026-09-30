# Third-party notices

## Pi Coding Agent examples

Files adapted or copied from Pi's official extension examples include:

- `extensions/notify.ts`
- `extensions/questionnaire.ts`
- `extensions/tools.ts`
- `extensions/subagent/agents.ts` and parts of `extensions/subagent/runner.ts` (the rest of `extensions/subagent/` was rewritten for this repository)
- `extensions/subagent/agents/`
- `extensions/subagent/prompts/`

Upstream project: <https://github.com/earendil-works/pi>

License: see `licenses/pi-LICENSE`.

## pi-codex-account (design reference)

The global credential-snapshot workflow in `extensions/codex-accounts/` was
informed by [`pi-codex-account`](https://github.com/fadilsflow/pi-codex-account)
(MIT, reviewed at `35b77b8`). Its source is not vendored; this repository's
implementation uses native Pi OAuth, shared auth locking, and atomic commits.
The lock implementation is supplied by Pi's existing `proper-lockfile` runtime
dependency rather than copied into this repository.

## Herdr skill

`install.sh` downloads the Herdr `SKILL.md` from the upstream repository at
installation time; this repository does not vendor the downloaded skill.

Upstream project: <https://github.com/ogulcancelik/herdr>

The upstream repository states that Herdr is dual-licensed, including
AGPL-3.0-or-later for its open-source distribution. Consult its current
[`LICENSE`](https://github.com/ogulcancelik/herdr/blob/master/LICENSE) before
installing or redistributing the downloaded skill.
