# my-pi-config

My public, reproducible configuration for [Pi Coding Agent](https://github.com/earendil-works/pi).

English | [中文文档](README.zh-CN.md)

## Included

- `settings.json` — model defaults and installable Pi packages, including Pi Lens, the MCP adapter, and the Herdr tool integration
- `model-overrides.json` — managed, credential-free overrides for built-in models
- `extensions/` — local extensions; `extensions/subagent/` also owns its agent definitions and workflow prompts
- `prompts/` — local general-purpose prompt templates, including `/understand` and `/explore-understand` for manually controlled requirement alignment
- `skills/` — remote-managed skill caches; Herdr is refreshed from its upstream
  Git repository during installation
- `install.sh` — backup and install into `~/.pi/agent`

## Local extensions

- `plan-mode/` — read-only planning mode with guarded write-tool calls, a Bash allowlist, plan extraction, and execution progress tracking
- `questionnaire.ts` — Pi's official interactive multi-question tool example
- `notify.ts` — terminal notification when an agent turn ends
- `herdr/` — owns the local Herdr integration checker, asynchronous `herdr_agent prompt` monitor, and `herdr-pi-reference` skill source; it keeps explicit `wait: false` calls non-blocking and injects session-scoped completion follow-ups
- `subagent/` — Pi's official subagent example adapted with local model defaults, a `/subagent` model/thinking TUI, and optional `async: true` execution with steer completion; `/subagent-jobs` lists or cancels background work (see [details](extensions/subagent/README.md#background-execution))
- `codex-fast-toggle/` — native Pi `/fast on|off` command with Codex-only autocomplete and session-scoped priority tier; the Codex transport keeps ordinary and compaction routing hints aligned with the final tier without changing provider identity
- `codex-server-compaction/` — runs Pi's built-in text compaction and Codex Remote Compaction V2 in parallel, persists opaque native history, follows the current Fast service tier, and uses the Pi result on remote failure
- `codex-accounts/` — `/codex-accounts` imports, adds, and globally switches Codex subscription logins without changing the provider/model; credentials remain local and shared within one agent directory ([details](extensions/codex-accounts/README.md))
- `codex-statusline/` — automatically shows the current Codex account and weekly quota remaining in the TUI; sessions sharing an agent directory reuse a five-minute per-account/user quota cache ([details](extensions/codex-statusline/README.md))

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
settings. It also refreshes the Herdr skill from upstream `master`, installs it
to `~/.pi/agent/skills/herdr/`, and installs the Herdr-owned `herdr-pi-reference`
skill to `~/.pi/agent/skills/herdr-pi-reference/`; an existing Herdr cache is
used when the remote is temporarily unavailable. When Pi starts inside Herdr,
the local integration checker warns if Herdr's Pi integration is missing or
outdated; it never installs or updates the Herdr-managed integration
automatically. During migration the installer also backs up and removes the
former global `codex-fast.json` state file and the retired external
`pi-openai-server-compaction` Git package checkout; the repository-managed
Codex-only extension replaces that dependency. Restart Pi or run:

```text
/reload
```

Package dependencies declared in `settings.json` are installed by Pi on startup. Authenticate separately; credentials are intentionally not included.

## Useful commands

```text
/plan
/fast
/subagent
/understand [requirement]
/explore-understand [requirement]
/scout <task>
/implement <task>
/scout-and-plan <task>
/implement-and-review <task>
```

`/understand` clarifies the requirement directly. `/explore-understand` explicitly begins with focused, read-only repository exploration. Both wait for confirmation before implementation.

## Security

This repository intentionally excludes credentials, sessions, MCP configuration,
trust decisions, caches, history, `node_modules`, and Herdr-managed integration
files. Never commit `~/.pi/agent/auth.json` or the raw local `models.json`.

`model-overrides.json` is managed configuration, not a copy of `models.json`; it
contains only credential-free model overrides that the installer merges into the
local file.

## Attribution and licenses

Several extensions and the subagent workflow are adapted from Pi's official examples. Pi's license is included at `licenses/pi-LICENSE`.

`codex-fast-toggle` originally derived its Fast behavior from `pi-openai-codex-fast` and now uses Pi's native command and request hooks; its upstream MIT license and README are included in that directory.

`codex-server-compaction` is adapted from `pi-openai-server-compaction` by Alexis Gallagher under the MIT License. It retains the Codex V2 endpoint, parallel Pi/native compaction, persistence, and replay paths; its license and derivation notes are included in that directory. See `THIRD_PARTY_NOTICES.md`.
