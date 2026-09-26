# AGENTS.md

## Project Purpose

This repository is the source-controlled, reproducible version of a personal Pi Coding Agent configuration. It contains user-level settings, local extensions, subagent definitions, and reusable prompt templates that are installed into the Pi agent directory (normally `~/.pi/agent`).

This is a configuration repository, not the Pi Coding Agent source tree and not a standalone npm package. There is no project-level `package.json`, build system, or unified test command; individual extensions have focused Node tests. Pi itself provides the runtime and the extension host dependencies.

## Repository Map

- `settings.json` — global Pi defaults and Pi package dependencies.
- `model-overrides.json` — credential-free overrides merged into the local `models.json`.
- `install.sh` — backs up the current user configuration, refreshes the Herdr
  skill cache, and copies managed files into the Pi agent directory.
- `prompts/` — local general-purpose prompt templates installed as global slash commands.
- `skills/` — remote-managed skill caches; `install.sh` refreshes Herdr from
  its upstream Git repository and installs it to the target Pi skills directory.
- `extensions/` — user-level TypeScript extensions loaded by Pi.
  - `questionnaire.ts` — registers the TUI-only `questionnaire` tool for one or more interactive questions.
  - `notify.ts` — emits a terminal notification after an agent run ends.
  - `herdr/` — owns the repository-managed Herdr integration checker, the asynchronous official `herdr_agent prompt` monitor, and the source for the installed `herdr-pi-reference` skill. It uses the public Herdr CLI and does not modify Herdr-managed integration files.
  - `subagent/` — this repository's subagent implementation: single/parallel/chain delegation to `pi` subprocesses, sync or `async: true` background jobs, persisted child sessions under `<agent-dir>/subagent-sessions/`, the read-only `subagent_control` tool (list/inspect/read/wait over this parent session's live and on-disk runs), a below-editor run panel with keyboard selection, live transcript and `/subagent-history` overlays, strict project-agent confirmation, and the `/subagent` TUI that updates user-agent model/thinking frontmatter. `agents.ts` and part of `runner.ts` are derived from Pi's example.
    - `agents/` — user-level subagent definitions.
    - `prompts/` — the upstream slash-command workflow templates.
  - `codex-fast-toggle/` — implements `/fast on|off` and modifies Codex request payloads to select the priority service tier.
  - `codex-accounts/` — `/codex-accounts` imports/adds Codex OAuth accounts and switches the global login without changing provider identity; transactions share Pi's auth-file lock and keep credentials out of sessions.
  - `codex-statusline/` — displays the current Codex account and weekly quota in the TUI, with a credential-free five-minute cache and cross-process query lock shared within one Pi agent directory.
  - `codex-server-compaction/` — runs Pi's built-in text compaction alongside Codex-only Remote Compaction V2, persists provider-native replacement history in compaction details, inherits the session Fast tier, and uses the Pi result when the remote request fails.
  - `code-mode/` — `/tools` turns registered tools on/off and switches code mode (also `/code-mode on|off`, `--code-mode`); code mode moves the enabled built-in tools (`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`) into a single `execute_code` tool whose JavaScript or Python programs call them through a JSON-lines bridge on fds 3/4, and only printed output returns to the model. On macOS, programs run in a Seatbelt sandbox (`sandbox.ts`) with no file, network, or process access except through the tools. `execute_code` accepts one language at a time (JavaScript by default, or Python) and has no `language` parameter. The selection (`codeMode`, `language`, `sandbox`, the built-ins that are on, and other tools turned off) is a `tools-state` session custom entry.
  - `hairline/` — the Hairline TUI skin: custom header, a `CustomEditor` that restyles only the top and bottom rules and embeds Pi's working/retry/compaction indicators, a one-line footer that keeps every extension status, a HUD widget with reply speed and the Codex weekly quota bar, `/hairline on|off|hud on|off`, and re-registered `read`/`bash`/`edit`/`write` with one-line renderers whose execution delegates to Pi's built-in definitions.
- `licenses/`, `LICENSE`, and `THIRD_PARTY_NOTICES.md` — project and upstream licensing information.

## Important Relationships

Some files must be maintained together:

