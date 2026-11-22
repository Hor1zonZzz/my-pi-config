# btw

Claude Code-style `/btw` ephemeral side-question panel for Pi.

## Behavior

- **Bottom-docked inline panel**: Renders in Pi's bottom editor/status area (directly above the status bar), never covering the main conversation transcript.
- **Zero context pollution**: Reads the current session context read-only (reusing the active prompt cache prefix) and streams answers without writing anything to the main session history.
- **Multi-turn follow-ups**: Type directly in the panel's `›` input box and press `Enter` to ask follow-up questions; all turns stay ephemeral and vanish on `Esc`.
- **Shortcuts**:
  - `Enter`: send follow-up question
  - `Esc` / `Ctrl+C`: abort streaming or close panel
  - `Ctrl+Y`: copy latest answer (`pbcopy`)
  - `↑` / `↓` / `PageUp` / `PageDown` / mouse wheel: scroll answer
