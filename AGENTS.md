# AGENTS.md

## Project Purpose

This repository is the source-controlled, reproducible version of a personal Pi Coding Agent configuration. It contains user-level settings, local extensions, subagent definitions, and reusable prompt templates that are installed into the Pi agent directory (normally `~/.pi/agent`).

This is a configuration repository, not the Pi Coding Agent source tree and not a standalone npm package. There is currently no project-level `package.json`, build system, or automated test suite. Pi itself provides the runtime and the extension host dependencies.

## Repository Map

- `settings.json` — global Pi defaults and Pi package dependencies.
- `presets.json` — named model, thinking-level, tool, and instruction presets.
- `codex-fast.json` — initial persisted state for the Codex priority-service toggle.
- `install.sh` — backs up the current user configuration and copies this repository's managed files into the Pi agent directory.
- `extensions/` — user-level TypeScript extensions loaded by Pi.
  - `preset.ts` — implements `/preset`, preset cycling, status display, and preset instruction injection.
  - `tools.ts` — implements the interactive `/tools` selector.
  - `plan-mode/` — implements read-only planning, plan extraction, and execution progress tracking.
  - `questionnaire.ts` — registers the TUI-only `questionnaire` tool for one or more interactive questions.
  - `notify.ts` — emits a terminal notification after an agent run ends.
  - `subagent/` — registers the `subagent` tool and launches isolated Pi subprocesses.
  - `codex-fast-toggle/` — implements `/fast on|off` and modifies Codex request payloads to select the priority service tier.
- `agents/` — user-level subagent definitions. The local versions select OpenAI Codex models.
- `prompts/` — slash-command workflow templates that compose the subagents.
- `licenses/`, `LICENSE`, and `THIRD_PARTY_NOTICES.md` — project and upstream licensing information.

## Important Relationships

Some files must be maintained together:

- `extensions/preset.ts`, `extensions/tools.ts`, and `presets.json` are coupled. The two extensions exchange `preset:tools-changed` and `tools:changed` events so that preset state, the active tool set, session persistence, and footer status remain synchronized.
- `extensions/subagent/index.ts`, `extensions/subagent/agents.ts`, `agents/*.md`, and `prompts/*.md` form one workflow. Agent names referenced by a prompt must exist in `agents/`.
- Model identifiers appear in `settings.json`, `presets.json`, and `agents/*.md`. When models are renamed or removed, inspect all three locations.
- `extensions/plan-mode/index.ts` and `extensions/plan-mode/utils.ts` must agree on state, plan markers, and the bash safety policy. If a question tool is renamed, update `PLAN_MODE_TOOLS` and the injected instructions.
- `extensions/codex-fast-toggle/index.ts`, `extensions/codex-fast-toggle/README.md`, and `codex-fast.json` define the Fast-mode behavior and state contract together.

## Upstream-Derived Code

Several files are copied from or adapted from Pi's official extension examples. Treat the upstream examples as references, not as files that can always be copied over blindly.

The following areas closely track official examples:

- `extensions/notify.ts`
- `extensions/plan-mode/`
- `extensions/questionnaire.ts`
- `extensions/subagent/`
- most of `extensions/preset.ts` and `extensions/tools.ts`
- `agents/` and `prompts/`

Local behavior that must be preserved during an upstream refresh includes:

- preset/tool-selector synchronization in `preset.ts` and `tools.ts`;
- OpenAI Codex model choices in `agents/*.md`;
- any local tool choices or instructions in `presets.json` and plan mode;
- the custom Codex Fast implementation and its retained upstream attribution.

When importing or substantially adapting more upstream code, keep the relevant license, update `THIRD_PARTY_NOTICES.md`, and document the derivation in the nearest README when appropriate.

## Pi Version Compatibility

Custom configuration and extension code may become incompatible when Pi Coding Agent changes. Do not assume that an extension that loaded on one Pi version will continue to load or behave correctly after an upgrade.

Before adapting code for a new Pi version:

1. Record the installed version with `pi --version`.
2. Read Pi's `CHANGELOG.md`, paying special attention to breaking changes and changes to extensions, the TUI, model/provider handling, sessions, tools, and JSON mode.
3. Read the installed version's relevant documentation, especially `docs/extensions.md`, `docs/tui.md`, `docs/prompt-templates.md`, and `docs/packages.md`.
4. Compare upstream example files under Pi's `examples/extensions/` with their local counterparts.
5. Inspect Pi's source code when documentation and changelog entries do not fully define runtime behavior. This is especially important for provider request payloads, event ordering, autocomplete behavior, session persistence, subprocess JSON events, and TUI component contracts.
6. Port upstream changes selectively and reapply the local behavior listed above.

The installed package normally contains `CHANGELOG.md`, `docs/`, and `examples/`. Locate it through the package manager used to install Pi; do not add machine-specific absolute package paths to this repository. The canonical upstream source is the Pi repository linked from `README.md`.

