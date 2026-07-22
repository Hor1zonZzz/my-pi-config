# OpenAI Responses Compaction

Pi extension that uses the OpenAI Codex Responses compact endpoint for context
compaction while retaining Pi's normal recent-message window.

The implementation is intentionally limited to Pi's built-in `openai-codex`
provider, the `openai-codex-responses` API, and the stock
`https://chatgpt.com/backend-api` endpoint. It does not send credentials or
native compacted content to logs or notifications.

## Usage

```text
/compact-openai
/compact-openai Focus on remaining tests
```

The optional argument is appended to the active system prompt as compaction
guidance.

While an eligible Codex model is active, the extension also handles Pi's
built-in `/compact`, threshold compaction, and context-overflow recovery. On
other providers, `/compact-openai` falls back to Pi's normal text compaction.

## Behavior

- Serializes the old window selected by Pi and keeps Pi's configured recent
  message window uncompressed.
- On repeated native compaction, sends the previous opaque checkpoint followed
  by the newly eligible old messages.
- Stores the Responses compact output in versioned `CompactionEntry.details`;
  this includes the encrypted checkpoint and may include plaintext context items
  returned by OpenAI. The visible summary is only a readable marker.
- Replaces that marker with the opaque checkpoint in outgoing Codex Responses
  payloads.
- Preserves the checkpoint across `/resume`, forks, and branches that contain
  the compaction entry. Tree navigation remains available, but branch
  summarization is blocked while a native checkpoint is active; retry without
  a branch summary so Pi does not summarize only the visible marker.
- Uses the current model and Pi thinking level.
- Reads `codex-fast.json` at compaction time and sends
  `service_tier: "priority"` when `/fast` is enabled.
- Truncates only oversized tool outputs if the compact request approaches the
  model context limit.
- Falls back to Pi's normal text compaction when the first compact request
  fails. After an existing native checkpoint, it uses Pi's summary generator
  for the newly eligible old messages and layers that text onto the previous
  encrypted checkpoint. Pathological summaries are truncated to the persisted
  checkpoint size limit; if fallback generation or replay validation fails,
  compaction is cancelled.

## Model binding

OpenAI native compaction output is treated as bound to the provider, API, model,
base URL, and ChatGPT account that created it. Only a SHA-256 digest of the
account claim is persisted. Switching any binding after a native checkpoint
causes subsequent prompts to be blocked until the exact account and model are
restored. This prevents Pi from silently continuing with only the marker.

## Compatibility

Developed against Pi Coding Agent `0.81.1`. The extension depends on:

- `session_before_compact`, `session_compact`, and `session_before_tree`
- persisted `CompactionEntry.details`
- `before_provider_request`
- the OpenAI Responses serializer shipped at
  `@earendil-works/pi-ai/api/openai-responses-shared`
- the current OpenAI Codex OAuth token and compact endpoint contracts

Pi 0.81 aliases extension imports under `@earendil-works/pi-ai` to its compat
root, including subpaths. The extension therefore resolves the installed
package entry and loads the exported shared serializer by file URL.

A live stock-endpoint check with `gpt-5.6-sol` returned the encrypted item as
`compaction_summary`; the public Responses contract names the equivalent item
`compaction`, so replay validation accepts both discriminators and rejects all
other compact-item types.

The compact endpoint call uses direct `fetch` because Pi does not expose nested
provider dispatch for this endpoint. Resolved model headers are honored, but
this call does not emit Pi's provider request/response hooks or use its provider
retry/timeout pipeline. Revalidate this transport, the loader workaround,
request serialization, authentication headers, persistence, and replay after
Pi upgrades.

## Attribution

The architecture is substantially adapted from the native compaction
implementation in
[`@howaboua/pi-codex-conversion`](https://github.com/IgorWarzocha/howaboua-pi-stuff),
reviewed at commit `3d55dffaf22a47854f568d3d2d742b979cfbc55f`.

The upstream MIT license is retained in [`LICENSE`](./LICENSE).
