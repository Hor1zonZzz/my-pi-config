/**
 * Passive capture of one settled turn: Jev judges whether it is worth keeping, then DeepSeek Flash
 * writes or updates one note. Experimental; the user can switch it off. Free of Pi imports.
 */
import { isAvailable, type ModelPort, recordedCall } from "./port.ts";
import { JEV_QUESTIONS, SAVE_MEMORY_TOOL, WRITER_PROMPT } from "./prompts.ts";
import {
	appendLog,
	formatIndex,
	isValidNoteName,
	listNotes,
	NOTE_TYPES,
	type NoteInfo,
	type NoteMeta,
	type NoteSource,
	rebuildIndex,
	writeNote,
} from "./store.ts";
import { type CaptureWindow, windowText as renderWindow } from "./transcript.ts";

export const DURABLE_THRESHOLD = 0.75;
export const RELATED_NOTES = 5;

export interface CaptureInput {
	/** The memory directory (config, calls.jsonl, log.md). */
	dir: string;
	/** The notes directory (/memories). */
	notes: string;
	session: string;
	/** Short window for Jev: the focus turn and the turn before it. */
	judgeWindow: CaptureWindow;
	/** Longer window for DeepSeek: up to three turns. */
	writerWindow: CaptureWindow;
	port: ModelPort;
	signal: AbortSignal;
	threshold?: number;
	now?: Date;
}

export type CaptureOutcome =
	| { status: "unavailable"; reason: string }
	| { status: "judge-error"; error: string }
	| { status: "below-threshold"; durable: number }
	| { status: "writer-error"; error: string }
	| { status: "skip"; durable: number }
	| { status: "written"; action: "create" | "update"; name: string; durable: number };

export interface NoteUpsert {
	name: string;
	description: string;
	type: string;
	body: string;
}

export function readUpsert(value: unknown): NoteUpsert | undefined {
	if (!value || typeof value !== "object") return undefined;
	const op = value as Record<string, unknown>;
	const name = typeof op.name === "string" ? op.name.trim() : "";
	const body = typeof op.body === "string" ? op.body.trim() : "";
	if (!isValidNoteName(name) || !body) return undefined;
	const type = typeof op.type === "string" && (NOTE_TYPES as readonly string[]).includes(op.type) ? op.type : "project";
	const description = typeof op.description === "string" && op.description.trim() ? op.description.trim() : body.split("\n")[0];
	return { name, description, type, body };
}

/**
 * Writes `upsert` as <name>.md, or over the existing note with that name. An existing note keeps its
 * source and verification state; the session is added to its sources.
 */
export async function upsertNote(
	notes: string,
	upsert: NoteUpsert,
	options: { source: NoteSource; session?: string; now: Date; existing?: NoteInfo },
): Promise<"create" | "update"> {
	const existing = options.existing ?? (await listNotes(notes)).find((note) => note.name === upsert.name);
	const sessions = new Set<string>(Array.isArray(existing?.meta.sessions) ? (existing?.meta.sessions as string[]) : []);
	if (options.session) sessions.add(options.session);
	const meta: NoteMeta = {
		...(existing?.meta ?? {}),
		name: upsert.name,
		description: upsert.description,
		type: upsert.type,
		source: typeof existing?.meta.source === "string" ? existing.meta.source : options.source,
		sessions: sessions.size ? [...sessions] : undefined,
		updated: options.now.toISOString().slice(0, 10),
	};
	if (!existing && options.source === "passive") meta.unverifiedDreams = 0;
	await writeNote(notes, existing?.path ?? `${upsert.name}.md`, meta, upsert.body);
	return existing ? "update" : "create";
}

const WORD = /[a-z0-9][a-z0-9_-]{2,}/g;
const CJK = /[㐀-鿿]/g;

function terms(text: string): Set<string> {
	const lower = text.toLowerCase();
	const out = new Set<string>(lower.match(WORD) ?? []);
	const cjk = lower.match(CJK) ?? [];
	for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk[i] + cjk[i + 1]);
	return out;
}

/** Notes whose name or description shares the most terms with the window. */
export function pickRelated(notes: readonly NoteInfo[], text: string, limit = RELATED_NOTES): NoteInfo[] {
	const window = terms(text);
	return notes
		.map((note) => {
			let score = 0;
			for (const term of terms(`${note.name.replace(/-/g, " ")} ${note.name} ${note.description}`)) if (window.has(term)) score++;
			return { note, score };
		})
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || a.note.name.localeCompare(b.note.name))
		.slice(0, limit)
		.map((item) => item.note);
}

