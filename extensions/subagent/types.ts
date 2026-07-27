// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentExtensionMode } from "./agents.ts";
import type { SubagentTaskStatus } from "./task-storage.ts";

export type ExecutionMode = "single" | "parallel" | "chain";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	extensionMode: AgentExtensionMode;
	extensionSources: string[];
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

export interface SubagentDetails {
	mode: ExecutionMode;
	projectAgentsDir: string | null;
	results: SingleResult[];
	taskId?: string;
	taskStatus?: SubagentTaskStatus;
	resultPath?: string;
}

export interface ExecutionRequest {
	agent?: string;
	task?: string;
	tasks?: Array<{ agent: string; task: string; cwd?: string }>;
	chain?: Array<{ agent: string; task: string; cwd?: string }>;
	cwd?: string;
}

export interface PlanExecution {
	mode: ExecutionMode;
	results: SingleResult[];
	content: string;
	failed: boolean;
}

export type OnUpdateCallback = (
	partial: AgentToolResult<SubagentDetails>,
) => void;

export type RunProcess = <T>(runner: () => Promise<T>) => Promise<T>;
