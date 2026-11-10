/**
 * Dream, after the Claude cookbook's "dreaming with a dynamic workflow": one analyzer agent per new
 * session from the last three days (in groups of about 20, run in parallel), then one organizer agent
 * over the whole memory. Each agent is its own Pi session on DeepSeek Flash (see dream-agent.ts) that
 * reads only the notes and a copy of the raw session JSONL, not the project. This module only
 * orchestrates, so it stays free of Pi imports.
 */
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CallUsage } from "./call-log.ts";
import { appendCall } from "./call-log.ts";
import type { ModelRef } from "./port.ts";
import { appendLog, deleteNote, listNotes, type NoteInfo, rebuildIndex, snapshot, snapshotName, writeNote } from "./store.ts";
import { type SessionFile, sessionsSince } from "./transcript.ts";

export const DREAM_MAX_SESSIONS = 20;
export const DREAM_GROUP_SIZE = 20;
/** A passive note is removed after this many dreams that read its source session could not confirm it. */
export const PASSIVE_UNVERIFIED_LIMIT = 2;
export const DREAM_MIN_NEW_SESSIONS = 3;
export const DREAM_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Dreams read only sessions changed within this window: older ones describe a project that has moved on. */
export const DREAM_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** Where the next dream starts reading: after the last dream, but never earlier than the window. */
export function dreamSince(lastDreamAt: number | undefined, now = Date.now()): number {
	return Math.max(lastDreamAt ?? 0, now - DREAM_WINDOW_MS);
}
export const WORK_DIR = ".dream-work";

export interface AgentTask {
	role: "analyze" | "organize";
	/** The dream's work directory and the agent's cwd: holds sessions/. */
	workDir: string;
	/** Analyze only: absolute path of the copied raw session JSONL. */
	transcript?: string;
	/** Analyze only: the session's id. */
	session?: string;
	/** Analyze only: passive notes the agent may confirm. */
	passiveCandidates: ReadonlySet<string>;
}

export interface AgentRun {
	ok: boolean;
	error?: string;
	stopReason: string;
	/** Names the analyzer confirmed with confirm_passive. */
	confirmed: string[];
	usage: CallUsage | null;
	toolCalls: number;
	finalText: string;
	/** The agent's own session file under dreams/. */
	sessionFile?: string;
}

export interface DreamAgents {
	/** DeepSeek Flash, or why it cannot be used. */
	model: ModelRef | { unavailable: string };
	run(task: AgentTask, signal: AbortSignal): Promise<AgentRun>;
}

export interface DreamInput {
	dir: string;
	notes: string;
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
	groupSize?: number;
}

export interface DreamResult {
	status: "nothing" | "done" | "unavailable" | "aborted" | "error";
	reason?: string;
	sessions: number;
	failedSessions: number;
	created: number;
	updated: number;
	deleted: number;
	confirmed: number;
	removedPassive: number;
	organizeFailed: boolean;
	/** The new lastDreamAt: the newest session file read. Unset unless status is "done" or "nothing". */
	readUntil?: number;
}

function isPassiveUnverified(note: NoteInfo): boolean {
	return note.meta.source === "passive" && !note.meta.verified;
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
		output: { finalText: run.finalText, confirmed: run.confirmed, toolCalls: run.toolCalls, sessionFile: run.sessionFile ?? null },
		outcome: run.ok ? "applied" : "error",
	}).catch(() => {});
}