export async function capture(input: CaptureInput): Promise<CaptureOutcome> {
	const { port } = input;
	if (!isAvailable(port.judge)) return { status: "unavailable", reason: port.judge.unavailable };
	if (!isAvailable(port.writer)) return { status: "unavailable", reason: port.writer.unavailable };
	const threshold = input.threshold ?? DURABLE_THRESHOLD;
	const now = input.now ?? new Date();
	const all = await listNotes(input.notes);
	const index = formatIndex(all);

	const state = {
		earlier_turns: input.judgeWindow.earlier.join("\n\n") || "(none)",
		focus_turn: input.judgeWindow.focus,
		existing_memory: index,
	};
	const judged = await recordedCall(
		{ dir: input.dir, session: input.session, role: "jev-judge", ref: port.judge, reasoning: null, input: { state, questions: JEV_QUESTIONS } },
		() => port.classify(state, JEV_QUESTIONS as unknown as Record<string, unknown>, input.signal),
		(reply) => {
			const durable = durableOf(reply.answers);
			return { output: reply.answers ?? null, outcome: durable !== undefined && durable >= threshold ? "passed" : "below-threshold" };
		},
	);
	if (judged.error || judged.stopReason !== "stop") return { status: "judge-error", error: judged.error ?? judged.stopReason };
	const durable = durableOf(judged.answers);
	if (durable === undefined) return { status: "judge-error", error: "no durable answer" };
	if (durable < threshold) return { status: "below-threshold", durable };
	const kind = kindOf(judged.answers);

	const windowText = renderWindow(input.writerWindow);
	const related = pickRelated(all, windowText);
	const user = JSON.stringify(
		{
			window: windowText,
			kind,
			related_notes: related.map((note) => ({ name: note.name, path: note.path, frontmatter: note.meta, body: note.body })),
			index,
		},
		null,
		2,
	);
	const written = await recordedCall(
		{ dir: input.dir, session: input.session, role: "deepseek-capture", ref: port.writer, reasoning: "low", input: { system: WRITER_PROMPT, user } },
		() => port.write(WRITER_PROMPT, user, "low", input.signal),
		(reply) => {
			const args = reply.toolArgs;
			const action = actionOf(args);
			const valid = action === "skip" || (action !== undefined && readUpsert(args) !== undefined);
			return { output: { text: reply.text, toolArgs: args ?? null }, outcome: !args ? "no-call" : valid && action ? action : "invalid-call" };
		},
	);
	// A tool call ends the reply with "toolUse"; a reply without one ends with "stop".
	if (written.error || (written.stopReason !== "toolUse" && written.stopReason !== "stop")) {
		return { status: "writer-error", error: written.error ?? written.stopReason };
	}
	const parsed = written.toolArgs;
	if (!parsed) return { status: "writer-error", error: `no ${SAVE_MEMORY_TOOL.name} call` };
	if (parsed.action === "skip") return { status: "skip", durable };
	const upsert = readUpsert(parsed);
	if (!upsert || (parsed.action !== "create" && parsed.action !== "update")) return { status: "writer-error", error: "invalid note operation" };

	const action = await upsertNote(input.notes, upsert, { source: "passive", session: input.session, now });
	await rebuildIndex(input.notes);
	await appendLog(input.dir, `passive ${action} ${upsert.name} (durable ${durable.toFixed(2)}, session ${input.session})`, now);
	return { status: "written", action, name: upsert.name, durable };
}

function actionOf(args: Record<string, unknown> | undefined): "create" | "update" | "skip" | undefined {
	const action = args?.action;
	return (SAVE_MEMORY_TOOL.actions as readonly unknown[]).includes(action) ? (action as "create" | "update" | "skip") : undefined;
}

function durableOf(answers: Record<string, unknown> | undefined): number | undefined {
	const answer = answers?.durable as { probability?: unknown } | undefined;
	return typeof answer?.probability === "number" ? answer.probability : undefined;
}

function kindOf(answers: Record<string, unknown> | undefined): string | undefined {
	const answer = answers?.kind as { choice?: unknown } | undefined;
	return typeof answer?.choice === "string" ? answer.choice : undefined;
}
