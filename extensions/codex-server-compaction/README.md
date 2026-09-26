# Codex Server Compaction

Local Pi extension that adds Codex Remote Compaction V2 to built-in `openai-codex/*` models. It is a Codex-only adaptation of [`pi-openai-server-compaction`](https://github.com/algal/pi-openai-server-compaction) and overrides only the built-in `openai-codex` stream transport so ordinary turns and V2 compaction share one cached WebSocket continuation lane.

## Behavior

When Pi runs manual or automatic compaction, the extension starts two requests in parallel:

1. Pi's built-in text compaction on an isolated temporary session lane;
2. a Codex V2 request through the main cached WebSocket lane whose final input item is `{ "type": "compaction_trigger" }`.

The custom transport records canonical request/response items. When the live prefix matches, the compaction wire request is reduced to `previous_response_id` plus the trigger; reconnects and SSE fallback send the validated full history instead.

V2 retention keeps real user messages only: the [subagent extension](../subagent/README.md#what-the-main-agent-sees)'s `<subagent_notification>` messages are context, as in Codex CLI, and are not retained.

A successful V2 response contributes one opaque `compaction` item. The extension retains up to the official 64K budget of recent user messages with that item and persists the result in `CompactionEntry.details.remoteCompaction`. The extension supplies this exact native history to the matching Codex provider/API/model/account and removes any stale pre-compaction `previous_response_id`. Replay is applied after Pi's payload hooks, at the custom transport boundary with the actual bound request token, before cached WebSocket reduction: the first request or a reconnect sends the explicit artifact history, while a matching live prefix is reduced on the wire to Pi's native `previous_response_id` plus the new delta. Other models use Pi's text summary and retained messages normally.

A model switch alone does not invalidate the artifact. Once an assistant turn from a different provider/API/model appears after it, however, the extension stops replaying that artifact on the branch; otherwise returning to the original model would omit the intervening turn. Pi's normal text-summary context remains active until the exact model completes another manual or automatic V2 compaction. Returning to it does not trigger an extra compaction request.

If V2 fails, the already-running Pi compaction becomes the result. The production transport defaults to a 15-second WebSocket connection timeout, a 20-second SSE response-header timeout, and a five-minute stream-idle timeout. These are per-stage limits, not a five-minute total compaction deadline; retries and continued incoming data can extend the total duration. If Pi compaction fails while V2 succeeds, the extension keeps the artifact with a minimal textual marker. The extension restores only the current V2 details shape and provides no migration path for legacy V1 or other older artifact formats; those sessions continue through their saved Pi text summary.

## Fast mode

The remote compaction request inherits the current Codex service tier. Ordinary SSE/WebSocket requests, prewarm, and remote compaction derive their routing hint from the final request tier, following Codex CLI behavior. `/fast on` sends `service_tier: "priority"` and `x-codex-routing-hint: model=<model>;tier=priority`; `/fast off` omits the body tier and sends `model=<model>` as the hint. This local adaptation removes the upstream routing-only Fast flag and keeps the Pi client identity unchanged. The existing WebSocket cache includes routing headers in its connection identity, so a tier change cannot reuse a mismatched handshake. The backend may still serve the request on its default tier, and Fast can consume credits at a higher rate.

## Global account switching

With `/codex-accounts`, the provider identity remains `openai-codex`. New V2 artifacts include an `accountKey` fingerprint; ordinary main-lane requests record `codex-account-context` provenance (no credentials or selection preference). A foreign-account turn prevents A/B/A from reviving A's earlier opaque artifact. Legacy V2 artifacts without account ownership use their saved Pi text fallback. Foreign or unattributed opaque reasoning/compaction items and response references are removed from the fallback request, preserving visible messages/tool results. The account comparison uses the token bound to the request, not a second global auth lookup that could race another process's switch. Account changes reset the cached session lane; compaction checks ownership before using canonical history. The pure identity decoder is shared with `codex-statusline/quota.ts`.

## Installation identity

The request follows Codex CLI's installation identity convention:

- use `$CODEX_HOME/installation_id` when `CODEX_HOME` is set;
- otherwise use `~/.codex/installation_id`;
- reuse a valid UUID and create/replace it when missing or invalid.

This UUID is client metadata, not a credential. It is sent as `x-codex-installation-id`.

## Data and accounting

Conversation context is sent to the ChatGPT Codex Responses backend. Opaque artifacts are stored in Pi's local session JSONL. Local-summary and remote compaction usage are combined into the saved compaction usage so Pi session statistics count both requests once; remote usage is also retained in details for inspection.

## Scope

Intentionally excluded:

- direct `openai/*` and Azure models;
- provider overrides;
- direct `openai/*`, Azure, tools, prompt, voice, Code Mode, Notebook, or Responses Lite features from the reference adapter; their vendored implementation paths are removed;
- `store: true` or `context_management` patching;
- external runtime dependencies.

## Implementation maintenance

The production remote path is `executeRemoteCompactionV2` through the registered Codex transport. The unused standalone fetch/SSE compaction implementation was removed; `v2-request.test.ts` exercises the actual V2 client and transport with a mock backend, including tier/header/trigger serialization, invalid output counts, incomplete/failed responses, and cancellation. No total-timeout guarantee is inferred from a test of an unused helper.

Pi 0.86.0 publicly exports `processResponsesStream` from `@earendil-works/pi-ai/api/openai-responses-shared`. A raw-event tap can capture V2 artifacts before that parser, but it is not yet an equivalent replacement: the local callback reconstructs custom-tool input omitted from the final event, and the local parser retains native web-search history that Pi's parser drops. `parser-parity.test.ts` records these differences against the installed Pi version. Keep the existing parser/transport until these semantics can be preserved without reintroducing a second parser. Message/tool conversion and account isolation are unchanged by this cleanup.

### Transcript context (Pi 0.86.0)

Pi 0.86.0 changed provider stream inputs from `Context` to a normalized `TranscriptContext`. The system prompt and tool declarations are carried by the transcript's system messages, so the vendored Codex provider resolves them with `resolveTranscript`, `getInitialSystemMessage`, `getSystemMessageText`, and `resolveTranscriptTools` instead of reading `context.systemPrompt` and `context.tools`. Reading the retired fields is silent: the request keeps a placeholder prompt and sends no tools. Codex does not accept mid-conversation system messages, so later prompt and tool changes are replayed into the leading system message before the body is built, and the reconstructed compaction history numbers messages the same way the provider does.

`transcript-context.test.ts` compares the vendored request body against the installed Pi Codex provider's own body for the same transcript, covering tool calls, mid-conversation prompt and tool changes, tool removal, sessions with no leading system message, and the Off reasoning effort. Run it after every Pi upgrade.

### Context edits (Pi 0.87.0)

Compaction inputs use `sessionManager.buildSessionProjection().messages`, which applies `context_edit` omissions and replacements. Raw `buildContextEntries()` values are not an edited message projection.

Any context edit appended after the latest native checkpoint conservatively disables that checkpoint on the branch, including after resume or tree navigation. Opaque artifacts have no entry-ID provenance, so the extension does not attempt to patch them. Ordinary requests retain Pi's projected text-summary context; the next successful compaction incorporates the edited projection and enables native replay again. Existing summaries remain summaries: editing an older source entry does not rewrite their text.

A newly observed edit clears the session's canonical raw history and cached WebSocket continuation before ordinary replay or V2 input selection. Unchanged edit history does not repeatedly reset the lane. Account/model isolation and the Fast tier remain unchanged. `context-edit.test.ts` covers omission/replacement, retained and trailing entries, resume/tree, fresh checkpoints, ordinary transport, and V2 input selection against Pi 0.87.0.

## Attribution

Adapted from `pi-openai-server-compaction` by Alexis Gallagher and the cached Codex provider/compaction implementation in `@howaboua/pi-codex-conversion` by Igor Warzocha and contributors, both under the MIT License. See `LICENSE`, `vendor/howaboua/LICENSE`, and the repository's `THIRD_PARTY_NOTICES.md`.
