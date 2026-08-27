# Third-party notices

## Pi Coding Agent examples

Files adapted or copied from Pi's official extension examples include:

- `extensions/notify.ts`
- `extensions/plan-mode/`
- `extensions/questionnaire.ts`
- `extensions/subagent/`
- `extensions/subagent/agents/`
- `extensions/subagent/prompts/`

Upstream project: <https://github.com/earendil-works/pi>

License: see `licenses/pi-LICENSE`.

## pi-openai-codex-fast

`extensions/codex-fast-toggle/` originally derived its fast-mode behavior from `pi-openai-codex-fast` by Kaan Ozdokmeci / 2h2d-co.

Upstream project: <https://github.com/2h2d-co/pi-openai-codex-fast>

License and upstream README are retained in `extensions/codex-fast-toggle/`.

## pi-openai-server-compaction

`extensions/codex-server-compaction/` is a Codex-only adaptation of
`pi-openai-server-compaction` by Alexis Gallagher. It retains the upstream
Remote Compaction V2 protocol, parallel Pi/native compaction, persisted-history,
and replay design while removing direct OpenAI, Azure, and custom transport support and
porting the result to the installed Pi extension API.

Upstream project: <https://github.com/algal/pi-openai-server-compaction>

License: see `extensions/codex-server-compaction/LICENSE`.

## Herdr skill

`install.sh` downloads the Herdr `SKILL.md` from the upstream repository at
installation time; this repository does not vendor the downloaded skill.

Upstream project: <https://github.com/ogulcancelik/herdr>

The upstream repository states that Herdr is dual-licensed, including
AGPL-3.0-or-later for its open-source distribution. Consult its current
[`LICENSE`](https://github.com/ogulcancelik/herdr/blob/master/LICENSE) before
installing or redistributing the downloaded skill.
