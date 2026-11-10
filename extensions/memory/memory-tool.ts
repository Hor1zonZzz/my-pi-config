/**
 * The `memory` tool definition, shared by the main session (index.ts) and dream agents (dream-agent.ts).
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executeMemoryCommand, MEMORY_COMMANDS, type MemoryOptions, type MemoryParams } from "./tool.ts";

export const MEMORY_TOOL = "memory";

export const memoryParameters = Type.Object({
	command: StringEnum(MEMORY_COMMANDS),
	path: Type.Optional(Type.String({ description: "Path under /memories" })),
	view_range: Type.Optional(Type.Array(Type.Integer(), { minItems: 2, maxItems: 2, description: "[start, end] lines; end -1 = to the end" })),
	file_text: Type.Optional(Type.String({ description: "create: the whole file" })),
	old_str: Type.Optional(Type.String({ description: "str_replace: text that appears exactly once" })),
	new_str: Type.Optional(Type.String({ description: "str_replace: replacement; omit to delete old_str" })),
	insert_line: Type.Optional(Type.Integer({ description: "insert: line to insert after; 0 = top" })),
	insert_text: Type.Optional(Type.String({ description: "insert: text to insert" })),
	old_path: Type.Optional(Type.String({ description: "rename: current path" })),
	new_path: Type.Optional(Type.String({ description: "rename: new path" })),
});

export interface MemoryToolHooks {
	/** The notes directory, or undefined when memory is off. */
	notes(): string | undefined;
	options?: MemoryOptions;
	/** Called after a command that changed the notes. */
	onWrite?(): void;
	offMessage?: string;
}

export function createMemoryTool(hooks: MemoryToolHooks) {
	const createText = hooks.options?.overwrite === false ? "create (fails if the file exists)" : "create (creates or overwrites)";
	return defineTool({
		name: MEMORY_TOOL,
		label: "Memory",
		description: `Read and write this project's persistent memory directory /memories. Commands follow Anthropic's memory tool: view (a directory, or a file with optional view_range), ${createText}, str_replace, insert (after insert_line; 0 = top), delete, rename. Each note is one markdown file with frontmatter (name, description, type: user | feedback | project | reference) followed by the note. /memories/MEMORY.md is generated from the notes' frontmatter and cannot be edited.`,
		promptSnippet: "Read and write this project's persistent memory (/memories)",
		parameters: memoryParameters,
		async execute(_toolCallId, params) {
			const notes = hooks.notes();
			if (!notes) throw new Error(hooks.offMessage ?? "Memory is off for this project.");
			const result = await executeMemoryCommand(notes, params as MemoryParams, hooks.options);
			if (result.isError) throw new Error(result.text);
			if (result.wrote) hooks.onWrite?.();
			return { content: [{ type: "text", text: result.text }], details: { command: params.command } };
		},
	});
}