async function safeRun(agents: DreamAgents, task: AgentTask, signal: AbortSignal): Promise<AgentRun> {
	try {
		return await agents.run(task, signal);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message, stopReason: "error", confirmed: [], usage: null, toolCalls: 0, finalText: "" };
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
		confirmed: 0,
		removedPassive: 0,
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
		const passiveBefore = new Set((await listNotes(input.notes)).filter(isPassiveUnverified).map((note) => note.name));

		// Copy each raw session file, so the analyzer reads a stable copy even if that session is still running.
		await mkdir(join(workDir, "sessions"), { recursive: true });
		const files: { session: SessionFile; path: string }[] = [];
		for (const [i, session] of sessions.entries()) {
			const path = join(workDir, "sessions", `${String(i + 1).padStart(2, "0")}-${session.id.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`);
			await copyFile(session.path, path);
			files.push({ session, path });
		}

		// Analyze: groups of about 20, each group in parallel, finishing a group before the next.
		const confirmed = new Set<string>();
		/** Sessions an analyzer finished: only these can confirm or fail to confirm a passive note. */
		const read = new Set<string>();
		let firstFailed: number | undefined;
		const groupSize = input.groupSize ?? DREAM_GROUP_SIZE;
		for (let start = 0; start < files.length; start += groupSize) {
			if (signal.aborted) return { ...result, status: "aborted" };
			const group = files.slice(start, start + groupSize);
			const runs = await Promise.all(
				group.map(async (file) => {
					const task: AgentTask = { role: "analyze", workDir, transcript: file.path, session: file.session.id, passiveCandidates: passiveBefore };
					const started = Date.now();
					const run = await safeRun(agents, task, signal);
					await recordRun(input, ref, "deepseek-analyze", { transcript: file.path, transcriptSession: file.session.id }, started, run);
					return { file, run };
				}),
			);
			if (signal.aborted) return { ...result, status: "aborted" };
			for (const { file, run } of runs) {
				result.sessions += 1;
				if (!run.ok) {
					result.failedSessions += 1;
					firstFailed = Math.min(firstFailed ?? Number.POSITIVE_INFINITY, file.session.mtimeMs);
				} else read.add(file.session.id);
				for (const name of run.confirmed) confirmed.add(name);
			}
		}
		if (result.failedSessions === result.sessions) return { ...result, status: "error", reason: "every transcript analysis failed" };

		// Organize the whole store once.
		if ((await listNotes(input.notes)).length > 1) {
			const started = Date.now();
			const run = await safeRun(agents, { role: "organize", workDir, passiveCandidates: new Set() }, signal);
			await recordRun(input, ref, "deepseek-organize", {}, started, run);
			if (signal.aborted) return { ...result, status: "aborted" };
			result.organizeFailed = !run.ok;
		}

		// Passive notes: confirmed ones become ordinary notes; ones no dream can confirm go away. A dream that
		// did not read the session a note came from has no evidence either way and leaves its count alone.
		for (const note of await listNotes(input.notes)) {
			if (!passiveBefore.has(note.name) || !isPassiveUnverified(note)) continue;
			if (confirmed.has(note.name)) {
				const { unverifiedDreams: _drop, ...meta } = note.meta;
				await writeNote(input.notes, note.path, { ...meta, verified: now.toISOString().slice(0, 10) }, note.body);
				result.confirmed += 1;
				continue;
			}
			const sources = Array.isArray(note.meta.sessions) ? (note.meta.sessions as unknown[]).map(String) : [];
			if (sources.length > 0 && !sources.some((id) => read.has(id))) continue;
			const misses = (typeof note.meta.unverifiedDreams === "number" ? note.meta.unverifiedDreams : 0) + 1;
			if (misses >= PASSIVE_UNVERIFIED_LIMIT) {
				await deleteNote(input.notes, note.path);
				await appendLog(input.dir, `dream removed passive note ${note.name}: not confirmed by ${misses} dreams`, now);
				result.removedPassive += 1;
			} else {
				await writeNote(input.notes, note.path, { ...note.meta, unverifiedDreams: misses }, note.body);
			}
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
			`dream read ${result.sessions} sessions (${result.failedSessions} failed${result.organizeFailed ? ", organize failed" : ""}): created ${result.created}, updated ${result.updated}, deleted ${result.deleted}, confirmed ${result.confirmed}, removed passive ${result.removedPassive}`,
			now,
		);
		// A failed transcript is read again by the next dream.
		result.readUntil = firstFailed !== undefined ? firstFailed - 1 : sessions[sessions.length - 1].mtimeMs;
		return result;
	} finally {
		await rm(join(input.dir, WORK_DIR), { recursive: true, force: true });
	}
}