- `extensions/subagent/` modules, `README.md`/`README.zh-CN.md`, `agents/*.md`, and `prompts/*.md` form the subagent workflow. Agent names referenced by a prompt must exist in `extensions/subagent/agents/`; `config.ts` and the `agents.ts` frontmatter parser must agree on `model` and `thinkingLevel`. The tool's parameter schema is what the prompts and agents rely on; keep it stable. `RunSnapshot` (`runs.ts`) is persisted in tool details, completion messages, and `*.meta.json`; `render.ts` also reads the previous version's `results` details, so keep both shapes readable.
- Model identifiers appear in `settings.json`, `extensions/subagent/agents/*.md`, and `model-overrides.json`. When models are renamed or removed, inspect all three locations.
- `extensions/codex-fast-toggle/index.ts`, `extensions/codex-server-compaction/`, `settings.json`, `install.sh`, and their English/Chinese documentation define session-scoped Fast behavior and Codex remote compaction. The compaction extension reads the latest `codex-fast` custom entry so V2 requests inherit `service_tier: "priority"`, while the installer removes both the former global Fast state and the retired external compaction package checkout.
- `extensions/codex-accounts/`, `codex-statusline/`, and `codex-server-compaction/` share the pure account fingerprint decoder in `codex-statusline/quota.ts`. Global switches notify the local quota display. Compaction replay must use the actual bound request token, not a new global auth lookup; opaque history and cached continuations must remain account-isolated, including A/B/A and untagged legacy artifacts.
- `extensions/hairline/tools.ts` owns the `read`, `bash`, `edit`, and `write` tool names. Another extension that re-registers one of them would replace Hairline's override (or be replaced by it); keep a single owner. The overrides must copy Pi's model-facing definition unchanged and build execution with the same settings-derived options Pi's `AgentSession` uses; tool-name guards keep working because the names do not change. The footer replaces Pi's footer, so it must keep rendering `setStatus()` text from `codex-statusline`, `codex-fast-toggle`, `code-mode`, `subagent`, and `herdr`. The HUD's weekly bar parses `codex-statusline`'s `codex-quota` status (`weekly N% left`, `(stale)`, `loading`, `unavailable`); change `formatStatus()` and `hairline/format.ts` `parseWeekly()` together — `hairline/index.test.ts` checks them against each other.
- `extensions/subagent/notices.ts` persists a one-line `<subagent_notification>` custom message when a run of a multi-run background job finishes while the job continues. `extensions/codex-server-compaction/remote-compaction.ts` keys on the same tag to keep these notices out of V2 retained user messages; change the tag in both.
- `extensions/code-mode/` owns the `/tools` command and the built-in part of the active tool set. For other tools it enforces only explicit offs and otherwise preserves the activation that Pi and their extension chose, because `pi-mcp-adapter` keeps lazy MCP direct tools inactive until a search activates them; do not make it force every non-off tool active. It re-registers `execute_code` whenever the built-ins inside it, the sandbox, or the language change so the description, API reference, snippet, guidelines, and parameter schema cover exactly that set and describe only the chosen language. It does not register the built-in tool names; it only deactivates them, so it composes with `hairline/`'s overrides. It builds its own built-in instances with the same settings-derived options as `hairline/tools.ts` `createBaseTool()`; keep both in step with `AgentSession`. `sandbox.ts` owns the Seatbelt profile; it must keep denying network, process fork/exec (except the interpreter root), signals to others, Mach lookups, Apple Events, writes outside the run directory, and file-content reads under `/Users`, `/Volumes`, and shared temp directories, must reject interpreter roots that contain the home directory, must fail closed off macOS, and must pass paths as `-D` parameters. `sandbox.test.ts` probes those rules with real programs; re-run it after any change. `runtime.ts`, `prelude.mjs`, and `prelude.py` share the fd 3/4 JSON-lines protocol (`{id, tool, args}` → `{id, ok, text|error}`) and the `PI_CODE_MODE_TOOLS` environment variable; change them together.
- `extensions/herdr/` owns `integration-check.ts`, the background-monitor modules, and `skills/herdr-pi-reference/`; `install.sh` must install that skill into the target skills directory and remove the former standalone extension paths. `herdr-agent-state.ts` is installed and overwritten by Herdr. The local extension may use documented Herdr CLI behavior but must not vendor, import, modify, install, or update the Herdr-managed integration. The background monitor is session-scoped and must not deliver a completion to a replacement Pi session.

