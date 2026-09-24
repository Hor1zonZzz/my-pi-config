import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { type ImageContent, type Tool, type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Language } from "./runtime.ts";

/** Pi's built-in tools, in the order they are documented to the model. */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

/** Pi's default active tool set, restored when nothing better is known. */
export const DEFAULT_ACTIVE_BUILTINS: readonly string[] = ["read", "bash", "edit", "write"];

/** Images attached to one execute_code result. */
const MAX_IMAGES = 8;
/** Nested calls kept in result details for rendering. */
const MAX_RECORDED_CALLS = 200;

type AnyTool = ToolDefinition<any, any, any>;

export function isBuiltinTool(name: string): name is BuiltinTool {
	return (BUILTIN_TOOLS as readonly string[]).includes(name);
}

/**
 * Built-in tool definitions with the settings Pi's AgentSession applies when it
 * builds its own tools (image resizing, shell path and command prefix).
 */
export function createBuiltinTools(cwd: string, settings?: SettingsManager): Map<BuiltinTool, AnyTool> {
	const tools: Array<[BuiltinTool, AnyTool]> = [
		["read", createReadToolDefinition(cwd, settings ? { autoResizeImages: settings.getImageAutoResize() } : undefined)],
		[
			"bash",
			createBashToolDefinition(
				cwd,
				settings ? { commandPrefix: settings.getShellCommandPrefix(), shellPath: settings.getShellPath() } : undefined,
			),
		],
		["edit", createEditToolDefinition(cwd)],
		["write", createWriteToolDefinition(cwd)],
		["grep", createGrepToolDefinition(cwd)],
		["find", createFindToolDefinition(cwd)],
		["ls", createLsToolDefinition(cwd)],
	];
	return new Map(tools);
}

/** The entries of `tools` named in `names`, in `names` order. */
export function pickTools<T>(tools: ReadonlyMap<string, T>, names: readonly string[]): Map<string, T> {
	const picked = new Map<string, T>();
	for (const name of names) {
		const tool = tools.get(name);
		if (tool) picked.set(name, tool);
	}
	return picked;
}

/** Caches built-in tools per working directory and project-trust state. */
export class BuiltinToolCache {
	private readonly entries = new Map<string, Map<BuiltinTool, AnyTool>>();

	get(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): Map<BuiltinTool, AnyTool> {
		const trusted = ctx.isProjectTrusted();
		const key = `${ctx.cwd}\0${trusted}`;
		let tools = this.entries.get(key);
		if (!tools) {
			const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: trusted });
			tools = createBuiltinTools(ctx.cwd, settings);
			this.entries.set(key, tools);
		}
		return tools;
	}
}

// ---------------------------------------------------------------------------
// Model-facing API documentation, generated from each tool's own schema.

interface JsonSchema {
	type?: string | string[];
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: unknown[];
	const?: unknown;
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
}

function typeOf(schema: JsonSchema | undefined, language: Language): string {
	const py = language === "python";
	if (!schema) return py ? "Any" : "unknown";
	if (schema.const !== undefined) return JSON.stringify(schema.const);
	if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
	const union = schema.anyOf ?? schema.oneOf;
	if (union) return union.map((part) => typeOf(part, language)).join(" | ");
	const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
	switch (type) {
		case "string":
			return py ? "str" : "string";
		case "boolean":
			return py ? "bool" : "boolean";
		case "number":
			return py ? "float" : "number";
		case "integer":
			return py ? "int" : "number";
		case "null":
			return py ? "None" : "null";
		case "array": {
			const item = typeOf(schema.items, language);
			if (py) return `list[${item}]`;
			return /[ |]/.test(item) && !item.startsWith("{") ? `(${item})[]` : `${item}[]`;
		}
		case "object": {
			// Python dict keys are listed as nested fields below the parameter.
			if (!schema.properties || py) return py ? "dict" : "object";
			const required = new Set(schema.required ?? []);
			const fields = Object.entries(schema.properties).map(
				([name, field]) => `${name}${required.has(name) ? "" : "?"}: ${typeOf(field, language)}`,
			);
			return `{ ${fields.join("; ")} }`;
		}
		default:
			return py ? "Any" : "unknown";
	}
}

