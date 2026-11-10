/**
 * The `memory` tool's commands, following Anthropic's memory tool (memory_20250818):
 * view, create, str_replace, insert, delete, rename under a virtual /memories root.
 * Free of Pi imports so `node --test` can run it.
 */
import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { INDEX_FILE, rebuildIndex } from "./store.ts";

export const MEMORY_ROOT = "/memories";
export const MEMORY_COMMANDS = ["view", "create", "str_replace", "insert", "delete", "rename"] as const;
export type MemoryCommand = (typeof MEMORY_COMMANDS)[number];
const VIEW_MAX_CHARS = 16_000;
const FILE_MAX_BYTES = 100_000;

export interface MemoryParams {
	command: MemoryCommand;
	path?: string;
	view_range?: number[];
	file_text?: string;
	old_str?: string;
	new_str?: string;
	insert_line?: number;
	insert_text?: string;
	old_path?: string;
	new_path?: string;
}

export interface MemoryResult {
	text: string;
	isError: boolean;
	/** True when the command changed the notes directory. */
	wrote: boolean;
}

export class MemoryPathError extends Error {}

/** Maps /memories/... onto the notes directory and rejects anything that escapes it. */
export function resolveMemoryPath(root: string, path: string | undefined): string {
	if (typeof path !== "string" || path.length === 0) throw new MemoryPathError("Error: path is required");
	let decoded = path;
	try {
		decoded = decodeURIComponent(path);
	} catch {}
	if (decoded !== MEMORY_ROOT && !decoded.startsWith(`${MEMORY_ROOT}/`)) {
		throw new MemoryPathError(`Error: The path ${path} must start with ${MEMORY_ROOT}`);
	}
	if (decoded.includes("\\") || decoded.split("/").includes("..")) {
		throw new MemoryPathError(`Error: The path ${path} is not allowed`);
	}
	const base = resolve(root);
	const real = resolve(base, `.${decoded.slice(MEMORY_ROOT.length)}`);
	if (real !== base && !real.startsWith(base + sep)) throw new MemoryPathError(`Error: The path ${path} is not allowed`);
	return real;
}

