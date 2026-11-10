/**
 * Per-project memory storage. Free of Pi imports so `node --test` can run it.
 *
 * <agent-dir>/memory/<project-key>/
 *   config.json   MemoryConfig
 *   calls.jsonl   model call history (see call-log.ts)
 *   log.md        append-only log of passive writes and dreams
 *   .snapshots/   copies of notes/ taken before each dream
 *   notes/        the directory the model sees as /memories
 *     MEMORY.md   generated index, one line per note
 *     <name>.md   one note per file: frontmatter + body
 */
import { appendFile, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

export const NOTES_DIR = "notes";
export const INDEX_FILE = "MEMORY.md";
export const SNAPSHOT_DIR = ".snapshots";
export const SNAPSHOTS_KEPT = 5;
export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25_000;
export const NOTE_TYPES = ["user", "feedback", "project", "reference"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];
export type NoteSource = "active" | "passive" | "dream";

export interface MemoryConfig {
	enabled: boolean;
	/** Background capture of each settled turn (Jev judge + DeepSeek writer). Experimental. */
	passive: boolean;
	/** Run a dream on session start at most once a day. */
	dreamAuto: boolean;
	/** Epoch ms of the newest session file the last completed dream read. */
	lastDreamAt?: number;
}

export const DEFAULT_CONFIG: MemoryConfig = { enabled: true, passive: true, dreamAuto: true };

export interface NoteMeta {
	name?: string;
	description?: string;
	type?: string;
	source?: string;
	sessions?: string[];
	updated?: string;
	/** ISO date of the dream that confirmed a passive note against a transcript. */
	verified?: string;
	/** Dreams in a row that could not confirm a passive note. */
	unverifiedDreams?: number;
	[key: string]: unknown;
}

export interface NoteInfo {
	/** Path relative to the notes directory, with forward slashes. */
	path: string;
	name: string;
	description: string;
	meta: NoteMeta;
	body: string;
	size: number;
}

/** Same naming as Pi's session directories: `/a/b` → `--a-b--`. */
export function projectKey(cwd: string): string {
	return `--${cwd.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`;
}

export function memoryDir(agentDir: string, cwd: string): string {
	return join(agentDir, "memory", projectKey(cwd));
}

export function notesDir(dir: string): string {
	return join(dir, NOTES_DIR);
}

export async function readConfig(dir: string): Promise<MemoryConfig> {
	try {
		const raw = JSON.parse(await readFile(join(dir, "config.json"), "utf8")) as Partial<MemoryConfig>;
		return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
			passive: typeof raw.passive === "boolean" ? raw.passive : DEFAULT_CONFIG.passive,
			dreamAuto: typeof raw.dreamAuto === "boolean" ? raw.dreamAuto : DEFAULT_CONFIG.dreamAuto,
			lastDreamAt: typeof raw.lastDreamAt === "number" ? raw.lastDreamAt : undefined,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export async function writeConfig(dir: string, config: MemoryConfig): Promise<void> {
	await writeFileAtomic(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

export async function writeFileAtomic(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, text, "utf8");
	await rename(tmp, path);
}

// ── Notes ────────────────────────────────────────────────────────────────────

export function isValidNoteName(name: string): boolean {
	return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}

/** Splits `---\nkey: value\n---\nbody`. Values that look like JSON (arrays, numbers, booleans) are parsed. */
export function parseNote(text: string): { meta: NoteMeta; body: string } {
	const normalized = text.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) return { meta: {}, body: normalized };
	const end = normalized.indexOf("\n---", 4);
	if (end < 0) return { meta: {}, body: normalized };
	const meta: NoteMeta = {};
	for (const line of normalized.slice(4, end).split("\n")) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim();
		const raw = line.slice(colon + 1).trim();
		meta[key] = parseValue(raw);
	}
	const afterFence = normalized.indexOf("\n", end + 4);
	const body = afterFence < 0 ? "" : normalized.slice(afterFence + 1);
	return { meta, body: body.replace(/^\n+/, "") };
}

function parseValue(raw: string): unknown {
	if (/^(\[.*\]|-?\d+(\.\d+)?|true|false)$/.test(raw)) {
		try {
			return JSON.parse(raw);
		} catch {
			return raw;
		}
	}
	return raw.replace(/^"(.*)"$/, "$1");
}

const META_ORDER = ["name", "description", "type", "source", "sessions", "updated", "verified", "unverifiedDreams"];

export function serializeNote(meta: NoteMeta, body: string): string {
	const keys = [
		...META_ORDER.filter((key) => meta[key] !== undefined),
		...Object.keys(meta)
			.filter((key) => !META_ORDER.includes(key) && meta[key] !== undefined)
			.sort(),
	];
	const lines = keys.map((key) => {
		const value = meta[key];
		const text = typeof value === "string" ? value.replace(/\n+/g, " ") : JSON.stringify(value);
		return `${key}: ${text}`;
	});
	return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

async function walk(root: string, dir: string, depth: number, out: string[]): Promise<void> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (depth < 2) await walk(root, full, depth + 1, out);
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			const rel = relative(root, full).split(sep).join("/");
			if (rel !== INDEX_FILE) out.push(rel);
		}
	}
}

