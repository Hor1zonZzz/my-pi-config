# Third-party notices

## Pi Coding Agent examples

Files adapted or copied from Pi's official extension examples include:

- `extensions/notify.ts`
- `extensions/questionnaire.ts`

Upstream project: <https://github.com/earendil-works/pi>

License: see `licenses/pi-LICENSE`.

## pi-subagent

`settings.json` installs [`pi-subagent`](https://github.com/badlogic/pi-subagent)
as a Pi git package; `install.sh` only links its `subagent.ts` CLI into
`<agent-dir>/bin/`. This repository does not vendor its source.

## Herdr skill

`install.sh` downloads the Herdr `SKILL.md` from the upstream repository at
installation time; this repository does not vendor the downloaded skill.

Upstream project: <https://github.com/ogulcancelik/herdr>

The upstream repository states that Herdr is dual-licensed, including
AGPL-3.0-or-later for its open-source distribution. Consult its current
[`LICENSE`](https://github.com/ogulcancelik/herdr/blob/master/LICENSE) before
installing or redistributing the downloaded skill.
