// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { isSafeCommand } from "../plan-mode/utils.ts";

export const BUILTIN_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export interface NestedToolResult {
	content: Array<
		| { type: "text"; text: string }
		| { type: "image"; data: string; mimeType: string }
	>;
	details?: unknown;
	isError: false;
}

export interface BuiltinToolBroker {
	toolDefinitions: Array<{
		name: BuiltinToolName;
		description: string;
		parameters: unknown;
	}>;
	execute(
		name: string,
		input: unknown,
		nestedCallId: string,
	): Promise<NestedToolResult>;
}

function cloneDetails(value: unknown): unknown {
	if (value === undefined) return undefined;
	try {
		return structuredClone(value);
	} catch {
		return "[Nested tool details could not be cloned]";
	}
}

export function createBuiltinToolBroker(options: {
	ctx: ExtensionContext;
	signal: AbortSignal;
	allowedTools: ReadonlySet<string>;
	isPlanModeEnabled: () => boolean;
}): BuiltinToolBroker {
	const definitions = [
		createReadToolDefinition(options.ctx.cwd),
		createBashToolDefinition(options.ctx.cwd),
		createEditToolDefinition(options.ctx.cwd),
		createWriteToolDefinition(options.ctx.cwd),
		createGrepToolDefinition(options.ctx.cwd),
		createFindToolDefinition(options.ctx.cwd),
		createLsToolDefinition(options.ctx.cwd),
	];
	const byName = new Map(
		definitions.map((definition) => [definition.name, definition]),
	);
	const toolDefinitions: BuiltinToolBroker["toolDefinitions"] = [];
	for (const definition of definitions) {
		if (!options.allowedTools.has(definition.name)) continue;
		toolDefinitions.push({
			name: definition.name as BuiltinToolName,
			description: definition.description,
			parameters: definition.parameters,
		});
	}

	return {
		toolDefinitions,

		async execute(name, input, nestedCallId) {
			if (!options.allowedTools.has(name)) {
				throw new Error(
					`Nested tool "${name}" is disabled by the current Pi tool policy.`,
				);
			}
			const definition = byName.get(name);
			if (!definition) {
				throw new Error(
					`Unknown nested tool "${name}". Available tools: ${
						toolDefinitions.map((tool) => tool.name).join(", ") || "none"
					}.`,
				);
			}
			if (options.signal.aborted)
				throw new Error("Code Mode execution aborted.");

			const prepared = definition.prepareArguments
				? definition.prepareArguments(input)
				: input;
			const params = validateToolArguments(definition, {
				id: nestedCallId,
				name,
				arguments: prepared,
			});

			if (
				name === "bash" &&
				options.isPlanModeEnabled() &&
				!isSafeCommand(params.command)
			) {
				throw new Error(
					`Plan mode blocked nested bash command: ${params.command}`,
				);
			}

			const result = await definition.execute(
				nestedCallId,
				params,
				options.signal,
				undefined,
				options.ctx,
			);
			const content = result.content.filter(
				(item) => item.type === "text" || item.type === "image",
			) as NestedToolResult["content"];
			return {
				content,
				details: cloneDetails(result.details),
				isError: false,
			};
		},
	};
}
