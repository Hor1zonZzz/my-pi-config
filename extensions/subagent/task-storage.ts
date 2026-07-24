// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export type SubagentTaskStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

export interface StoredTaskStatus {
	version: 1;
	taskId: string;
	sessionId: string;
	execution: "block" | "background";
	mode: "single" | "parallel" | "chain";
	status: SubagentTaskStatus;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
	cwd: string;
	resultPath: string;
	detailsPath: string;
	request: unknown;
	processes: {
		total: number;
		queued: number;
		running: number;
		completed: number;
		failed: number;
	};
	error?: string;
}

export interface TaskPaths {
	directory: string;
	relativeDirectory: string;
	statusPath: string;
	resultPath: string;
	detailsPath: string;
}

function safeSegment(value: string): string {
	const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_");
	return safe || "unknown";
}

function writeAtomic(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(temporaryPath, filePath);
}

export function getTaskPaths(
	cwd: string,
	sessionId: string,
	taskId: string,
): TaskPaths {
	const relativeDirectory = path.join(
		CONFIG_DIR_NAME,
		"subagent-tasks",
		safeSegment(sessionId),
		safeSegment(taskId),
	);
	const directory = path.join(cwd, relativeDirectory);
	return {
		directory,
		relativeDirectory,
		statusPath: path.join(directory, "status.json"),
		resultPath: path.join(directory, "result.md"),
		detailsPath: path.join(directory, "details.json"),
	};
}

export function initializeTaskDirectory(paths: TaskPaths): void {
	fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
}

export function writeTaskStatus(
	paths: TaskPaths,
	status: StoredTaskStatus,
): void {
	writeAtomic(paths.statusPath, `${JSON.stringify(status, null, 2)}\n`);
}

function finalOutput(result: any): string {
	for (let index = result.messages.length - 1; index >= 0; index -= 1) {
		const message = result.messages[index];
		if (message.role !== "assistant") continue;
		return message.content
			.filter((part: any) => part.type === "text")
			.map((part: any) => part.text)
			.join("\n");
	}
	return result.errorMessage || result.stderr || "";
}

export function writeTaskResults(
	paths: TaskPaths,
	status: StoredTaskStatus,
	results: any[],
): void {
	const lines = [
		`# Subagent Task ${status.taskId}`,
		"",
		`- Execution: ${status.execution}`,
		`- Mode: ${status.mode}`,
		`- Status: ${status.status}`,
		`- Session: ${status.sessionId}`,
		"",
	];
	for (let index = 0; index < results.length; index += 1) {
		const result = results[index];
		const heading =
			status.mode === "chain"
				? `## Step ${result.step ?? index + 1}: ${result.agent}`
				: `## ${result.agent}`;
		lines.push(heading, "", finalOutput(result) || "(no output)", "");
	}
	writeAtomic(paths.resultPath, `${lines.join("\n").trimEnd()}\n`);
	writeAtomic(
		paths.detailsPath,
		`${JSON.stringify({ status, results }, null, 2)}\n`,
	);
}

export function readSessionTaskStatuses(
	cwd: string,
	sessionId: string,
): StoredTaskStatus[] {
	const sessionDirectory = path.join(
		cwd,
		CONFIG_DIR_NAME,
		"subagent-tasks",
		safeSegment(sessionId),
	);
	if (!fs.existsSync(sessionDirectory)) return [];
	const statuses: StoredTaskStatus[] = [];
	for (const entry of fs.readdirSync(sessionDirectory, {
		withFileTypes: true,
	})) {
		if (!entry.isDirectory()) continue;
		const statusPath = path.join(sessionDirectory, entry.name, "status.json");
		try {
			const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
			if (status?.version === 1 && status.sessionId === sessionId) {
				statuses.push(status as StoredTaskStatus);
			}
		} catch {
			// Ignore incomplete or manually edited task directories.
		}
	}
	return statuses.sort((left, right) => left.createdAt - right.createdAt);
}

export function markStaleTasksInterrupted(
	cwd: string,
	sessionId: string,
): StoredTaskStatus[] {
	const statuses = readSessionTaskStatuses(cwd, sessionId);
	for (const status of statuses) {
		if (status.status !== "queued" && status.status !== "running") continue;
		status.status = "interrupted";
		status.processes.queued = 0;
		status.processes.running = 0;
		status.completedAt = Date.now();
		status.error = "Parent Pi session stopped before the task completed.";
		const paths = getTaskPaths(cwd, sessionId, status.taskId);
		writeTaskStatus(paths, status);
	}
	return statuses;
}