/** Resolves symlinks in the longest existing prefix of `path`, so a missing file under a symlinked directory still resolves. */
export function realPath(path: string): string {
	let current = resolve(path);
	const rest: string[] = [];
	for (;;) {
		try {
			return join(realpathSync(current), ...rest.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(path);
			rest.push(current.slice(parent.length).replace(/^[/\\]+/, ""));
			current = parent;
		}
	}
}

/** Whether `path` (relative to `cwd`; empty = `cwd`) resolves inside one of `roots`, following existing symlinks. */
export function insideRoots(path: string | undefined, cwd: string, roots: readonly string[]): boolean {
	const target = realPath(path === undefined || path === "" ? cwd : isAbsolute(path) ? path : resolve(cwd, path));
	return roots.some((root) => target === root || target.startsWith(root + sep));
}

function virtualPath(root: string, real: string): string {
	const rel = relative(resolve(root), real).split(sep).join("/");
	return rel ? `${MEMORY_ROOT}/${rel}` : MEMORY_ROOT;
}

function humanSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
	return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

async function kind(path: string): Promise<"file" | "dir" | undefined> {
	try {
		const info = await stat(path);
		return info.isDirectory() ? "dir" : info.isFile() ? "file" : undefined;
	} catch {
		return undefined;
	}
}

function numbered(text: string, start = 1): string {
	return text
		.split("\n")
		.map((line, i) => `${String(i + start).padStart(6, " ")}\t${line}`)
		.join("\n");
}

function isIndex(root: string, real: string): boolean {
	return real === join(resolve(root), INDEX_FILE);
}

const ok = (text: string, wrote = false): MemoryResult => ({ text, isError: false, wrote });
const fail = (text: string): MemoryResult => ({ text, isError: true, wrote: false });

export interface MemoryOptions {
	/** `create` on an existing file overwrites it (default) or fails, as in Anthropic's reference handler. */
	overwrite?: boolean;
}

/** Commands on one notes directory run one at a time, so parallel agents in this process never interleave a read-modify-write. */
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(root: string, task: () => Promise<T>): Promise<T> {
	const key = resolve(root);
	const previous = queues.get(key) ?? Promise.resolve();
	const next = previous.then(task, task);
	const settled = next.catch(() => {});
	queues.set(key, settled);
	void settled.then(() => {
		if (queues.get(key) === settled) queues.delete(key);
	});
	return next;
}

export async function executeMemoryCommand(root: string, params: MemoryParams, options: MemoryOptions = {}): Promise<MemoryResult> {
	return serialized(root, async () => {
		await mkdir(root, { recursive: true });
		try {
			const result = await run(root, params, options);
			if (result.wrote) await rebuildIndex(root);
			return result;
		} catch (error) {
			if (error instanceof MemoryPathError) return fail(error.message);
			return fail(`Error: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}

async function run(root: string, params: MemoryParams, options: MemoryOptions): Promise<MemoryResult> {
	switch (params.command) {
		case "view":
			return view(root, params);
		case "create": {
			const real = resolveMemoryPath(root, params.path);
			if (real === resolve(root)) return fail("Error: Cannot create the /memories directory itself");
			if (isIndex(root, real)) return fail(`Error: ${MEMORY_ROOT}/${INDEX_FILE} is generated from the notes; edit the notes instead`);
			const text = params.file_text ?? "";
			if (Buffer.byteLength(text) > FILE_MAX_BYTES) return fail(`Error: A memory file is limited to ${FILE_MAX_BYTES} bytes`);
			const existing = await kind(real);
			if (existing === "dir") return fail(`Error: ${params.path} is a directory`);
			if (existing === "file" && options.overwrite === false) {
				return fail(`Error: File ${params.path} already exists. View it and change it with str_replace or insert instead.`);
			}
			await mkdir(dirname(real), { recursive: true });
			await writeFile(real, text, "utf8");
			return ok(`File created successfully at: ${params.path}`, true);
		}
		case "str_replace": {
			const real = resolveMemoryPath(root, params.path);
			if (isIndex(root, real)) return fail(`Error: ${MEMORY_ROOT}/${INDEX_FILE} is generated from the notes; edit the notes instead`);
			if ((await kind(real)) !== "file") return fail(`Error: The path ${params.path} does not exist. Please provide a valid path.`);
			const oldStr = params.old_str ?? "";
			if (!oldStr) return fail("Error: old_str is required");
			const content = await readFile(real, "utf8");
			const lines: number[] = [];
			let at = content.indexOf(oldStr);
			while (at >= 0) {
				lines.push(content.slice(0, at).split("\n").length);
				at = content.indexOf(oldStr, at + 1);
			}
			if (lines.length === 0) return fail(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${params.path}.`);
			if (lines.length > 1) {
				return fail(`No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${lines.join(", ")}. Please ensure it is unique`);
			}
			const updated = content.replace(oldStr, () => params.new_str ?? "");
			await writeFile(real, updated, "utf8");
			const line = lines[0];
			const snippetLines = updated.split("\n");
			const from = Math.max(1, line - 3);
			const snippet = snippetLines.slice(from - 1, line + 3 + (params.new_str ?? "").split("\n").length).join("\n");
			return ok(`The memory file has been edited.\n${numbered(snippet, from)}`, true);
		}
		case "insert": {
			const real = resolveMemoryPath(root, params.path);
			if (isIndex(root, real)) return fail(`Error: ${MEMORY_ROOT}/${INDEX_FILE} is generated from the notes; edit the notes instead`);
			if ((await kind(real)) !== "file") return fail(`Error: The path ${params.path} does not exist`);
			const lines = (await readFile(real, "utf8")).split("\n");
			const lineNo = params.insert_line ?? -1;
			if (!Number.isInteger(lineNo) || lineNo < 0 || lineNo > lines.length) {
				return fail(`Error: Invalid \`insert_line\` parameter: ${lineNo}. It should be within the range of lines of the file: [0, ${lines.length}]`);
			}
			lines.splice(lineNo, 0, (params.insert_text ?? "").replace(/\n$/, ""));
			await writeFile(real, lines.join("\n"), "utf8");
			return ok(`The file ${params.path} has been edited.`, true);
		}
		case "delete": {
			const real = resolveMemoryPath(root, params.path);
			if (real === resolve(root)) return fail("Error: Cannot delete the /memories directory itself");
			if (isIndex(root, real)) return fail(`Error: ${MEMORY_ROOT}/${INDEX_FILE} is generated from the notes; delete notes instead`);
			if (!(await kind(real))) return fail(`Error: The path ${params.path} does not exist`);
			await rm(real, { recursive: true, force: true });
			return ok(`Successfully deleted ${params.path}`, true);
		}
		case "rename": {
			const from = resolveMemoryPath(root, params.old_path);
			const to = resolveMemoryPath(root, params.new_path);
			if (from === resolve(root)) return fail("Error: Cannot rename the /memories directory itself");
			if (isIndex(root, from) || isIndex(root, to)) return fail(`Error: ${MEMORY_ROOT}/${INDEX_FILE} is generated from the notes`);
			if (!(await kind(from))) return fail(`Error: The path ${params.old_path} does not exist`);
			if (await kind(to)) return fail(`Error: The destination ${params.new_path} already exists`);
			await mkdir(dirname(to), { recursive: true });
			await rename(from, to);
			return ok(`Successfully renamed ${params.old_path} to ${params.new_path}`, true);
		}
		default:
			return fail(`Error: unknown command ${String((params as { command?: unknown }).command)}`);
	}
}

async function view(root: string, params: MemoryParams): Promise<MemoryResult> {
	const real = resolveMemoryPath(root, params.path ?? MEMORY_ROOT);
	const type = await kind(real);
	if (!type) return fail(`The path ${params.path} does not exist. Please provide a valid path.`);
	if (type === "dir") {
		const rows: string[] = [];
		const total = await listDir(root, real, 1, rows);
		const vpath = virtualPath(root, real);
		return ok(
			`Here're the files and directories up to 2 levels deep in ${vpath}, excluding hidden items and node_modules:\n${humanSize(total)}\t${vpath}${rows.length ? `\n${rows.join("\n")}` : ""}`,
		);
	}
	const content = await readFile(real, "utf8");
	const lines = content.replace(/\n$/, "").split("\n");
	if (lines.length > 999_999) return fail(`File ${params.path} exceeds maximum line limit of 999,999 lines.`);
	let start = 1;
	let end = lines.length;
	if (params.view_range && params.view_range.length === 2) {
		start = Math.max(1, Math.floor(params.view_range[0]));
		end = params.view_range[1] === -1 ? lines.length : Math.min(lines.length, Math.floor(params.view_range[1]));
		if (start > end) return fail(`Error: Invalid view_range ${JSON.stringify(params.view_range)} for a file with ${lines.length} lines`);
	}
	let body = numbered(lines.slice(start - 1, end).join("\n"), start);
	if (!params.view_range && body.length > VIEW_MAX_CHARS) {
		body = `${body.slice(0, body.lastIndexOf("\n", VIEW_MAX_CHARS))}\n… (truncated; use view_range to read further)`;
	}
	return ok(`Here's the content of ${params.path} with line numbers:\n${body}`);
}

async function listDir(root: string, dir: string, depth: number, rows: string[]): Promise<number> {
	let total = 0;
	const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			const before = rows.length;
			rows.push("");
			const size = depth < 2 ? await listDir(root, full, depth + 1, rows) : 0;
			rows[before] = `${humanSize(size)}\t${virtualPath(root, full)}`;
			total += size;
		} else if (entry.isFile()) {
			const size = (await stat(full)).size;
			rows.push(`${humanSize(size)}\t${virtualPath(root, full)}`);
			total += size;
		}
	}
	return total;
}
