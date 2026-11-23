/**
 * Dream, after the Claude cookbook's "dreaming with a dynamic workflow": one analyzer agent that reads
 * the new sessions from the last three days in order, oldest first, then one organizer agent over the
 * whole memory. One analyzer, not one per session: parallel analyzers writing the same notes duplicated
 * subjects and overwrote each other, and only a single reader sees a later session undo an earlier one. Each agent is its own Pi session on DeepSeek Flash (see dream-agent.ts) that
 * reads only the notes and a copy of the raw session JSONL, not the project. This module only
 * orchestrates, so it stays free of Pi imports.
 */
import { access, copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CallUsage } from "./call-log.ts";
import { appendCall } from "./call-log.ts";
import { appendLog, listNotes, rebuildIndex, snapshot, snapshotName } from "./store.ts";
import { type SessionFile, sessionsSince } from "./transcript.ts";

/** Sessions one dream reads (one analyzer); the rest wait for the next dream. */
export const DREAM_MAX_SESSIONS = 20;
export const DREAM_MIN_NEW_SESSIONS = 3;
export const DREAM_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Dreams read only sessions changed within this window: older ones describe a project that has moved on. */
export const DREAM_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** Where the next dream starts reading: after the last dream, but never earlier than the window. */
export function dreamSince(lastDreamAt: number | undefined, now = Date.now()): number {
	return Math.max(lastDreamAt ?? 0, now - DREAM_WINDOW_MS);
}
export const WORK_DIR = ".dream-work";

export interface StalePathHint {
	note: string;
	paths: string[];
}

export interface AgentTask {
	role: "analyze" | "organize";
	/** The dream's work directory and the agent's cwd: holds sessions/. */
	workDir: string;
	/** Analyze only: the copied raw session JSONL files (absolute paths) and their ids, oldest first. */
	transcripts?: { path: string; session: string }[];
	/** Organize only: repo-relative file paths mentioned in notes that no longer exist on disk. */
	stalePaths?: StalePathHint[];
}

export interface AgentRun {
	ok: boolean;
	error?: string;
	stopReason: string;
	usage: CallUsage | null;
	toolCalls: number;
	finalText: string;
	/** The agent's own session file under dreams/. */
	sessionFile?: string;
}

export interface ModelRef {
	provider: string;
	model: string;
}

export interface DreamAgents {
	/** DeepSeek Flash, or why it cannot be used. */
	model: ModelRef | { unavailable: string };
	run(task: AgentTask, signal: AbortSignal): Promise<AgentRun>;
}

export interface DreamInput {
	dir: string;
	notes: string;
	/** Project working directory, used only for deterministic stale-path checks before organize. */
	projectDir?: string;
	/** Pi's session directory for this project. */
	sessionDir: string;
	/** The running session: left out of the review and used to attribute calls. */
	session: string;
	/** The last dream's lastDreamAt; sessions are read after it, within DREAM_WINDOW_MS. */
	since: number;
	agents: DreamAgents;
	signal: AbortSignal;
	now?: Date;
	maxSessions?: number;
}

export interface DreamResult {
	status: "nothing" | "done" | "unavailable" | "aborted" | "error";
	reason?: string;
	sessions: number;
	failedSessions: number;
	created: number;
	updated: number;
	deleted: number;
	organizeFailed: boolean;
	/** The new lastDreamAt: the newest session file read. Unset unless status is "done" or "nothing". */
	readUntil?: number;
}

const REPO_FILE_EXT = "(?:ts|tsx|js|jsx|mjs|cjs|py|sh|md|json|yaml|yml|sql|toml)";
const REPO_PATH_RE = new RegExp(
	`(?<![A-Za-z0-9_./:-])([A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)+\\.${REPO_FILE_EXT})(?![A-Za-z0-9_./-])`,
	"g",
);

/**
 * Finds repo-relative file paths mentioned in notes that no longer exist under projectDir.
 * Only checks paths whose first segment is an existing top-level directory in projectDir,
 * so URLs, remote server paths, and placeholder patterns are never flagged.
 */
export async function findStaleRepoPaths(notes: string, projectDir: string): Promise<StalePathHint[]> {
	let topDirs: Set<string>;
	try {
		const entries = await readdir(projectDir, { withFileTypes: true });
		topDirs = new Set(entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name));
	} catch {
		return [];
	}
	if (topDirs.size === 0) return [];
	const out: StalePathHint[] = [];
	const cache = new Map<string, boolean>();
	for (const note of await listNotes(notes)) {
		const missing = new Set<string>();
		for (const match of note.body.matchAll(REPO_PATH_RE)) {
			const candidate = match[1];
			if (candidate.includes("..")) continue;
			const first = candidate.slice(0, candidate.indexOf("/"));
			if (!topDirs.has(first)) continue;
			let exists = cache.get(candidate);
			if (exists === undefined) {
				try {
					await access(join(projectDir, candidate));
					exists = true;
				} catch {
					exists = false;
				}
				cache.set(candidate, exists);
			}
			if (!exists) missing.add(candidate);
		}
		if (missing.size > 0) out.push({ note: note.path, paths: [...missing].sort() });
	}
	return out;
}