## Upstream-Derived Code

Several files are copied from or adapted from Pi's official extension examples. Treat the upstream examples as references, not as files that can always be copied over blindly.

The following areas closely track official examples:

- `extensions/notify.ts`
- `extensions/questionnaire.ts`
- `extensions/subagent/agents.ts`, `extensions/subagent/agents/`, and `extensions/subagent/prompts/` (the rest of `extensions/subagent/` is this repository's own implementation)

Local behavior that must be preserved during an upstream refresh includes:

- local model choices in `extensions/subagent/agents/*.md`;
- strict confirmation before running project-local agents, even in trusted projects;
- the `/subagent` user-agent model/thinking TUI and its available/scoped-model filtering;
- the custom Codex Fast implementation and its retained upstream attribution;
- the Codex-only compaction scope, parallel Pi/native requests, V2 `/codex/responses` plus `compaction_trigger` protocol, exact-model replay isolation, text fallback, installation-id behavior, and retained upstream MIT attribution.

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

- `codex-fast-toggle` depends on session custom entries, session/tree lifecycle events, the `before_provider_request` lifecycle, and the provider-specific outgoing payload accepting `service_tier`. Verify session restoration and the real request shape after provider/runtime changes.
- `codex-server-compaction` overrides only the `openai-codex` stream provider and depends on the normalized `TranscriptContext` provider input, compaction/session/tree lifecycle events, cached WebSocket/SSE recovery, canonical raw request/response continuity, `before_provider_request` transform chaining with Fast, V2 `compaction_trigger` output capture, Codex OAuth/header/proxy shape, compaction usage accounting, and exact-model persisted replay. Since Pi 0.86.0 the system prompt and tool declarations are carried by the transcript's system messages, so the vendored provider must resolve them from `context.messages`; reading the retired `context.systemPrompt`/`context.tools` fields fails silently with a placeholder prompt and no tools. `transcript-context.test.ts` checks the built request body against the installed Pi Codex provider and must be re-run on every Pi upgrade. It creates or reuses `$CODEX_HOME/installation_id` (normally `~/.codex/installation_id`) at runtime but must never copy that machine identity into this repository.
- `subagent` depends on the `pi --mode rpc` CLI with `--session-dir`/`--session-id`/`--name`/`--model`/`--thinking`/`--tools`/`--append-system-prompt`, the RPC `prompt` (task delivery and its `success: false` rejection) and `abort` commands, orderly exit when stdin closes, `extension_ui_request` dialogs that block until an `extension_ui_response` (answered `cancelled: true`), LF-delimited session events (`message_*`, `tool_execution_*`, `auto_retry_start`, `compaction_start`, `agent_settled`), child extensions seeing `hasUI: true` in RPC mode, the `PI_SUBAGENT_CHILD` marker that blocks nested async dispatch, message shapes, the child session file name `<timestamp>_<id>.jsonl`, executable discovery, subprocess cancellation, model availability/scoping, `ctx.ui.onTerminalInput()` running before the focused component, the concrete TUI's `getFocusedComponent()` and the main editor's `actionHandlers` (panel focus detection), below-editor widgets, overlay `ctx.ui.custom()`, TUI selection contracts, and mutable user-agent frontmatter. It is no longer re-copied from Pi's example; compare the example only for `agents.ts`, agents, and prompts. Load it for manual checks with `-e ./extensions/subagent/index.ts` (the directory form is treated as a package because of `prompts/`).
- `extensions/herdr/` background monitoring depends on the official `herdr_agent` tool-result shape, Herdr's public `agent get` JSON response and lifecycle states, Pi session IDs, cancellable `pi.exec`, and `agent_settled` follow-up delivery. It must remain separate from the Herdr-managed Pi state extension and cannot provide prompt-level attribution when multiple Pi sessions share one target pane.
- `codex-accounts` uses public command/OAuth APIs but relies on Pi's installed `proper-lockfile` dependency and `auth.json.lock` (`realpath:false`) protocol because no public extension auth transaction exists. Recheck this protocol and auth-file revision detection on Pi upgrades. Preserve lock serialization with OAuth rotation, vault-before-auth atomic writes, same-account no-op, cancellation, and global—not session-specific—selection. Never force `expires: 0` or replace the provider.
- `codex-statusline` depends on public Pi auth resolution, Codex JWT account/profile claims, the `/wham/usage` response shape, session/model lifecycle events, and atomic local filesystem operations. Preserve account/user cache isolation, the shared five-minute failure cooldown, no polling outside Codex TUI sessions, and rejection of late account/session results. It is not an account manager.
- `hairline` depends on `CustomEditor`'s protected `renderTopBorder()`/`renderBottomBorder()` hooks, `embedWorkingStatus` and the unexported status indicator's `kind`/`renderInBorder()`, header/footer/widget factories, `ReadonlyFooterDataProvider`, the tool-renderer contract (`renderShell: "self"`, shared `context.state`, `lastComponent`), Pi's own tool renderers and their private state (the bash renderer's refresh interval is settled by passing it the final result), `createReadToolDefinition()`/`createBashToolDefinition()` options mirrored from `AgentSession`, `SettingsManager.create()` with `ctx.isProjectTrusted()`, message/tool lifecycle events for speed and working labels, and `codex-statusline`'s status wording for the weekly bar. Re-run its tests and `tsc` in a disposable copy on every Pi upgrade.
- `code-mode` depends on `pi.getAllTools()`/`getActiveTools()`/`setActiveTools()`, auto-activation of newly registered extension tools, replacement of a re-registered tool with its active state kept, `SettingsList` and `getSettingsListTheme()` for `/tools`, the `create*ToolDefinition()` exports and their `prepareArguments`, `validateToolArguments` from `@earendil-works/pi-ai`, the context fields built-in tools read during `execute()` (`cwd`, `sessionManager`, `model`, `thinkingLevel`), `before_agent_start` mutable `systemPromptOptions` (skills are listed only when `read` or `bash` is selected), macOS `sandbox-exec` and Seatbelt operation names, inherited socketpair fds working inside the sandbox, interpreter prefixes reported by `python3 -I` and `process.execPath`, the `tool_call` block result, boolean flags, and `node`/`python3` on the host. Calls made inside programs bypass Pi's tool events by design. Re-run its tests and `tsc` in a disposable copy on every Pi upgrade.
- `questionnaire` depends on TUI component, key handling, autocomplete, theming, and invalidation contracts.

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
- It merges credential-free `model-overrides.json` entries into the target `models.json`, preserving unrelated local providers and settings.
- It removes obsolete extension paths and state, including the former standalone Preset extension and skill, the retired `extensions/plan-mode/`, the previously customized `extensions/subagent/`, `subagent-settings.json`, the retired `explore-and-gather` prompt, the former global `codex-fast.json` state, and the retired `git/github.com/algal/pi-openai-server-compaction` package checkout before copying the current settings, local extensions, local general-purpose prompts, upstream subagent-owned agents/prompts, and refreshed Herdr-owned skills.
- It merges copied directory contents into the target; unrelated target files are not a reliable part of this repository's desired state.
- It backs up and then replaces installed user-agent Markdown files with repository copies, so `/subagent` runtime edits must be moved into this repository before reinstalling if they should become reproducible defaults.

