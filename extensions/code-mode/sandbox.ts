import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * macOS Seatbelt profile for code-mode programs. Everything is allowed by
 * default and then taken away: no network, no new processes or forks, no
 * signals to other processes, no Mach service lookups or Apple Events (which
 * could ask unsandboxed processes to act), no writes outside the run's own
 * directory, and no reading file contents under home directories, volumes, or
 * shared temp directories. Only the interpreter's installation and the run
 * directory are readable there. File metadata (stat) stays readable because
 * path resolution needs it. Children inherit the sandbox.
 *
 * Paths are passed as parameters (`-D NAME=value`) so they need no escaping.
 */
export function seatbeltProfile(rootCount: number): string {
	const roots = Array.from({ length: rootCount }, (_, i) => `(subpath (param "ROOT_${i}"))`).join(" ");
	return `(version 1)
(allow default)
(deny network*)
(deny process-fork)
(deny process-exec*)
(allow process-exec ${roots})
(deny signal)
(allow signal (target self))
(deny mach-lookup)
(deny appleevent-send)
(deny file-write*)
(allow file-write* (subpath (param "WORK_DIR")) (literal "/dev/null"))
(deny file-read-data file-read-xattr (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath (param "HOME")))
(allow file-read-data file-read-xattr ${roots} (subpath (param "WORK_DIR")))
`;
}

/** Why the sandbox cannot run here, or undefined when it can. */
export function sandboxUnavailable(platform: string = process.platform, exists: (path: string) => boolean = existsSync): string | undefined {
	if (platform !== "darwin") return `the code-mode sandbox is only available on macOS (this is ${platform})`;
	if (!exists(SANDBOX_EXEC)) return `${SANDBOX_EXEC} was not found`;
	return undefined;
}

export interface Interpreter {
	/** Executable to start inside the sandbox. */
	executable: string;
	/** Installation directories that must be readable and executable. */
	roots: string[];
}

function isWithin(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Rejects roots that would reopen what the sandbox closes: the file system
 * root, a home directory, or a directory containing one.
 */
export function checkRoots(roots: readonly string[], home: string = realpathSync(homedir())): string[] {
	const unique = [...new Set(roots.map((root) => root.replace(/[/\\]+$/, "") || sep))];
	for (const root of unique) {
		if (root === sep || isWithin(home, root) || isWithin("/Users", root)) {
			throw new Error(`Refusing to sandbox an interpreter installed at ${root}: allowing it would expose the home directory`);
		}
	}
	return unique;
}

function findOnPath(command: string): string {
	if (isAbsolute(command)) return command;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, command);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Keep looking.
		}
	}
	const error = new Error(`${command} not found`) as NodeJS.ErrnoException;
	error.code = "ENOENT";
	throw error;
}

const PYTHON_PROBE =
	"import json, sys; print(json.dumps({'executable': sys.executable, 'prefix': sys.prefix, 'prefixes': sorted({sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix})}))";
const pythonCache = new Map<string, Promise<Interpreter>>();

async function probePython(command: string): Promise<Interpreter> {
	const { stdout } = await run(findOnPath(command), ["-I", "-c", PYTHON_PROBE], { timeout: 15_000 });
	const info = JSON.parse(stdout) as { executable: string; prefix: string; prefixes: string[] };
	const real = realpathSync(info.executable);
	// A virtual environment is recognized from the path it is started with; keep that path.
	const isVenv = existsSync(join(info.prefix, "pyvenv.cfg"));
	return {
		executable: isVenv ? info.executable : real,
		roots: checkRoots([...info.prefixes.map((prefix) => realpathSync(prefix)), dirname(dirname(real))]),
	};
}

/** The interpreter to run inside the sandbox and the directories it needs. */
export async function resolveInterpreter(language: "javascript" | "python", command: string): Promise<Interpreter> {
	if (language === "javascript") {
		const real = realpathSync(findOnPath(command));
		return { executable: real, roots: checkRoots([dirname(dirname(real))]) };
	}
	let probe = pythonCache.get(command);
	if (!probe) {
		probe = probePython(command);
		pythonCache.set(command, probe);
		probe.catch(() => pythonCache.delete(command));
	}
	return probe;
}

/** The sandbox-exec command line that runs `interpreter` with `args`. */
export function sandboxCommand(interpreter: Interpreter, workDir: string, args: readonly string[]): { command: string; args: string[] } {
	const params = [
		`WORK_DIR=${workDir}`,
		`HOME=${realpathSync(homedir())}`,
		...interpreter.roots.map((root, i) => `ROOT_${i}=${root}`),
	].flatMap((param) => ["-D", param]);
	return {
		command: SANDBOX_EXEC,
		args: ["-p", seatbeltProfile(interpreter.roots.length), ...params, interpreter.executable, ...args],
	};
}

/** The only environment a sandboxed program sees; Pi's own variables (and secrets) stay out. */
export function sandboxEnv(workDir: string, extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: workDir, TMPDIR: workDir, ...extra };
	for (const name of ["LANG", "LC_ALL", "LC_CTYPE", "TZ"]) {
		const value = process.env[name];
		if (value) env[name] = value;
	}
	return env;
}
