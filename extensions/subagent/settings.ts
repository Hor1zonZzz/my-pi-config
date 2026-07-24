// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SchedulerConfig } from "./scheduler.ts";

export const DEFAULT_SUBAGENT_SETTINGS: SchedulerConfig & { version: 1 } = {
	version: 1,
	maxConcurrentProcesses: 4,
	maxQueuedProcesses: 16,
};

function boundedInteger(
	value: unknown,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	return Number.isInteger(value) && value >= minimum && value <= maximum
		? value
		: fallback;
}

export function loadSubagentSettings(): SchedulerConfig & { version: 1 } {
	try {
		const value = JSON.parse(
			fs.readFileSync(
				path.join(getAgentDir(), "subagent-settings.json"),
				"utf8",
			),
		);
		return {
			version: 1,
			maxConcurrentProcesses: boundedInteger(
				value?.maxConcurrentProcesses,
				DEFAULT_SUBAGENT_SETTINGS.maxConcurrentProcesses,
				1,
				32,
			),
			maxQueuedProcesses: boundedInteger(
				value?.maxQueuedProcesses,
				DEFAULT_SUBAGENT_SETTINGS.maxQueuedProcesses,
				0,
				256,
			),
		};
	} catch {
		return { ...DEFAULT_SUBAGENT_SETTINGS };
	}
}