function describeFields(schema: JsonSchema, depth: number, language: Language): string[] {
	const py = language === "python";
	const bullet = `${"  ".repeat(depth + 1)}- `;
	const required = new Set(schema.required ?? []);
	const lines: string[] = [];
	for (const [name, field] of Object.entries(schema.properties ?? {})) {
		const optional = required.has(name) ? "" : py ? " (optional)" : "?";
		const description = field.description ? ` — ${field.description}` : "";
		const label = py ? `${name}: ${typeOf(field, language)}${optional}` : `${name}${optional}: ${typeOf(field, language)}`;
		lines.push(`${bullet}${label}${description}`);
		const nested = field.type === "array" ? field.items : field;
		const children = Object.values(nested?.properties ?? {});
		if (children.length && (py || children.some((child) => child.description))) {
			lines.push(...describeFields(nested!, depth + 1, language));
		}
	}
	return lines;
}

/** One tool's entry in the execute_code API reference, written for `language`. */
export function describeTool(
	name: string,
	tool: Pick<AnyTool, "description" | "parameters" | "promptGuidelines">,
	language: Language = "javascript",
): string {
	const schema = tool.parameters as JsonSchema;
	const required = new Set(schema.required ?? []);
	const keys = Object.keys(schema.properties ?? {});
	let signature: string;
	if (language === "python") {
		// Required parameters first, then optional ones with a None default.
		const ordered = [...keys.filter((key) => required.has(key)), ...keys.filter((key) => !required.has(key))];
		const params = ordered.map((key) => (required.has(key) ? key : `${key}=None`));
		signature = `tools.${name}(${params.join(", ")}) -> str`;
	} else {
		signature = keys.length
			? `tools.${name}({ ${keys.map((key) => `${key}${required.has(key) ? "" : "?"}`).join(", ")} }) → string`
			: `tools.${name}() → string`;
	}
	const lines = [signature, `  ${tool.description.trim()}`, ...describeFields(schema, 0, language)];
	for (const guideline of tool.promptGuidelines ?? []) lines.push(`  Note: ${guideline}`);
	return lines.join("\n");
}

const LANGUAGE_GUIDE: Record<Language, { name: string; usage: string; failure: string; imports: string; example: string }> = {
	javascript: {
		name: "JavaScript (Node.js ES module)",
		usage:
			'Top-level await is supported. Call `await tools.read({ path: "src/a.ts" })`; run independent calls concurrently with Promise.all. Load Node modules with import statements or `await import(...)`; `require` is not defined. Print with console.log.',
		failure: "throws `ToolError` (a global class; `error.tool` names the tool)",
		imports: "Only Node built-in modules can be imported.",
		example: "tools.read, not fs",
	},
	python: {
		name: "Python 3",
		usage:
			'Calls are synchronous. Call `tools.read(path="src/a.ts")` with keyword arguments, or pass one dict: `tools.read({"path": "src/a.ts"})`. Print with print().',
		failure: "raises `ToolError` (a global exception; `error.tool` names the tool)",
		imports: "Only the Python standard library and packages installed with the interpreter can be imported.",
		example: "tools.read, not open()",
	},
};

/** The execute_code tool description for `language`, including the generated API reference. */
export function describeApi(
	tools: ReadonlyMap<string, Pick<AnyTool, "description" | "parameters" | "promptGuidelines">>,
	options: { sandbox?: boolean; language?: Language } = {},
): string {
	const language = options.language ?? "javascript";
	const guide = LANGUAGE_GUIDE[language];
	const names = [...tools.keys()];
	const reference = names.length
		? [...tools].map(([name, tool]) => describeTool(name, tool, language)).join("\n\n")
		: "(none: no built-in tools are enabled, so the global `tools` object is empty)";
	const available = names.length
		? `The enabled built-in tools (${names.join(", ")}) are available only inside the program, as functions on a global \`tools\` object.`
		: "No built-in tools are enabled, so programs can only compute and print.";
	const environment = options.sandbox
		? `

The program runs in a sandbox: it cannot read or write files, use the network, or start processes itself. Do all file and shell access through the functions on \`tools\` (for example ${guide.example}); paths you pass to them resolve against the working directory. ${guide.imports} Scratch files may be written under $TMPDIR, which is deleted after the run.`
		: "";
	return `Run a ${guide.name} program in the current working directory. Programs must be written in ${language === "python" ? "Python" : "JavaScript"}. ${available}${environment}

Only what the program prints (stdout and stderr) is returned to you; tool results stay in the program unless you print them. Filter, aggregate, and loop in code, and print just what you need. Output is truncated to the last 2000 lines or 50KB; if truncated, the full output is saved to a temp file.

${guide.usage}

Every call returns the tool's text output as a string. A failed call ${guide.failure} whose message is the tool's error text; for bash this includes a non-zero exit, with the command output in the message. Images read with tools.read are attached to this tool's result. The program runs in a separate process; it is killed when it exceeds \`timeout\` or the user interrupts.

API:

${reference}`;
}

