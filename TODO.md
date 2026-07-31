# TODO

## Adopt Pi's alternate-screen layout APIs for Config Manager

**Status:** Blocked on an official Pi release that includes `TuiAltScreen`, `HStack`, `VStack`, `ScrollView`, and the `--alt` flag. The currently installed npm release (`0.83.0`, git head `845d6ff`) does not export these APIs; they exist only in Pi's unreleased `main` branch.

When the feature is released:

- Record the new Pi version and review its changelog, TUI documentation, and extension compatibility notes.
- Verify Config Manager in both default main-screen mode and `pi --alt` mode.
- Evaluate replacing the manager's manual left/right width calculation and line compositing with `HStack`, but only if it reduces code and preserves the current responsive behavior.
- Keep the existing Context Monitor scroll implementation unless Pi adds layout-aware overlay rendering. `ScrollView` currently receives real viewport semantics only as part of the alternate-screen layout root; overlays are still rendered through `component.render(width)`.
- Confirm that the underlying transcript can scroll while the Config Manager overlay remains open, using mouse/trackpad and alternate-screen keyboard bindings.
- Reconsider the current `92%` width and `90%` height so enough transcript remains visible for background scrolling to be useful.
- Avoid maintaining permanent legacy and new layout implementations unless the supported Pi version range requires both.

Acceptance checks:

- Existing Config Manager behavior-contract tests remain green.
- `/config-manager`, `/tools`, `/skills`, `/contexts`, and `/extensions` retain their current behavior.
- Resource toggles, Context Monitor navigation, extension staging, preset synchronization, Plan Mode layers, session restoration, and prompt filtering remain unchanged.
- Pi starts without extension errors in both main-screen and alternate-screen modes.
