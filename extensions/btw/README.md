# btw

Claude Code-style `/btw` side-question panel for Pi.

## Behavior

- **Bottom-docked inline panel**: Renders in Pi's bottom editor/status area (directly above the status bar), never covering the main conversation transcript.
- **Zero main-context pollution**: Reads the current session context read-only (reusing the active prompt cache prefix) so `/btw` turns are never sent to the main conversation LLM.
- **Session history & token accounting**:
  - Persists every completed `/btw` Q&A turn into the session `.jsonl` via `pi.appendEntry("btw", ...)`.
  - Records token & cost usage into Pi's session stats via `sessionManager.appendUsage("btw", ...)` so the status bar totals include `/btw` usage without inflating the main context window percentage.
  - Run bare `/btw` (without arguments) to review this session's previous `/btw` turns and continue asking follow-ups.
- **Multi-turn follow-ups**: Type directly in the panel's `>` input box and press `Enter` to ask follow-up questions.
- **pi-emphasis integration**: Automatically applies `pi-emphasis` pill/label rendering when installed.
- **Dedicated model override (reuses Pi's `/model` searchable selector)**: Defaults to the main session's active model, or search & pick a dedicated `/btw` model via `/btw-model [query]`, `/btw model [query]`, or pressing `m` (when input is empty) / `Ctrl+P` inside the panel (persisted in `~/.pi/agent/btw.json`; run `/btw-model reset` or press `Ctrl+R` inside the selector to restore following the main model).
- **Shortcuts**:
  - `Enter`: send follow-up question
  - `x` (when input is empty) / `Ctrl+L`: clear current `/btw` thread and start a fresh side question (prior entries stay archived in the session `.jsonl`)
  - `m` (when input is empty) / `Ctrl+P`: switch `/btw` model (or reset to follow main model)
  - Mouse click on `▸`/`▾` row, `Tab`, or `Ctrl+O`: expand / collapse earlier `/btw` turns
  - `Esc` / `Ctrl+C`: abort streaming or close panel
  - `Ctrl+Y`: copy latest answer (`pbcopy`, raw Markdown)
  - `↑` / `↓` / `PageUp` / `PageDown` / mouse wheel: scroll answer
