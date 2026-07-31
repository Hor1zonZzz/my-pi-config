# Local Herdr Integration

Repository-managed Herdr configuration that complements the official `@ogulcancelik/pi-herdr` package. It does not replace, modify, or import Herdr's package or Herdr-managed Pi state integration.

This directory owns:

- `integration-check.ts`, which warns on initial TUI startup when Herdr reports that its Pi integration is missing or outdated;
- the background-monitor modules, which observe explicit asynchronous official tool calls; and
- `skills/herdr-pi-reference/`, the source copied by `install.sh` to Pi's top-level skills directory.

## Background monitor

When the active Pi session successfully calls the official `herdr_agent` tool with `action: "prompt"` and explicit `wait: false`, the monitor:

1. lets the official tool return immediately;
2. tracks the resolved Herdr pane in the background, using Herdr's state-change sequence when available;
3. waits for a new `working` lifecycle followed by `done`, `idle`, or `blocked`;
4. injects one custom `followUp` message into the owning Pi session; and
5. asks the parent agent to use the official `herdr_agent read` action for the result.

Background monitoring is inactive unless both `HERDR_ENV=1` and `HERDR_PANE_ID` are present. The integration uses only Pi's public extension APIs and the public Herdr CLI. It deliberately does not depend on the implementation of `~/.pi/agent/extensions/herdr-agent-state.ts`, which Herdr owns and may overwrite.

## Scope and isolation

- Only explicit `prompt` calls with `wait: false` are monitored. An omitted `wait` keeps the official default (`true`) and is not monitored.
- Tool events are local to the current Pi extension instance. Calls made by another Pi process do not create tasks here.
- Every task is bound to the creating Pi session ID and resolved Herdr pane ID.
- `/new`, `/resume`, `/fork`, `/reload`, and Pi shutdown cancel this extension instance's monitors. Version 1 does not restore them after reload.
- Multiple asynchronous prompts sent to the same pane before settlement are grouped because Herdr exposes pane/agent lifecycle state, not a public prompt-level task ID.
- Different Pi sessions should not concurrently submit monitored prompts to the same Herdr pane. Their Pi events are isolated, but shared pane state cannot identify which session caused a lifecycle transition.

## Completion delivery

Completions use `pi.sendMessage()` with `deliverAs: "followUp"` and `triggerTurn: true`. If the parent is busy, completions accumulate until `agent_settled` and are delivered together. Notifications contain bounded status metadata only; the parent reads terminal output through the official Herdr tool.

A compact `herdr-bg N` status appears while panes are being monitored.

## Timeouts

- A submitted prompt must show a new active or terminal state within 5 seconds.
- A monitor stops after 60 minutes.
- Each `herdr agent get` call has a 2-second timeout; transient query failures are retried up to three consecutive times.

## Manual checks

- Start Pi outside Herdr and confirm the extension is a no-op.
- Inside Herdr, send a long task with `wait: false`; confirm the tool returns immediately and a completion follow-up arrives later.
- Verify `done`, `idle`, `blocked`, missing-agent, concurrent-pane, grouped-same-pane, parent-busy, and session-shutdown behavior.
