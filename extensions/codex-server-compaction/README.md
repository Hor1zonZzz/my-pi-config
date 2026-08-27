# Codex Server Compaction

Local Pi extension that adds Codex Remote Compaction V2 to built-in
`openai-codex/*` models. It is a Codex-only adaptation of
[`pi-openai-server-compaction`](https://github.com/algal/pi-openai-server-compaction)
and does not override Pi's provider or transport.

## Behavior

When Pi runs manual or automatic compaction, the extension starts two requests
in parallel:

1. Pi's built-in text compaction;
2. a Codex V2 request to `POST /backend-api/codex/responses` whose final input
   item is `{ "type": "compaction_trigger" }`.

A successful V2 response contributes one opaque `compaction` item. The
extension retains recent user messages with that item and persists the result
in `CompactionEntry.details.remoteCompaction`. Later requests from the exact
Codex provider/API/model replay this native history. Other models use Pi's text
summary and retained messages normally; returning to the original Codex model
reconstructs its native state from the session branch.

Cross-model assistant turns are not inserted into Codex-native replay history.
This prevents foreign reasoning and tool-call identifiers from contaminating
the artifact. They remain available through Pi's normal text-summary path.

If V2 fails or exceeds its independent five-minute request limit, the already-running Pi compaction becomes the result. If Pi compaction fails while V2 succeeds, the extension keeps the artifact with a minimal textual marker. The extension restores only the current V2 details shape and provides no migration path for legacy V1 or other older artifact formats; those sessions continue through their saved Pi text summary.

## Fast mode

The remote compaction request inherits the current Codex service tier. With the
repository's `/fast on`, it sends `service_tier: "priority"` and the matching
routing hint, following current Codex CLI behavior. The backend may still
serve the request on its default tier, and Fast can consume credits at a higher
rate.

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
- custom HTTP/WebSocket streaming;
- `previous_response_id`, `store: true`, and `context_management` patching;
- external runtime dependencies.

## Attribution

Adapted from `pi-openai-server-compaction` by Alexis Gallagher under the MIT
License. See `LICENSE` and the repository's `THIRD_PARTY_NOTICES.md`.
