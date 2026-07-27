// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const MAX_PARALLEL_TASKS = 8;

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		description: "Task with optional {previous} placeholder for prior output",
	}),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
});

export const SubagentParams = Type.Object({
	action: Type.Optional(
		StringEnum(["block", "background", "list", "status", "cancel"] as const, {
			description:
				"Operation. Omit it to run a valid single/parallel/chain request in blocking mode; an omitted action without exactly one execution mode returns the available agents.",
		}),
	),
	taskId: Type.Optional(
		Type.String({ description: "Task ID for status or cancel actions" }),
	),
	agent: Type.Optional(
		Type.String({
			description: "Name of the agent to invoke (for single mode)",
		}),
	),
	task: Type.Optional(
		Type.String({ description: "Task to delegate (for single mode)" }),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Array of {agent, task} for parallel execution",
			minItems: 1,
			maxItems: MAX_PARALLEL_TASKS,
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description: "Array of {agent, task} for sequential execution",
			minItems: 1,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the agent process (single mode)",
		}),
	),
});
