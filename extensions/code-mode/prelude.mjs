// Child side of the code-mode bridge for JavaScript programs.
//
// Requests go to the host on fd 3 and responses come back on fd 4, one JSON
// object per line. stdout and stderr stay free for the program's own output.
// The response socket is referenced only while a call is pending, so a program
// that has finished its work exits like any other Node script.
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

class ToolError extends Error {
	constructor(tool, message) {
		super(message);
		this.name = "ToolError";
		this.tool = tool;
	}
}

const requests = new Socket({ fd: 3, readable: false, writable: true });
const responses = new Socket({ fd: 4, readable: true, writable: false });
requests.unref();
responses.unref();

const pending = new Map();
let nextId = 0;

function settle(message) {
	const entry = pending.get(message.id);
	if (!entry) return;
	pending.delete(message.id);
	if (pending.size === 0) responses.unref();
	if (message.ok) entry.resolve(typeof message.text === "string" ? message.text : "");
	else entry.reject(new ToolError(entry.tool, String(message.error ?? "tool failed")));
}

createInterface({ input: responses, crlfDelay: Infinity }).on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message && typeof message === "object") settle(message);
});

responses.on("close", () => {
	for (const [id, entry] of pending) {
		pending.delete(id);
		entry.reject(new ToolError(entry.tool, "the code-mode host closed the tool channel"));
	}
});

function call(tool, args) {
	if (args === undefined || args === null) args = {};
	if (typeof args !== "object" || Array.isArray(args)) {
		return Promise.reject(new TypeError(`tools.${tool}() takes one object argument, e.g. tools.${tool}({ ... })`));
	}
	const id = ++nextId;
	return new Promise((resolve, reject) => {
		if (pending.size === 0) responses.ref();
		pending.set(id, { tool, resolve, reject });
		requests.write(`${JSON.stringify({ id, tool, args })}\n`);
	});
}

const names = JSON.parse(process.env.PI_CODE_MODE_TOOLS ?? "[]");
const tools = Object.freeze(Object.fromEntries(names.map((name) => [name, (args) => call(name, args)])));

globalThis.tools = tools;
globalThis.ToolError = ToolError;

await import(pathToFileURL(process.argv[2]).href);
