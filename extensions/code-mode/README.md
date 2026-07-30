# Code Mode

A Pi 0.82.1 extension that lets the model orchestrate Pi's built-in coding tools
from one stateless JavaScript cell.

## Commands

```text
/code-mode on      Enable Code-Mode-Only tool visibility
/code-mode off     Restore the normal Pi tool set
/code-mode status  Show global state and currently brokered built-ins
```

With no argument, `/code-mode` opens a TUI selector. The last choice is stored
atomically in `~/.pi/agent/code-mode.json` and becomes the default for later Pi
sessions. If the JavaScript host cannot start, the extension turns Code Mode off
and restores normal tools.

## Model-facing API

When Code Mode is on, Pi Config Manager hides ordinary model-facing tools and
requires only `code_mode_exec`. A cell receives:

- `tools.read(...)`, `tools.bash(...)`, `tools.edit(...)`,
  `tools.write(...)`, `tools.grep(...)`, `tools.find(...)`, and `tools.ls(...)`
  when each tool is enabled by the underlying preset/resource/runtime policy;
- `ALL_TOOLS`, containing the exact tool metadata available to that cell;
- `text(value)`, which explicitly appends text to the outer tool result;
- `image(item)`, which explicitly appends Pi/MCP image content or a base64
  `data:image/...` URL to the outer result.

Example:

```js
const [readme, agents] = await Promise.all([
  tools.read({ path: "README.md" }),
  tools.read({ path: "AGENTS.md" }),
])

text({
  readme: readme.content.find((item) => item.type === "text")?.text,
  agents: agents.content.find((item) => item.type === "text")?.text,
})
```

Nested images are not returned to the model automatically. Select one
explicitly:

```js
const result = await tools.read({ path: "diagram.png" })
const selected = result.content.find((item) => item.type === "image")
if (selected) image(selected)
```

Cells are run-to-completion and stateless. There is no `wait`, `yield`,
`store/load`, `require`, dynamic `import`, `process`, `fetch`, timer, console,
audio, or implicit return-value API.

## Architecture

1. `code_mode_exec` launches `runtime-host.mjs` in a separate Node process.
2. The child creates a fresh `node:vm` context and evaluates one async cell.
3. `tools.*` writes JSONL callback requests to the parent extension.
4. The parent validates arguments and directly executes Pi's public built-in
   tool definitions in the active session context.
5. Results return to JavaScript promises; only `text(...)` and `image(...)`
   values become the outer tool result.

The runtime uses Node's permission mode, a 128MB V8 heap limit, a 30-second
default wall timeout (120 seconds maximum), at most 64 nested calls, at most 8
concurrent nested calls, Pi-style 50KB/2,000-line text limits, and bounded image
and protocol payloads. It was tested with Node 24; set `PI_CODE_MODE_NODE` to an
alternate Node executable when Pi itself is hosted by another runtime.

The cell API and explicit image-forwarding behavior are conceptually informed
by OpenAI Codex Code Mode, but this extension uses Pi's extension and tool APIs
and an independently implemented JSONL host.

## Security and compatibility

`node:vm` is **not** a strict security sandbox. The independent child process,
minimal environment, hidden host bridges, Node permission flags, timeout,
process kill, and output limits reduce impact, but generated JavaScript must
still be treated as untrusted. Node's permission mode does not provide a
complete network sandbox after a VM escape. Nested tools intentionally execute
in the parent process with Pi's normal filesystem and shell permissions.

Pi 0.82.1 exposes tool metadata but no public API for executing an already
registered tool through the normal router. This MVP therefore supports only
Pi's seven built-in tools and invokes their public definitions directly. These
nested calls do not emit the generic extension `tool_call`, `tool_result`, or
rendering lifecycle used by ordinary model-visible calls. Custom, MCP, Lens,
questionnaire, and subagent tools are not brokered. The extension enforces Pi
Config Manager's name-level policy and separately preserves this repository's
Plan Mode command allowlist, but it cannot honor unknown third-party interception
hooks.

Pi Config Manager is required. It remains the only local extension that calls
`setActiveTools()`; Code Mode contributes a runtime policy layer.