async function noteTexts(notes: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const note of await listNotes(notes)) {
		try {
			out.set(note.path, await readFile(join(notes, note.path), "utf8"));
		} catch {}
	}
	return out;
}

async function recordRun(
	input: DreamInput,
	ref: ModelRef,
	role: "deepseek-analyze" | "deepseek-organize",
	task: Record<string, unknown>,
	started: number,
	run: AgentRun,
): Promise<void> {
	await appendCall(input.dir, {
		ts: new Date(started).toISOString(),
		session: input.session,
		role,
		provider: ref.provider,
		model: ref.model,
		reasoning: "high",
		latencyMs: Date.now() - started,
		usage: run.usage,
		stopReason: run.stopReason,
		error: run.error ?? null,
		input: task,
		output: { finalText: run.finalText, toolCalls: run.toolCalls, sessionFile: run.sessionFile ?? null },
		outcome: run.ok ? "applied" : "error",
	}).catch(() => {});
}

async function safeRun(agents: DreamAgents, task: AgentTask, signal: AbortSignal): Promise<AgentRun> {
	try {
		return await agents.run(task, signal);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message, stopReason: "error", usage: null, toolCalls: 0, finalText: "" };
	}
}

export async function dream(input: DreamInput): Promise<DreamResult> {
	const result: DreamResult = {
		status: "done",
		sessions: 0,
		failedSessions: 0,
		created: 0,
		updated: 0,
		deleted: 0,
		organizeFailed: false,
	};
	const { agents, signal } = input;
	if ("unavailable" in agents.model) return { ...result, status: "unavailable", reason: agents.model.unavailable };
	const ref = agents.model;
	const now = input.now ?? new Date();
	const since = dreamSince(input.since, now.getTime());
	const sessions = (await sessionsSince(input.sessionDir, since, input.session)).slice(0, input.maxSessions ?? DREAM_MAX_SESSIONS);
	if (sessions.length === 0) return { ...result, status: "nothing", readUntil: input.since };

	// Leftovers of a crashed dream are discarded; the lock guarantees no other dream is running.
	await rm(join(input.dir, WORK_DIR), { recursive: true, force: true });
	const workDir = join(input.dir, WORK_DIR, snapshotName(now));
	try {
		await snapshot(input.dir, now);
		await rebuildIndex(input.notes);
		const before = await noteTexts(input.notes);

		// Copy each raw session file, so the analyzer reads a stable copy even if that session is still running.
		await mkdir(join(workDir, "sessions"), { recursive: true });
		const files: { session: SessionFile; path: string }[] = [];
		for (const [i, session] of sessions.entries()) {
			const path = join(workDir, "sessions", `${String(i + 1).padStart(2, "0")}-${session.id.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`);
			await copyFile(session.path, path);
			files.push({ session, path });
		}

		// Analyze: one agent reads every session copy, oldest first, and is the only writer until the organizer.
		if (signal.aborted) return { ...result, status: "aborted" };
		const transcripts = files.map((file) => ({ path: file.path, session: file.session.id }));
		const started = Date.now();
		const analysis = await safeRun(agents, { role: "analyze", workDir, transcripts }, signal);
		await recordRun(input, ref, "deepseek-analyze", { transcripts }, started, analysis);
		if (signal.aborted) return { ...result, status: "aborted" };
		result.sessions = files.length;
		// A failed analysis may have changed some notes; nothing counts as read, so every session is read again next time.
		if (!analysis.ok) {
			await rebuildIndex(input.notes);
			return { ...result, failedSessions: files.length, status: "error", reason: analysis.error ?? "analysis failed" };
		}

		// Organize the whole store once.
		if ((await listNotes(input.notes)).length > 1) {
			const stalePaths = input.projectDir ? await findStaleRepoPaths(input.notes, input.projectDir) : [];
			const started = Date.now();
			const run = await safeRun(agents, { role: "organize", workDir, ...(stalePaths.length > 0 ? { stalePaths } : {}) }, signal);
			await recordRun(input, ref, "deepseek-organize", stalePaths.length > 0 ? { stalePaths } : {}, started, run);
			if (signal.aborted) return { ...result, status: "aborted" };
			result.organizeFailed = !run.ok;
		}

		// What changed, measured on disk rather than taken from the agents' word.
		await rebuildIndex(input.notes);
		const after = await noteTexts(input.notes);
		for (const [path, text] of after) {
			if (!before.has(path)) result.created += 1;
			else if (before.get(path) !== text) result.updated += 1;
		}
		for (const path of before.keys()) if (!after.has(path)) result.deleted += 1;

		await appendLog(
			input.dir,
			`dream read ${result.sessions} sessions (${result.failedSessions} failed${result.organizeFailed ? ", organize failed" : ""}): created ${result.created}, updated ${result.updated}, deleted ${result.deleted}`,
			now,
		);
		result.readUntil = sessions[sessions.length - 1].mtimeMs;
		return result;
	} finally {
		await rm(join(input.dir, WORK_DIR), { recursive: true, force: true });
	}
}
