"""Child side of the code-mode bridge for Python programs.

Requests go to the host on fd 3 and responses come back on fd 4, one JSON
object per line. stdout and stderr stay free for the program's own output.
Calls are synchronous and serialized, so a response always belongs to the
request that is waiting for it.
"""

import json
import os
import runpy
import sys
import threading
import traceback

_requests = os.fdopen(3, "w", encoding="utf-8")
_responses = os.fdopen(4, "r", encoding="utf-8")
os.set_inheritable(3, False)
os.set_inheritable(4, False)
_lock = threading.Lock()
_next_id = 0


class ToolError(Exception):
    """Raised when a Pi tool call fails; the message is the tool's error text."""

    def __init__(self, tool, message):
        super().__init__(message)
        self.tool = tool


def _call(tool, args=None, **kwargs):
    global _next_id
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise TypeError(f"tools.{tool}() takes a dict or keyword arguments")
    payload = {**args, **kwargs}
    with _lock:
        _next_id += 1
        _requests.write(json.dumps({"id": _next_id, "tool": tool, "args": payload}) + "\n")
        _requests.flush()
        line = _responses.readline()
    if not line:
        raise ToolError(tool, "the code-mode host closed the tool channel")
    message = json.loads(line)
    if message.get("ok"):
        return message.get("text", "")
    raise ToolError(tool, str(message.get("error", "tool failed")))


class _Tools:
    def __init__(self, names):
        self._names = tuple(names)
        for name in self._names:
            setattr(self, name, self._bind(name))

    @staticmethod
    def _bind(name):
        def tool(args=None, **kwargs):
            return _call(name, args, **kwargs)

        tool.__name__ = name
        return tool

    def __repr__(self):
        return f"<tools: {', '.join(self._names)}>"


def _main():
    path = sys.argv[1]
    sys.argv = [path]
    # Import from the working directory instead of this prelude's directory. In
    # isolated mode (-I) the prelude directory is not on sys.path at all, and in
    # the sandbox the working directory is not readable, so leave sys.path alone.
    if sys.path and sys.path[0] == os.path.dirname(os.path.abspath(__file__)):
        try:
            sys.path[0] = os.getcwd()
        except OSError:
            del sys.path[0]
    tools = _Tools(json.loads(os.environ.get("PI_CODE_MODE_TOOLS", "[]")))
    try:
        runpy.run_path(path, init_globals={"tools": tools, "ToolError": ToolError}, run_name="__main__")
    except SystemExit:
        raise
    except BaseException as error:
        # Start the traceback at the program itself, not at this prelude or runpy.
        tb = error.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != path:
            tb = tb.tb_next
        traceback.print_exception(type(error), error, tb or error.__traceback__)
        sys.exit(1)


_main()