`codex-fast-toggle` stores mutable state only in Pi session custom entries. The installer backs up and removes the former global `codex-fast.json`; do not reintroduce cross-session mutable Fast state.

`codex-accounts.json` is a sensitive, runtime-only credential vault. The installer must leave it untouched; never copy it into the repository or session history. `auth.json` remains the only authority for the globally active account.

`codex-statusline` intentionally shares quota snapshots and query coordination under `<agent-dir>/cache/codex-statusline/`. This cache is runtime-only, contains no credentials or email labels, and must not be installed from or committed to this repository.

Never commit credentials or machine-local Pi state. In particular, keep `auth.json`, `models.json`, `mcp.json`, `trust.json`, sessions, caches, logs, backups, package installation directories, and environment files out of version control. Check `.gitignore` before adding any file copied from `~/.pi/agent`.

## Validation

There is no single test command. Run the checks relevant to the files changed.

Basic repository checks:

```bash
bash -n install.sh
node -e 'for (const f of ["settings.json", "model-overrides.json"]) JSON.parse(require("node:fs").readFileSync(f, "utf8"))'
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
- `questionnaire` handles single, multiple, custom-text, cancellation, narrow-terminal, and non-TUI cases.
- `/fast on|off` persists only in the current session/branch, defaults Off in unrelated sessions and subagents, appears only for `openai-codex`, updates status, and changes only the intended outgoing request field.
- Codex server compaction is a no-op for non-Codex models; runs Pi's built-in text compaction on an isolated lane and V2 on the main cached WebSocket lane in parallel; follows the active Fast tier; stores a 64K-bounded native history and combined usage; sends explicit history on seed/reconnect and `previous_response_id` plus the trigger on a matching live chain; restores the current V2 details shape across resume/tree/model round-trips without importing foreign-model assistant turns; provides no legacy V1 or older-format migration; and uses the Pi result when V2 fails.
- `/subagent` lists only user agents, offers only models currently available within the session's model scope, filters thinking levels by model capability, updates frontmatter without reload, and preserves cancellation without partial writes.
- `subagent` handles single, parallel, and chained modes in the foreground and with `async: true`, inherited dispatch defaults, cancellation, failures, output limits, and strict project-agent confirmation; saves each child session and `*.meta.json` under `<agent-dir>/subagent-sessions/<parent session id>/`; shows running subagents below the editor, where `↓` on an empty prompt selects, Enter opens the live transcript, `x x` stops only that run, and Esc returns without interrupting the main agent; `/subagent-history` lists and opens past runs after reload/restart; and verify the four local agent files retain their intended model defaults.
- `extensions/herdr/` background monitoring is a no-op outside Herdr; tracks only successful explicit `herdr_agent prompt` calls with `wait: false`; delivers grouped, bounded follow-ups to the owning session after `done`, post-working `idle`, or `blocked`; and cancels cleanly on session replacement, reload, and shutdown.
- `/codex-accounts` requires an idle TUI, confirms import/global switch, adds accounts with native OAuth without selecting a different account, and never writes selected-account session state. Cancellation/corrupt stores/failed refresh do not replace the active login; real Pi OAuth refresh and switching serialize on the same lock; other running processes observe auth-file replacement. Account-bound native history must not survive foreign-account turns or unknown legacy ownership; preserve visible text fallback and unchanged model/thinking/Fast.
- `codex-statusline` displays full email (or a short account ID) and ordinary weekly remaining percentage only in Codex TUI sessions; multiple processes sharing an agent directory issue one quota attempt per identity per five minutes, including failures; dead query owners are recoverable; stale/absent data is not shown as fresh or fabricated; account changes and lifecycle cleanup reject late results; other footer statuses remain intact.
- `hairline` renders every line within the terminal width, including narrow terminals and CJK text; the editor has no side borders; working, retry, and compaction indicators appear in the top rule; the footer keeps all extension statuses; tool rows stay one line when collapsed and show Pi's own output with `ctrl+o`; `bash` honors `shellPath`/`shellCommandPrefix` and ignores untrusted project settings; the HUD shows the weekly bar only while `codex-statusline` reports a quota, and the footer then keeps only that status's account label (full text again with the HUD off); `/hairline off` restores Pi's header, editor, and footer, and `/hairline hud off` removes only the HUD line.
- `code-mode` is off by default and per session branch; `/tools` lists every registered tool, applies switches immediately, and restores them on resume, `/reload`, and tree navigation; with code mode on only `execute_code` plus the other enabled tools are active, the `execute_code` description and system-prompt snippet/guidelines name exactly the enabled built-ins, and turning code mode off returns every enabled tool; `--code-mode` applies only without a saved selection; JavaScript and Python programs can read, edit, and write files and run `bash`; Esc and `timeout` kill the program; output beyond 2000 lines/50KB is truncated with a full-output temp file; skills stay listed; the `execute_code` row stays within the terminal width; with Sandbox on (default) a program's direct file reads/writes, network, and subprocesses fail while `tools.*` work, the tool description states the sandbox, and non-macOS hosts refuse to run programs; the footer shows `code mode · js|python` (plus `· unsandboxed` with Sandbox off); switching the language in `/tools` leaves no trace of the other language in the request.
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