// ---------------------------------------------------------------------------
// Dispatch of tool calls coming from a running program.

export interface NestedCall {
	tool: string;
	/** Short argument summary, e.g. a path or command. */
	label: string;
	status: "running" | "ok" | "error";
	error?: string;
	durationMs?: number;
}

function firstLine(text: string, max = 120): string {
	const line = text.split("\n").find((part) => part.trim()) ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function displayPath(path: string, cwd: string): string {
	if (!isAbsolute(path)) return path;
	const rel = relative(cwd, path);
	if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function callLabel(tool: string, args: unknown, cwd: string): string {
	const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	if (tool === "bash" && typeof input.command === "string") return firstLine(input.command);
	if ((tool === "grep" || tool === "find") && typeof input.pattern === "string") {
		const where = typeof input.path === "string" ? ` in ${displayPath(input.path, cwd)}` : "";
		return firstLine(`${input.pattern}${where}`);
	}
	if (typeof input.path === "string") return displayPath(input.path, cwd);
	return tool === "ls" ? "." : "";
}

/** Runs the program's tool calls against Pi's built-in tool definitions and records them. */
export class ToolBridge {
	readonly calls: NestedCall[] = [];
	readonly images: ImageContent[] = [];
	callCount = 0;
	private omittedImages = 0;

	private readonly tools: ReadonlyMap<string, AnyTool>;
	private readonly ctx: ExtensionContext;
	private readonly parentCallId: string;
	private readonly onChange: () => void;
	private readonly now: () => number;

	constructor(
		tools: ReadonlyMap<string, AnyTool>,
		ctx: ExtensionContext,
		parentCallId: string,
		onChange: () => void = () => {},
		now: () => number = Date.now,
	) {
		this.tools = tools;
		this.ctx = ctx;
		this.parentCallId = parentCallId;
		this.onChange = onChange;
		this.now = now;
	}

	get droppedImages(): number {
		return this.omittedImages;
	}

	async call(name: string, rawArgs: unknown, signal: AbortSignal): Promise<string> {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`Unknown tool "${name}". Available: ${[...this.tools.keys()].join(", ")}`);
		const id = `${this.parentCallId}:${++this.callCount}`;
		const record: NestedCall = { tool: name, label: callLabel(name, rawArgs, this.ctx.cwd), status: "running" };
		this.calls.push(record);
		if (this.calls.length > MAX_RECORDED_CALLS) this.calls.shift();
		this.onChange();
		const started = this.now();
		try {
			const prepared = tool.prepareArguments ? tool.prepareArguments(rawArgs) : rawArgs;
			const toolCall: ToolCall = { type: "toolCall", id, name, arguments: (prepared ?? {}) as Record<string, any> };
			const args = validateToolArguments(tool as unknown as Tool, toolCall);
			const result = await tool.execute(id, args, signal, undefined, this.ctx);
			record.status = "ok";
			return this.collect(result.content ?? []);
		} catch (error) {
			record.status = "error";
			const message = error instanceof Error ? error.message : String(error);
			record.error = firstLine(message);
			throw error instanceof Error ? error : new Error(message);
		} finally {
			record.durationMs = this.now() - started;
			this.onChange();
		}
	}

	private collect(content: ReadonlyArray<{ type: string; text?: string } | ImageContent>): string {
		const texts: string[] = [];
		for (const block of content) {
			if (block.type === "text" && typeof (block as { text?: string }).text === "string") {
				texts.push((block as { text: string }).text);
			} else if (block.type === "image") {
				if (this.images.length < MAX_IMAGES) {
					this.images.push(block as ImageContent);
					texts.push(`[${(block as ImageContent).mimeType} image attached to the execute_code result]`);
				} else {
					this.omittedImages++;
					texts.push(`[image omitted: execute_code attaches at most ${MAX_IMAGES} images]`);
				}
			}
		}
		return texts.join("\n");
	}
}