/** Notes sorted by path so the generated index is byte-stable. */
export async function listNotes(notes: string): Promise<NoteInfo[]> {
	const paths: string[] = [];
	await walk(notes, notes, 1, paths);
	paths.sort();
	const out: NoteInfo[] = [];
	for (const path of paths) {
		try {
			const text = await readFile(join(notes, path), "utf8");
			const { meta, body } = parseNote(text);
			const fallbackName = path.replace(/\.md$/, "");
			const firstLine = body.split("\n").find((line) => line.trim() !== "") ?? "";
			out.push({
				path,
				name: typeof meta.name === "string" && meta.name ? meta.name : fallbackName,
				description: oneLine(typeof meta.description === "string" ? meta.description : firstLine.replace(/^#+\s*/, ""), 150),
				meta,
				body,
				size: Buffer.byteLength(text),
			});
		} catch {
			// A note removed while listing is simply skipped.
		}
	}
	return out;
}

export function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** No timestamps or counts: the same notes always give the same bytes, so prompt caches hit. */
export function formatIndex(notes: NoteInfo[]): string {
	if (notes.length === 0) return "(no notes yet)\n";
	return `${notes.map((note) => `- [${note.name}](${note.path}) — ${note.description}`).join("\n")}\n`;
}

export async function rebuildIndex(notes: string): Promise<string> {
	await mkdir(notes, { recursive: true });
	const index = formatIndex(await listNotes(notes));
	const path = join(notes, INDEX_FILE);
	let current: string | undefined;
	try {
		current = await readFile(path, "utf8");
	} catch {}
	if (current !== index) await writeFileAtomic(path, index);
	return index;
}

/** Keeps the injected index within 200 lines and 25 KB, like Claude Code's auto memory. */
export function indexForPrompt(index: string): string {
	const lines = index.split("\n");
	let out = lines.slice(0, INDEX_MAX_LINES).join("\n");
	let truncated = lines.length > INDEX_MAX_LINES + 1;
	while (Buffer.byteLength(out) > INDEX_MAX_BYTES) {
		out = out.slice(0, out.lastIndexOf("\n"));
		truncated = true;
	}
	return truncated ? `${out}\n… (index truncated; view /memories for the rest)` : out.trimEnd();
}

export async function readNote(notes: string, name: string): Promise<NoteInfo | undefined> {
	return (await listNotes(notes)).find((note) => note.name === name || note.path === `${name}.md`);
}

export async function writeNote(notes: string, path: string, meta: NoteMeta, body: string): Promise<void> {
	await writeFileAtomic(join(notes, path), serializeNote(meta, body));
}

export async function deleteNote(notes: string, path: string): Promise<void> {
	await rm(join(notes, path), { force: true });
}

// ── Log and snapshots ────────────────────────────────────────────────────────

export async function appendLog(dir: string, line: string, now = new Date()): Promise<void> {
	await mkdir(dir, { recursive: true });
	await appendFile(join(dir, "log.md"), `- ${now.toISOString()} ${line.replace(/\n+/g, " ")}\n`);
}

export async function readLog(dir: string, maxLines = 200): Promise<string[]> {
	try {
		const lines = (await readFile(join(dir, "log.md"), "utf8")).split("\n").filter(Boolean);
		return lines.slice(-maxLines);
	} catch {
		return [];
	}
}

export function snapshotName(now: Date): string {
	return now.toISOString().replace(/[:.]/g, "-");
}

/** Copies notes/ to .snapshots/<time>/ and keeps the newest SNAPSHOTS_KEPT copies. */
export async function snapshot(dir: string, now = new Date()): Promise<string> {
	const root = join(dir, SNAPSHOT_DIR);
	const target = join(root, snapshotName(now));
	await mkdir(root, { recursive: true });
	await cp(notesDir(dir), target, { recursive: true, force: true }).catch(async (error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		await mkdir(target, { recursive: true });
	});
	const all = (await readdir(root)).sort();
	for (const old of all.slice(0, Math.max(0, all.length - SNAPSHOTS_KEPT))) {
		await rm(join(root, old), { recursive: true, force: true });
	}
	return target;
}

// ── Dream lock ───────────────────────────────────────────────────────────────

const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** One dream per project across Pi processes. Returns a release function, or undefined when held. */
export async function acquireDreamLock(dir: string, now = Date.now()): Promise<(() => Promise<void>) | undefined> {
	await mkdir(dir, { recursive: true });
	const path = join(dir, ".dream.lock");
	const tryCreate = async () => {
		try {
			await writeFile(path, JSON.stringify({ pid: process.pid, at: now }), { flag: "wx" });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
	};
	if (!(await tryCreate())) {
		try {
			const held = JSON.parse(await readFile(path, "utf8")) as { pid?: number; at?: number };
			const stale = !held.pid || !pidAlive(held.pid) || now - (held.at ?? 0) > LOCK_STALE_MS;
			if (!stale) return undefined;
			await rm(path, { force: true });
		} catch {
			await rm(path, { force: true });
		}
		if (!(await tryCreate())) return undefined;
	}
	return async () => {
		await rm(path, { force: true });
	};
}

export async function fileMtime(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return undefined;
	}
}
