# my-pi-config

My public, reproducible configuration for [Pi Coding Agent](https://github.com/earendil-works/pi).

## Included

- `settings.json` — model defaults and installable Pi packages
- `presets.json` — `quick`, `explore`, `orchestrator`, and `deep-code` presets
- `codex-fast.json` — global state for the local Codex priority toggle
- `skill-settings.json` — global default state for the skills manager
- `model-overrides.json` — managed, credential-free overrides for built-in models
- `extensions/` — local extensions; `extensions/subagent/` also owns its agent definitions and workflow prompts
- `skills/` — remote-managed skill caches; Herdr is refreshed from its upstream
  Git repository during installation
- `install.sh` — backup and install into `~/.pi/agent`

## Local extensions

- `preset.ts` — switch model, thinking level, tools, and instructions with
  `/preset`; embeds the active preset at the right of the input editor's top
  border while preserving Pi's scroll indicator
- `tools.ts` — interactive `/tools` selector
- `skills-manager/` — `/skills` controls model-visible skills globally, per session,
  and through presets
- `plan-mode/` — read-only planning mode
- `questionnaire.ts` — Pi's official interactive multi-question tool example
- `notify.ts` — terminal notification when an agent turn ends
- `subagent/` — Pi's official subagent example, adapted to OpenAI Codex models
- `codex-fast-toggle/` — `/fast on|off` toggles Codex priority service tier while keeping the provider identity as `openai-codex`
- `openai-response-compaction/` — `/compact-openai [instructions]` uses OpenAI
  Codex Responses native compaction for manual, threshold, and overflow
  compaction while preserving Pi's recent context window

## Install

Review the repository before running the installer. Extensions execute with the same permissions as Pi.

```bash
git clone https://github.com/Hor1zonZzz/my-pi-config.git
cd my-pi-config
./install.sh
```

The installer creates a timestamped backup under `~/.pi/agent/backups/` before
replacing managed files. It merges `model-overrides.json` into the target
`models.json`, preserving all unrelated local providers, credentials, and model
settings. It also refreshes the Herdr skill from upstream `master` and installs
it to `~/.pi/agent/skills/herdr/`; an existing local cache is used when the
remote is temporarily unavailable. Restart Pi or run:

```text
/reload
```

Package dependencies declared in `settings.json` are installed by Pi on startup. Authenticate separately; credentials are intentionally not included.

## Useful commands

```text
/preset
/tools
/skills
/plan
/fast
/compact-openai [instructions]
/implement <task>
/scout-and-plan <task>
/implement-and-review <task>
```

## Security

This repository intentionally excludes credentials, sessions, MCP configuration,
trust decisions, caches, history, `node_modules`, and Herdr-managed integration
files. Never commit `~/.pi/agent/auth.json` or the raw local `models.json`.

`model-overrides.json` is managed configuration, not a copy of `models.json`; it
contains only credential-free model overrides that the installer merges into the
local file.

`skill-settings.json` is managed configuration, not a secret. The skills manager hides
disabled skills from the model and blocks `/skill:<name>` expansion; it intentionally
does not block direct `read` access to known skill paths.

## Attribution and licenses

Several extensions and the subagent workflow are adapted from Pi's official examples. Pi's license is included at `licenses/pi-LICENSE`.

`codex-fast-toggle` derives its streaming approach from `pi-openai-codex-fast`; its upstream MIT license and README are included in that directory. See `THIRD_PARTY_NOTICES.md`.
