# Code mode

English | [中文](README.zh-CN.md)

`/tools` turns any registered tool on or off and switches code mode. Code mode
replaces Pi's enabled built-in tools (`read`, `bash`, `edit`, `write`, `grep`,
`find`, `ls`) with a single `execute_code` tool: the model writes a program in
the one language you chose — JavaScript (Node.js, the default) or Python 3 — and
those tools exist only as functions on a global `tools` object inside it. Only what the program
prints returns to the model, so loops, filtering, and aggregation happen in code
instead of passing every intermediate result through the context.

The idea follows Cloudflare's [Code Mode](https://blog.cloudflare.com/code-mode/)
and Anthropic's [code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp).
It is an extension, as Pi's maintainer recommends: Pi has no core code mode, and
extensions cannot call other extensions' tools, so only the built-ins are wrapped.

## Use

```text
/tools              selector: code mode, sandbox, language, and one switch per registered tool
/code-mode          toggle code mode
/code-mode on|off
pi --code-mode      start new sessions in code mode
```

In `/tools`, ↑/↓ select, Enter or Space switches, typing filters, and Esc
closes. Changes apply immediately. The first rows are code mode, the
[sandbox](#sandbox), and the [language](#language); built-in tools follow, then every other registered tool (`subagent`, `questionnaire`,
`herdr_agent`, MCP, …) except `execute_code` itself.

- **Code mode off**: every tool that is on is an ordinary active tool.
- **Code mode on**: every built-in tool that is on moves inside `execute_code`
  (its row shows `code`), and the other tools that are on stay ordinary tools.
  Turning a built-in on or off changes what programs can call. Direct calls to
  built-ins are blocked.
- **Code mode off again**: all tools that are on return as ordinary tools.

The selection is stored in the current session branch (`tools-state` custom
entries), like `/fast`, and restored on resume, `/reload`, and tree navigation.
It records code mode, the sandbox, the language, the built-ins that are on, and
the other tools you turned off. Other tools are otherwise left as Pi and their extension activate them:
tools registered later start on, and tools an extension keeps inactive on
purpose (such as `pi-mcp-adapter`'s MCP tools before a search) are not forced
on; turning one on in `/tools` activates it immediately. A branch without a
saved selection starts from Pi's active tools and `--code-mode`. While code mode
is on the footer shows `code mode · js` or `code mode · python`, plus
`· unsandboxed` when the sandbox is off.

### Language

`execute_code` accepts exactly one language at a time: **JavaScript** (default)
or **Python**, chosen in `/tools` and saved per session branch. The tool has no
`language` parameter, so the model cannot pick the other one: the description,
the API signatures (`tools.read({ path, offset?, limit? }) → string` or
`tools.read(path, offset=None, limit=None) -> str`), the one-line summary, and
the guidelines describe only the chosen language, and every program runs with
its interpreter. Changing the language re-registers `execute_code` before the
next request.

This fixes the language of `execute_code` programs, not of commands a program
runs through `tools.bash`: a shell can still start `python3` or `node`. Turn
`bash` off in `/tools` when programs must stay in one language.

### Prompt

`execute_code` is re-registered whenever the set of built-ins inside it
changes, so everything the model reads covers exactly that set: the tool
description and its generated API reference, the one-line tool summary, and the
guidelines in the system prompt. Tools that are off are neither active nor
documented. Pi lists skills only when `read` or `bash` is an active tool; in
code mode the extension adds the list back and tells the model to load a skill
with `tools.read` (or `tools.bash` when `read` is off) inside `execute_code`.

## Programs

With JavaScript:

```js
// ES module with top-level await
const files = (await tools.find({ pattern: "src/**/*.ts" })).split("\n");
const texts = await Promise.all(files.map((path) => tools.read({ path })));
console.log(files.filter((_, i) => texts[i].includes("TODO")));
```

With Python:

```python
# Synchronous calls, keyword or dict arguments
for path in tools.find(pattern="src/**/*.py").splitlines():
    if "TODO" in tools.read(path=path):
        print(path)
```

- Each call takes one arguments object, is validated against the tool's own
  schema, runs Pi's own tool implementation, and returns its text output.
- A failed call throws `ToolError` (the message is the tool's error text; for
  `bash` this includes non-zero exits and the command output).
- Images read with `tools.read` are attached to the `execute_code` result (up to 8).
- Output is stdout and stderr combined, truncated to Pi's usual 2000 lines /
  50KB tail. When truncated, the full output is saved to a temp file whose path
  is given to the model.
- A non-zero exit, a timeout (optional `timeout` in seconds), or an interrupt
  marks the result as failed. The program runs in its own process group, which
  is killed on timeout or interrupt and after the program exits; tool calls it
  left unfinished are aborted.

The API reference in the tool description is generated from the built-in tool
definitions, so it follows Pi's descriptions and schemas.

## Sandbox

With **Sandbox** on (the default, per session branch) `execute_code` programs
run inside a macOS Seatbelt sandbox (`/usr/bin/sandbox-exec`), so a program
can reach the outside world only through `tools.*`, which Pi executes outside
the sandbox as ordinary built-in tools. Inside the sandbox a program:

- cannot read file contents under `/Users` (your home directory and projects),
  `/Volumes`, `/private/tmp`, or `/private/var/folders`, except its interpreter's
  installation and its own run directory; file metadata (`stat`) stays visible;
- cannot write anywhere except its run directory (`$TMPDIR`, deleted after
  the run) and `/dev/null`;
- has no network (TCP, UDP, DNS, Unix sockets);
- cannot start processes, fork, signal other processes, look up Mach services,
  or send Apple Events (which could ask unsandboxed apps to act for it);
- sees only `PATH=/usr/bin:/bin`, `HOME=$TMPDIR`, `TMPDIR`, locale, and the
  bridge variables — none of Pi's environment or secrets.

Only Node built-in modules, the Python standard library, and packages installed
inside the interpreter's own prefix can be imported; the project's
`node_modules`, virtual environments outside the interpreter, and the working
directory are not readable. The interpreter is resolved to its real
installation (for example uv's Python or nvm's Node) and started directly;
installation paths that would expose the home directory are refused. The
tool description tells the model about these limits.

The sandbox fails closed: off macOS or without `sandbox-exec`, programs are not
run and the error says to turn Sandbox off in `/tools`. With Sandbox off,
programs run unsandboxed with your permissions and the footer shows
`code mode · unsandboxed`.

The sandbox confines the program, not the tools: `tools.bash` still runs any
shell command and `tools.write` writes anywhere Pi can. Turn those tools off in
`/tools` for a program that can only read, search, and edit.

## Design

| Part | File |
|---|---|
| Tool selection state, `/tools`, `/code-mode`, `--code-mode`, active-tool switching, `execute_code` (re-)registration, skills prompt, direct-call block | `index.ts` |
| `/tools` selector | `panel.ts` |
| Built-in tool construction, API reference generation, call dispatch | `tools.ts` |
| Child process, JSON-lines bridge, timeout/abort, output capture | `runtime.ts` |
| Seatbelt profile, interpreter resolution, sandboxed command and environment | `sandbox.ts` |
| Child-side `tools` objects | `prelude.mjs`, `prelude.py` |
| Call and result rendering | `render.ts` |

- The program is written to a temp file and run with the Node executable that
  runs Pi (or `node` from `PATH`) or with `python3`. Requests travel to Pi on
  fd 3 and responses return on fd 4; stdout and stderr stay the program's own.
- Built-in tools are created with `create*ToolDefinition()` and the same
  settings Pi's `AgentSession` applies (image resizing, shell path, command
  prefix, project trust), as `hairline/` does. Arguments pass through the
  tool's `prepareArguments` and Pi's `validateToolArguments` before execution.