Prefer public exports from `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`. Avoid deep imports into Pi internals unless there is no public API. If an internal dependency is unavoidable, comment on why it is needed and expect to revisit it on every Pi upgrade.

### High-Risk Compatibility Areas

- `codex-fast-toggle` depends on the `before_provider_request` lifecycle and the provider-specific outgoing payload accepting `service_tier`. Verify the real request shape after provider/runtime changes.
- `subagent` depends on Pi CLI flags, LF-delimited JSON-mode events, message shapes, executable discovery, and subprocess cancellation behavior.
- `questionnaire`, `preset`, and `tools` depend on TUI component, key handling, autocomplete, theming, and invalidation contracts.
- `plan-mode` depends on tool names, lifecycle event ordering, session entries, active-tool restoration, and its bash allowlist. Treat the allowlist as a convenience guard, not a security boundary.
- `preset` depends on model registry lookup, thinking-level values, active-tool APIs, and session entry restoration.

## Editing Guidelines

- Make the smallest focused change and read the relevant extension and adjacent configuration before editing.
- Preserve TypeScript extension entry points as default exports.
- Keep tool schemas strict and use Pi's documented schema helpers, including `StringEnum` when required for provider compatibility.
- Keep TUI rendering width-safe, request a render after state changes, and invalidate cached themed output correctly.
- Preserve session-state compatibility where practical. If a persisted entry shape changes, either support the previous shape or clearly accept that old sessions will not restore it.
- Keep custom tool output bounded. Follow Pi's current output truncation guidance for potentially large results.
- Do not silently weaken project-agent confirmation or other trust boundaries in the subagent extension.
- Do not edit installed copies under `~/.pi/agent` as the primary change. Edit this repository, test it, and then install it.
- Update `README.md` and extension-specific READMEs when commands, installation behavior, user-visible state, or included resources change.

## Installer and State Boundaries

`install.sh` is intentionally state-aware:

- The target directory is `PI_CODING_AGENT_DIR`, then legacy `PI_AGENT_DIR`, then `~/.pi/agent`.
- Existing managed paths are backed up under `backups/my-pi-config-<timestamp>/` before copying.
- The installer preserves Pi-managed `settings.json.lastChangelogVersion` instead of tracking it in this repository.
- It removes the obsolete `extensions/question.ts`, then copies the current settings, presets, Fast state, extensions, agents, and prompts.
- It merges copied directory contents into the target; unrelated target files are not a reliable part of this repository's desired state.

`codex-fast.json` is both a repository default and mutable runtime state. Installing the repository seeds/replaces the target value; the extension later updates the target file atomically.

Never commit credentials or machine-local Pi state. In particular, keep `auth.json`, `models.json`, `mcp.json`, `trust.json`, sessions, caches, logs, backups, package installation directories, and environment files out of version control. Check `.gitignore` before adding any file copied from `~/.pi/agent`.

## Validation

There is no single test command. Run the checks relevant to the files changed.

Basic repository checks:

```bash
bash -n install.sh
node -e 'for (const f of ["settings.json", "presets.json", "codex-fast.json"]) JSON.parse(require("node:fs").readFileSync(f, "utf8"))'
git diff --check
```

For upstream-derived extension changes, diff against the same installed Pi version's example before and after editing. Distinguish upstream changes from intentional local changes instead of replacing an entire file.

Smoke-test extensions through Pi's extension loader. For an individual extension, prefer an isolated invocation such as:

```bash
pi --no-extensions -e ./extensions/<extension-file-or-directory>
```

For installer or cross-extension changes, use a disposable agent directory rather than overwriting the live configuration immediately:

```bash
TEST_AGENT_DIR="$(mktemp -d)/agent"
PI_CODING_AGENT_DIR="$TEST_AGENT_DIR" ./install.sh
PI_CODING_AGENT_DIR="$TEST_AGENT_DIR" pi
```

Perform applicable interactive checks:

- Pi starts without extension load errors and `/reload` succeeds.
- `/preset` applies model, thinking level, tools, instructions, and status correctly.
- `/tools` stays synchronized with the active preset and survives session/tree restoration.
- `/plan` blocks writes, preserves unrelated tools, extracts a plan, and restores the previous tool set before execution.
- `questionnaire` handles single, multiple, custom-text, cancellation, narrow-terminal, and non-TUI cases.
- `/fast on|off` persists state, appears only for `openai-codex`, updates status, and changes only the intended outgoing request field.
- `subagent` handles single, parallel, and chained calls, cancellation, failures, output limits, and project-agent confirmation.
- terminal notifications do not corrupt terminal output on supported terminals.

After testing in isolation, install into the live agent directory only when the diff and generated backup location have been reviewed.

## Completion Checklist

Before finishing a maintenance change:

1. Confirm that no secret or runtime-only file was added.
2. Recheck coupled files and user-facing documentation.
3. Run syntax/JSON checks and `git diff --check`.
4. Run the smallest relevant Pi smoke test.
5. Review the final diff for lost local changes from upstream-derived files.
6. Report the Pi version used for compatibility testing and any untested interactive behavior.
