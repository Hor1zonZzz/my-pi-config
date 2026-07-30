import vm from "node:vm";
import { createInterface } from "node:readline";

const MAX_TOOL_CALLS = 64;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2_000;
const MAX_OUTPUT_ITEMS = 256;
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_PROTOCOL_LINE_BYTES = 24 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

const pendingTools = new Map();
let nextToolCallId = 1;
let executionStarted = false;
let outputBytes = 0;
let outputLines = 0;
let imageCount = 0;
let totalImageBytes = 0;
const output = [];

process.stdout.on("error", () => process.exit(1));

function send(message, callback) {
	const line = `${JSON.stringify(message)}\n`;
	if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
		throw new Error("Code Mode protocol message exceeded the 24MB limit.");
	}
	process.stdout.write(line, callback);
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function stringifyText(value) {
	if (typeof value === "string") return value;
	if (value === undefined) return "undefined";
	try {
		const serialized = JSON.stringify(value, null, 2);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}

function addText(value) {
	if (output.length >= MAX_OUTPUT_ITEMS) {
		throw new Error(
			`Code Mode output is limited to ${MAX_OUTPUT_ITEMS} items.`,
		);
	}
	const text = stringifyText(value);
	const bytes = Buffer.byteLength(text, "utf8");
	const lines = text.length === 0 ? 0 : text.split("\n").length;
	if (outputBytes + bytes > MAX_OUTPUT_BYTES) {
		throw new Error("Code Mode text output exceeded the 50KB limit.");
	}
	if (outputLines + lines > MAX_OUTPUT_LINES) {
		throw new Error("Code Mode text output exceeded the 2,000-line limit.");
	}
	outputBytes += bytes;
	outputLines += lines;
	output.push({ type: "text", text });
}

function parseDataUrl(value) {
	const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
	if (!match) return undefined;
	return {
		mimeType: match[1].toLowerCase(),
		data: match[2].replace(/\s+/g, ""),
	};
}

function normalizeImage(value) {
	let candidate;
	if (typeof value === "string") {
		candidate = parseDataUrl(value);
	} else if (value && typeof value === "object" && !Array.isArray(value)) {
		if (
			value.type === "image" &&
			typeof value.data === "string" &&
			typeof value.mimeType === "string"
		) {
			candidate = { data: value.data, mimeType: value.mimeType.toLowerCase() };
		} else if (
			value.image_url &&
			typeof value.image_url === "object" &&
			typeof value.image_url.url === "string"
		) {
			candidate = parseDataUrl(value.image_url.url);
		}
	}
	if (!candidate) {
		throw new Error(
			"image(...) expects Pi/MCP image content or a base64 data:image URL.",
		);
	}
	if (!SUPPORTED_IMAGE_MIME_TYPES.has(candidate.mimeType)) {
		throw new Error(`Unsupported image MIME type: ${candidate.mimeType}`);
	}
	if (candidate.data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) {
		throw new Error("Code Mode image exceeded the 10MB limit.");
	}
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(candidate.data)) {
		throw new Error("Code Mode image data is not valid base64.");
	}
	const bytes = Buffer.from(candidate.data, "base64");
	if (bytes.byteLength > MAX_IMAGE_BYTES) {
		throw new Error("Code Mode image exceeded the 10MB limit.");
	}
	if (totalImageBytes + bytes.byteLength > MAX_TOTAL_IMAGE_BYTES) {
		throw new Error("Code Mode image output exceeded the 16MB total limit.");
	}
	totalImageBytes += bytes.byteLength;
	return candidate;
}

function addImage(value) {
	if (output.length >= MAX_OUTPUT_ITEMS) {
		throw new Error(
			`Code Mode output is limited to ${MAX_OUTPUT_ITEMS} items.`,
		);
	}
	if (imageCount >= MAX_IMAGES) {
		throw new Error(`Code Mode output is limited to ${MAX_IMAGES} images.`);
	}
	const image = normalizeImage(value);
	imageCount += 1;
	output.push({ type: "image", data: image.data, mimeType: image.mimeType });
}

function callTool(name, input = {}) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return Promise.reject(
			new Error(`tools.${name}(...) expects an input object.`),
		);
	}
	if (nextToolCallId > MAX_TOOL_CALLS) {
		return Promise.reject(
			new Error(`Code Mode is limited to ${MAX_TOOL_CALLS} nested tool calls.`),
		);
	}
	const id = String(nextToolCallId++);
	return new Promise((resolve, reject) => {
		pendingTools.set(id, { resolve, reject });
		try {
			send({ type: "tool_call", id, name, input });
		} catch (error) {
			pendingTools.delete(id);
			reject(error);
		}
	});
}

