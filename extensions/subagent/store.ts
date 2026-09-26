import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RunSnapshot } from "./runs.ts";

// Child sessions live in <agent dir>/subagent-sessions/<parent session id>/:
//   <short id>.jsonl             Pi's session file for the subagent. The extension
//                                creates it empty at dispatch and starts Pi with
//                                --session <file>, so the path is known at once
//                                and Pi writes every entry as it happens.
//   <run id>.meta.json           RunSnapshot written at start and at the end
// Runs recorded before that used Pi's own name, <timestamp>_<run id>.jsonl.

export function sessionsRoot(): string {
	return path.join(getAgentDir(), "subagent-sessions");
}

function safeSegment(value: string): string {
	return value.replace(/[^\w.-]+/g, "_").slice(0, 120) || "unknown";
}

export function parentSessionDir(parentSessionId: string): string {
	return path.join(sessionsRoot(), safeSegment(parentSessionId));
}

export function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function metaPath(snapshot: Pick<RunSnapshot, "id" | "sessionDir">): string {
	return path.join(snapshot.sessionDir, `${safeSegment(snapshot.id)}.meta.json`);
}

/** Atomic metadata write. Failures are reported to the caller, never thrown. */
export function writeMeta(snapshot: RunSnapshot): Error | undefined {
	try {
		ensureDir(snapshot.sessionDir);
		const target = metaPath(snapshot);
		const temporary = `${target}.${process.pid}.tmp`;
		const { activity: _activity, ...persisted } = snapshot;
		fs.writeFileSync(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temporary, target);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

function isSnapshot(value: unknown): value is RunSnapshot {
	const v = value as Partial<RunSnapshot> | null;
	return !!v && typeof v === "object" && v.version === 1 && typeof v.id === "string" && typeof v.agent === "string"
		&& typeof v.task === "string" && typeof v.status === "string" && typeof v.startedAt === "number";
}

/** Runs recorded for one parent session, newest first. Unreadable files are skipped. */
export function listRuns(dir: string): RunSnapshot[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const runs: RunSnapshot[] = [];
	for (const name of names) {
		if (!name.endsWith(".meta.json")) continue;
		try {
			const value = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
			if (isSnapshot(value)) runs.push({ ...value, sessionDir: dir });
		} catch {
			// Partially written or foreign file.
		}
	}
	return runs.sort((a, b) => b.startedAt - a.startedAt);
}

export function shortRunId(id: string): string {
	return id.slice(0, 8);
}

export interface ReservedRun {
	id: string;
	sessionFile: string;
}

/**
 * A new run ID whose 8-character prefix is unique in `dir`, with its empty
 * session file created exclusively, so the path can be handed out before the
 * child starts.
 */
export function reserveRun(dir: string): ReservedRun {
	ensureDir(dir);
	for (;;) {
		const id = randomUUID();
		const sessionFile = path.join(dir, `${shortRunId(id)}.jsonl`);
		try {
			fs.writeFileSync(sessionFile, "", { flag: "wx", mode: 0o600 });
			return { id, sessionFile };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
}

/** Removes a reserved session file that no run ever wrote to. */
export function releaseRun(reserved: ReservedRun): void {
	try {
		if (fs.statSync(reserved.sessionFile).size === 0) fs.rmSync(reserved.sessionFile);
	} catch {
		// Already gone.
	}
}

/** The run's session file, or the one Pi named itself for runs recorded before sessionFile existed. */
export function sessionFileOf(snapshot: Pick<RunSnapshot, "id" | "sessionDir" | "sessionFile">): string | undefined {
	if (snapshot.sessionFile) return fs.existsSync(snapshot.sessionFile) ? snapshot.sessionFile : undefined;
	return findSessionFile(snapshot.sessionDir, snapshot.id);
}

export function findSessionFile(dir: string, runId: string): string | undefined {
	try {
		const name = fs.readdirSync(dir).find((file) => file.endsWith(`_${runId}.jsonl`));
		return name ? path.join(dir, name) : undefined;
	} catch {
		return undefined;
	}
}

/** Messages from a Pi session JSONL file, in file order. Malformed lines are skipped. */
export function readSessionMessages(file: string): Message[] {
	let content: string;
	try {
		content = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const messages: Message[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line.replace(/\r$/, ""));
			if (entry?.type === "message" && entry.message && typeof entry.message.role === "string") messages.push(entry.message);
		} catch {
			// Ignore a torn final line from a process that was killed.
		}
	}
	return messages;
}
