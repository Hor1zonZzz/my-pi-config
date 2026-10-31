# AGENTS.md

## Project Purpose

This repository is the source-controlled, reproducible version of a personal Pi Coding Agent configuration. It contains user-level settings, local extensions, and reusable prompt templates that are installed into the Pi agent directory (normally `~/.pi/agent`).

This is a configuration repository, not the Pi Coding Agent source tree and not a standalone npm package. There is no project-level `package.json`, build system, or unified test command; individual extensions have focused Node tests. Pi itself provides the runtime and the extension host dependencies.

## Repository Map

- `settings.json` — global Pi defaults and Pi package dependencies, including the external `pi-subagent` git package that provides subagents and the `pi-cliproxyapi-provider` npm package that registers CLIProxyAPI models.
- `install.sh` — backs up the current user configuration, refreshes the Herdr
  skill cache, and copies managed files into the Pi agent directory.
- `prompts/` — local general-purpose prompt templates installed as global slash commands.
- `skills/` — remote-managed skill caches; `install.sh` refreshes Herdr from
  its upstream Git repository and installs it to the target Pi skills directory.
- `extensions/` — user-level TypeScript extensions loaded by Pi.
  - `questionnaire.ts` — registers the TUI-only `questionnaire` tool for one or more interactive questions.
  - `notify.ts` — emits a terminal notification after an agent run ends.
  - `herdr/` — owns the repository-managed Herdr integration checker, the asynchronous official `herdr_agent prompt` monitor, and the source for the installed `herdr-pi-reference` skill. It uses the public Herdr CLI and does not modify Herdr-managed integration files.
    - `prompts/` — the upstream slash-command workflow templates.
  - `background-task/` — creates a per-session scratchpad under `<agent-dir>/scratchpad/<session-id>/`, adds it to the system prompt, and registers the `background_task` tool and `/bg` command, which run shell commands without blocking the agent loop and steer their exit back into the owning session.
  - `codex-statusline/` — displays the current Codex account and weekly quota in the TUI (and, for the `openai` ChatGPT login, its `/v1/me` email, the same-email Codex login's weekly quota, and a reached usage limit), with a credential-free five-minute cache and cross-process query lock shared within one Pi agent directory.
- `licenses/`, `LICENSE`, and `THIRD_PARTY_NOTICES.md` — project and upstream licensing information.

## Important Relationships

Some files must be maintained together:

- `settings.json` lists `git:github.com/badlogic/pi-subagent`, and `install.sh` links its CLI into `<agent-dir>/bin/subagent`; keep the package path in both.
- `install.sh` `LATEST_PACKAGES` (Pi Voice, `pi-subagent`, `pi-cliproxyapi-provider`) must name unpinned sources that `settings.json` lists; `install.test.ts` checks both.
- `extensions/herdr/` owns `integration-check.ts`, the background-monitor modules, and `skills/herdr-pi-reference/`; `install.sh` must install that skill into the target skills directory and remove the former standalone extension paths. `herdr-agent-state.ts` is installed and overwritten by Herdr. The local extension may use documented Herdr CLI behavior but must not vendor, import, modify, install, or update the Herdr-managed integration. The background monitor is session-scoped and must not deliver a completion to a replacement Pi session.

## Upstream-Derived Code

Several files are copied from or adapted from Pi's official extension examples. Treat the upstream examples as references, not as files that can always be copied over blindly.

The following areas closely track official examples:

- `extensions/notify.ts`
- `extensions/questionnaire.ts`

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

- `pi-subagent` is an external git package (`git:github.com/badlogic/pi-subagent`, unpinned) that depends on tmux, Node.js 22.19+ running its `.ts` CLI directly, Pi installing git packages under `<agent-dir>/git/<host>/<path>`, and Pi prepending `<agent-dir>/bin` to the bash `PATH`. If the package moves or its CLI file is renamed, update `settings.json` and the `install.sh` link together. Its run state lives under `<agent-dir>/subagents/`; the former local extension's `<agent-dir>/subagent-sessions/` is left untouched.
- `pi-cliproxyapi-provider` is an unpinned external npm package updated on every install. It stores its `baseUrl`/`apiKey` in `<agent-dir>/cliproxyapi.json` and its model catalog in `<agent-dir>/cliproxyapi-models.json`; both are runtime-only, ignored by git, and never installed. It also ships its own TPS status extension alongside `extensions/tps.ts`.
- `extensions/herdr/` background monitoring depends on the official `herdr_agent` tool-result shape, Herdr's public `agent get` JSON response and lifecycle states, Pi session IDs, cancellable `pi.exec`, and `agent_settled` follow-up delivery. It must remain separate from the Herdr-managed Pi state extension and cannot provide prompt-level attribution when multiple Pi sessions share one target pane.
- `codex-statusline` depends on public Pi auth resolution, Codex JWT account/profile claims, the `/wham/usage` response shape, session/model lifecycle events, and atomic local filesystem operations; for the `openai` ChatGPT login also the `api.openai.com/v1/me` `email` field, the token's `sub`/`client_id` claims, `after_provider_response` firing only on success, and the `subscription_sharing_usage_limit_exceeded` code (with optional `resets_at`) in the assistant `errorMessage`. Preserve account/user cache isolation, the shared five-minute failure cooldown, no polling outside Codex or `openai` ChatGPT-login TUI sessions, borrowing Codex quota only for a matching email, and rejection of late account/session results. It is not an account manager.
- `background-task` depends on the public `createLocalBashOperations()` backend (shell resolution, `PATH`, detached process groups tracked and killed by Pi on exit), `getAgentDir()`, `before_agent_start` `systemPromptOptions.sections`, `pi.sendMessage()` `steer`/`triggerTurn` delivery, and `session_shutdown` on reload and session replacement. Its core modules must stay free of Pi imports so `node --test` can run them.
- `questionnaire` depends on TUI component, key handling, autocomplete, theming, and invalidation contracts.

## Editing Guidelines

- Make the smallest focused change and read the relevant extension and adjacent configuration before editing.
- Preserve TypeScript extension entry points as default exports.
- Keep tool schemas strict and use Pi's documented schema helpers, including `StringEnum` when required for provider compatibility.
- Keep TUI rendering width-safe, request a render after state changes, and invalidate cached themed output correctly.
- Preserve session-state compatibility where practical. If a persisted entry shape changes, either support the previous shape or clearly accept that old sessions will not restore it.
- Keep custom tool output bounded. Follow Pi's current output truncation guidance for potentially large results.
- Do not edit installed copies under `~/.pi/agent` as the primary change. Edit this repository, test it, and then install it.
- Update `README.md` and extension-specific READMEs when commands, installation behavior, user-visible state, or included resources change.

## Installer and State Boundaries

`install.sh` is intentionally state-aware:

- The target directory is `PI_CODING_AGENT_DIR`, then legacy `PI_AGENT_DIR`, then `~/.pi/agent`.
- Existing managed paths are backed up under `backups/my-pi-config-<timestamp>/` before copying.
- The installer preserves Pi-managed `settings.json.lastChangelogVersion`, the ChatGPT OAuth installation `deviceId`, and the user's local `defaultProvider`/`defaultModel` instead of tracking them in this repository. `settings.json` must not set a default model.
- It does not set a default model or model overrides and never modifies the target `models.json`.
- It removes obsolete extension paths and state, including the former standalone Preset extension and skill, the retired `extensions/tools.ts` `/tools` example, `extensions/plan-mode/`, `extensions/code-mode/`, `extensions/hairline/`, `extensions/codex-fast-toggle/`, `extensions/codex-server-compaction/`, and `extensions/codex-accounts/`, the former local `extensions/subagent/` with its installed `planner`/`reviewer`/`scout`/`worker` agents and `implement`/`implement-and-review`/`scout`/`scout-and-plan` prompts, `subagent-settings.json`, the retired `explore-and-gather` prompt, the former global `codex-fast.json` state, and the retired `git/github.com/algal/pi-openai-server-compaction` package checkout before copying the current settings, local extensions, local general-purpose prompts, and refreshed Herdr-owned skills.
- It links `<agent-dir>/bin/subagent` to `../git/github.com/badlogic/pi-subagent/subagent.ts`, the `pi-subagent` git package checkout Pi creates from `settings.json`; Pi prepends `<agent-dir>/bin` to the bash tool's `PATH`. The link dangles until Pi installs the package.
- It then runs `pi update --extension <source> --no-approve` with the target `PI_CODING_AGENT_DIR` for each `LATEST_PACKAGES` entry, installing missing packages and moving unpinned ones to their newest release. A missing `pi` or a failed update prints a warning and does not fail the install.
- It merges copied directory contents into the target; unrelated target files are not a reliable part of this repository's desired state.

The installer backs up and removes the former global `codex-fast.json` left by the retired Fast extension.

`codex-accounts.json` and `openai-accounts.json` are sensitive credential vaults left by the retired `/codex-accounts` extension. The installer must leave them untouched; never copy them into the repository or session history. `auth.json` is the only authority for each provider's globally active login.

`background-task` keeps per-session scratchpads (including background task logs and metadata) under `<agent-dir>/scratchpad/`. They are runtime-only, pruned after 14 days without use, and must not be installed from or committed to this repository.

`codex-statusline` intentionally shares quota snapshots and query coordination under `<agent-dir>/cache/codex-statusline/`. This cache is runtime-only, contains no credentials or email labels, and must not be installed from or committed to this repository.

Never commit credentials or machine-local Pi state. In particular, keep `auth.json`, `models.json`, `mcp.json`, `trust.json`, sessions, caches, logs, backups, package installation directories, and environment files out of version control. Check `.gitignore` before adding any file copied from `~/.pi/agent`.

## Validation

There is no single test command. Run the checks relevant to the files changed.

Basic repository checks:

```bash
bash -n install.sh
node -e 'JSON.parse(require("node:fs").readFileSync("settings.json", "utf8"))'
git diff --check
```

For installer changes, `node --test install.test.ts` checks stable ChatGPT device
identity, runtime settings, and the retired credential vaults using a disposable install.

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
- `background-task` returns immediately, steers a normal exit into a busy or idle session, reports deliberate `SIGTERM`/`/bg stop` exits without waking the model, keeps tasks alive across Esc, and kills them silently on reload, session replacement, and quit.
- `questionnaire` handles single, multiple, custom-text, cancellation, narrow-terminal, and non-TUI cases.
- `extensions/herdr/` background monitoring is a no-op outside Herdr; tracks only successful explicit `herdr_agent prompt` calls with `wait: false`; delivers grouped, bounded follow-ups to the owning session after `done`, post-working `idle`, or `blocked`; and cancels cleanly on session replacement, reload, and shutdown.
- `codex-statusline` displays full email (or a short account ID) and ordinary weekly remaining percentage only in Codex TUI sessions, and for the `openai` ChatGPT login the `/v1/me` email, `plan weekly … (via Codex)` only when the legacy Codex login has the same email, and `limit reached` only after the usage-limit error until a successful response; multiple processes sharing an agent directory issue one quota attempt per identity per five minutes, including failures; dead query owners are recoverable; stale/absent data is not shown as fresh or fabricated; account changes and lifecycle cleanup reject late results; other footer statuses remain intact.
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
