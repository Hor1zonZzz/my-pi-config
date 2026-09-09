# Codex Server Compaction

Local Pi extension that adds Codex Remote Compaction V2 to built-in
`openai-codex/*` models. It is a Codex-only adaptation of
[`pi-openai-server-compaction`](https://github.com/algal/pi-openai-server-compaction)
and overrides only the built-in `openai-codex` stream transport so ordinary turns and V2 compaction share one cached WebSocket continuation lane.

## Behavior

When Pi runs manual or automatic compaction, the extension starts two requests
in parallel:

1. Pi's built-in text compaction on an isolated temporary session lane;
2. a Codex V2 request through the main cached WebSocket lane whose final input
   item is `{ "type": "compaction_trigger" }`.

The custom transport records canonical request/response items. When the live
prefix matches, the compaction wire request is reduced to
`previous_response_id` plus the trigger; reconnects and SSE fallback send the
validated full history instead.

A successful V2 response contributes one opaque `compaction` item. The
extension retains up to the official 64K budget of recent user messages with that item and persists the result
in `CompactionEntry.details.remoteCompaction`. The extension supplies this
exact native history to the matching Codex provider/API/model and removes any
stale pre-compaction `previous_response_id`. Pi's cached WebSocket transport runs
after the extension hook: the first request or a reconnect sends the explicit
artifact history, while a matching live prefix is reduced on the wire to Pi's
native `previous_response_id` plus the new delta. Other models use Pi's text
summary and retained messages normally.

A model switch alone does not invalidate the artifact. Once an assistant turn
from a different provider/API/model appears after it, however, the extension
stops replaying that artifact on the branch; otherwise returning to the original
model would omit the intervening turn. Pi's normal text-summary context remains
active until the exact model completes another manual or automatic V2
compaction. Returning to it does not trigger an extra compaction request.

If V2 fails or exceeds its independent five-minute request limit, the already-running Pi compaction becomes the result. If Pi compaction fails while V2 succeeds, the extension keeps the artifact with a minimal textual marker. The extension restores only the current V2 details shape and provides no migration path for legacy V1 or other older artifact formats; those sessions continue through their saved Pi text summary.

## Fast mode

The remote compaction request inherits the current Codex service tier. Ordinary
SSE/WebSocket requests, prewarm, and remote compaction derive their routing hint
from the final request tier, following Codex CLI behavior. `/fast on` sends
`service_tier: "priority"` and `x-codex-routing-hint: model=<model>;tier=priority`;
`/fast off` omits the body tier and sends `model=<model>` as the hint. This local
adaptation removes the upstream routing-only Fast flag and keeps the Pi client
identity unchanged. The existing WebSocket cache includes routing headers in
its connection identity, so a tier change cannot reuse a mismatched handshake.
The backend may still serve the request on its default tier, and Fast can
consume credits at a higher rate.

## Installation identity

The request follows Codex CLI's installation identity convention:

- use `$CODEX_HOME/installation_id` when `CODEX_HOME` is set;
- otherwise use `~/.codex/installation_id`;
- reuse a valid UUID and create/replace it when missing or invalid.

This UUID is client metadata, not a credential. It is sent as
`x-codex-installation-id`.

## Data and accounting

Conversation context is sent to the ChatGPT Codex Responses backend. Opaque
artifacts are stored in Pi's local session JSONL. Local-summary and remote
compaction usage are combined into the saved compaction usage so Pi session
statistics count both requests once; remote usage is also retained in details
for inspection.

## Scope

Intentionally excluded:

- direct `openai/*` and Azure models;
- provider overrides;
- direct `openai/*`, Azure, tools, prompt, voice, Code Mode, Notebook, or Responses Lite features from the reference adapter; their vendored implementation paths are removed;
- `store: true` or `context_management` patching;
- external runtime dependencies.

## Attribution

Adapted from `pi-openai-server-compaction` by Alexis Gallagher and the
cached Codex provider/compaction implementation in
`@howaboua/pi-codex-conversion` by Igor Warzocha and contributors, both under
the MIT License. See `LICENSE`, `vendor/howaboua/LICENSE`, and the repository's
`THIRD_PARTY_NOTICES.md`.