- Pi replaces a re-registered tool and appends tool and prompt changes to the
  transcript before the next request.

## Limits

- The sandbox is macOS-only and relies on `sandbox-exec`, which Apple marks
  deprecated but still ships and uses. It limits what a program can do, not
  what the enabled tools can do.
- Calls made from inside a program do not emit Pi's `tool_call`/`tool_result`
  events and are not individual transcript entries, so extensions that guard
  or observe those events do not see them. The `execute_code` call itself is
  observed normally.
- PowerShell is not wrapped; on Windows, `bash` behaves as Pi's bash tool does.
- Models trained heavily on direct shell and edit tools may take a few turns
  longer for trivial edits. Compare on real tasks before using it as a default.

## Validation

Tests import Pi's host packages, so run them from a disposable copy whose
`node_modules` points at the installed Pi packages (do not add dependencies to
this repository):

```sh
node --test code-mode/*.test.ts
tsc -p tsconfig.json   # strict, NodeNext, allowImportingTsExtensions, noEmit
```

They cover JavaScript and Python programs (concurrency, keyword/dict
arguments, `ToolError`, tracebacks, imports, clean exit), timeout and abort,
output truncation to a temp file, a missing interpreter, the sandbox (blocked
direct reads, writes, network, subprocesses, and signals, allowed tool calls and
scratch files, no host environment, root checks, fail-closed platforms, and
timeouts), the generated API
reference, real built-in tools including images, the tool plan and saved
selection across toggles, `/tools` changes, keyboard input, reloads, tree
navigation, `--code-mode`, and late-registered tools, the prompt following the
built-ins inside `execute_code`, the direct-call block, the skills prompt,
end-to-end `execute_code` results and failures, and renderer and selector width
from 1 to 160 columns.

Interactive checks: start `pi --no-extensions -e ./extensions/code-mode`, open
`/tools`, turn code mode on and a built-in off, ask for a task that needs reading and editing files, toggle
`ctrl+o` on the `execute_code` row, press Esc during a long program, and turn
code mode off to confirm the enabled built-ins return.