async function executeCell(message) {
	const timeoutMs = Number(message.timeoutMs);
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
		throw new Error("Invalid Code Mode timeout.");
	}
	if (typeof message.code !== "string" || message.code.trim().length === 0) {
		throw new Error("Code Mode requires non-empty JavaScript code.");
	}
	const definitions = Array.isArray(message.tools) ? message.tools : [];
	const sandbox = Object.create(null);
	Object.defineProperties(sandbox, {
		__codeModeCallTool: {
			value: callTool,
			configurable: true,
			writable: false,
		},
		__codeModeText: { value: addText, configurable: true, writable: false },
		__codeModeImage: { value: addImage, configurable: true, writable: false },
		__codeModeDefinitions: {
			value: definitions,
			configurable: true,
			writable: false,
		},
	});
	const context = vm.createContext(sandbox, {
		name: "pi-code-mode",
		codeGeneration: { strings: false, wasm: false },
	});
	const bootstrap = new vm.Script(
		`
(() => {
  "use strict";
  const hostCallTool = __codeModeCallTool;
  const hostText = __codeModeText;
  const hostImage = __codeModeImage;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const safeError = (error) => {
    try {
      return error && typeof error.message === "string" ? error.message : String(error);
    } catch {
      return "Host callback failed.";
    }
  };
  const deepFreeze = (value, seen = new Set()) => {
    if (!value || typeof value !== "object" || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    return Object.freeze(value);
  };
  const allTools = deepFreeze(clone(__codeModeDefinitions));
  const toolFunctions = Object.create(null);
  for (const definition of allTools) {
    if (!definition || typeof definition.name !== "string") continue;
    const name = definition.name;
    Object.defineProperty(toolFunctions, name, {
      value: (input = {}) => new Promise((resolve, reject) => {
        let pending;
        try {
          pending = hostCallTool(name, input);
        } catch (error) {
          reject(new Error(safeError(error)));
          return;
        }
        pending.then(
          (value) => {
            try {
              resolve(clone(value));
            } catch (error) {
              reject(new Error(safeError(error)));
            }
          },
          (error) => reject(new Error(safeError(error))),
        );
      }),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  Object.freeze(toolFunctions);
  const textOutput = (value) => {
    try {
      hostText(value);
    } catch (error) {
      throw new Error(safeError(error));
    }
  };
  const imageOutput = (value) => {
    try {
      hostImage(value);
    } catch (error) {
      throw new Error(safeError(error));
    }
  };
  delete globalThis.__codeModeCallTool;
  delete globalThis.__codeModeText;
  delete globalThis.__codeModeImage;
  delete globalThis.__codeModeDefinitions;
  Object.defineProperties(globalThis, {
    tools: { value: toolFunctions, enumerable: true, writable: false },
    ALL_TOOLS: { value: allTools, enumerable: true, writable: false },
    text: { value: textOutput, enumerable: true, writable: false },
    image: { value: imageOutput, enumerable: true, writable: false },
    console: { value: undefined, enumerable: false, writable: false },
  });
})()
`,
		{ filename: "code-mode-bootstrap.js" },
	);
	bootstrap.runInContext(context, { timeout: 1_000 });
	const source = `(async () => {\n"use strict";\n${message.code}\n})()`;
	const script = new vm.Script(source, {
		filename: "code-mode-cell.js",
		displayErrors: true,
	});
	const synchronousBudgetMs = Math.min(timeoutMs, 1_000);
	const returned = script.runInContext(context, {
		timeout: synchronousBudgetMs,
	});
	await returned;
	if (output.length === 0) {
		addText(
			"Code completed with no explicit output. Call text(...) or image(...).",
		);
	}
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
	if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
		send(
			{ type: "error", message: "Code Mode protocol input exceeded 24MB." },
			() => process.exit(1),
		);
		return;
	}
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		send({ type: "error", message: "Code Mode received invalid JSON." }, () =>
			process.exit(1),
		);
		return;
	}
	if (message.type === "tool_result" || message.type === "tool_error") {
		const pending = pendingTools.get(String(message.id));
		if (!pending) return;
		pendingTools.delete(String(message.id));
		if (message.type === "tool_error") {
			pending.reject(
				new Error(String(message.message ?? "Nested tool failed.")),
			);
		} else {
			pending.resolve(message.result);
		}
		return;
	}
	if (message.type !== "execute" || executionStarted) {
		send(
			{ type: "error", message: "Code Mode expected one execute message." },
			() => process.exit(1),
		);
		return;
	}
	executionStarted = true;
	void executeCell(message).then(
		() => send({ type: "complete", output }, () => process.exit(0)),
		(error) =>
			send(
				{
					type: "error",
					message: errorMessage(error),
					stack: error instanceof Error ? error.stack : undefined,
				},
				() => process.exit(1),
			),
	);
});

process.stdin.on("end", () => process.exit(1));

send({ type: "ready", protocol: 1 });
