import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, copyFileSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "@earendil-works/pi-coding-agent";
import { resolveInterpreter, sandboxCommand, sandboxEnv, sandboxUnavailable } from "./sandbox.ts";

export const LANGUAGES = ["javascript", "python"] as const;
export type Language = (typeof LANGUAGES)[number];

const PRELUDE_JS = fileURLToPath(new URL("./prelude.mjs", import.meta.url));
const PRELUDE_PY = fileURLToPath(new URL("./prelude.py", import.meta.url));

/** Output kept in memory before it spills to a temp file; the model only ever sees the tail. */
const MEMORY_LIMIT = 4 * DEFAULT_MAX_BYTES;
/** How long to wait for stdout/stderr to drain after the program exits. */
const DRAIN_MS = 500;
/** Output passed to live updates. */
const LIVE_TAIL_CHARS = 4096;

export interface RunOptions {
	language: Language;
	code: string;
	cwd: string;
	toolNames: readonly string[];
	/** Executes one tool call from the program; the returned text is handed back to it. */
	call(tool: string, args: unknown, signal: AbortSignal): Promise<string>;
	timeoutSeconds?: number;
	signal?: AbortSignal;
	/** Called whenever new output arrives, with the most recent output. */
	onOutput?(recent: string): void;
	/**
	 * Run the program in the macOS sandbox (see sandbox.ts): no file access
	 * outside its run directory, no network, no processes. Fails closed where the
	 * sandbox is unavailable.
	 */
	sandbox?: boolean;
	/** Interpreter overrides, for tests. */
	commands?: { node?: string; python?: string };
}

export interface RunResult {
	/** Program output (stdout and stderr interleaved), already truncated to Pi's tool-output limits. */
	output: string;
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
	/** Set when the output was truncated; the complete output is saved there. */
	fullOutputPath?: string;
	/** Model-facing note describing the truncation. */
	truncationNote?: string;
}

/** Collects combined output, spilling to a temp file once it grows past the in-memory limit. */
class OutputBuffer {
	private text = "";
	private fd: number | undefined;
	private path: string | undefined;
	private spilled = false;

	append(chunk: string): void {
		if (!chunk) return;
		if (this.fd !== undefined) writeSync(this.fd, chunk);
		this.text += chunk;
		if (this.text.length > MEMORY_LIMIT) {
			if (this.fd === undefined) {
				this.open();
				writeSync(this.fd!, this.text);
			}
			this.spilled = true;
			this.text = this.text.slice(-MEMORY_LIMIT / 2);
		}
	}

	tail(maxChars: number): string {
		return this.text.slice(-maxChars);
	}

	finish(): Pick<RunResult, "output" | "fullOutputPath" | "truncationNote"> {
		const truncation = truncateTail(this.text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
		if (!truncation.truncated && !this.spilled) return { output: this.text };
		if (this.fd === undefined) {
			this.open();
			writeSync(this.fd!, this.text);
		}
		closeSync(this.fd!);
		this.fd = undefined;
		const shown = `${truncation.outputLines} lines (${formatSize(truncation.outputBytes)})`;
		return {
			output: truncation.content,
			fullOutputPath: this.path,
			truncationNote: `[Output truncated: showing the last ${shown}. Full output: ${this.path}]`,
		};
	}

	close(): void {
		if (this.fd !== undefined) closeSync(this.fd);
		this.fd = undefined;
	}

	private open(): void {
		this.path = join(tmpdir(), `pi-code-mode-${randomBytes(6).toString("hex")}.log`);
		this.fd = openSync(this.path, "w");
	}
}

function nodeCommand(): string {
	// Pi normally runs on Node; fall back to PATH when the host runtime is something else.
	return process.versions.bun === undefined && !("Deno" in globalThis) ? process.execPath : "node";
}

function killGroup(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

/**
 * Runs a program in a child interpreter. The program reaches Pi's tools through
 * the prelude's `tools` object; every call is dispatched through `options.call`.
 */
export async function runProgram(options: RunOptions): Promise<RunResult> {
	if (options.sandbox) {
		const reason = sandboxUnavailable();
		if (reason) throw new Error(`Cannot run the program: ${reason}. Turn Sandbox off in /tools to run programs unsandboxed.`);
	}
	// The sandbox matches real paths, and /var/folders is a symlink on macOS.
	const workDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-code-mode-")));
	const output = new OutputBuffer();
	const calls = new AbortController();
	try {
		const isPython = options.language === "python";
		const mainPath = join(workDir, isPython ? "main.py" : "main.mjs");
		writeFileSync(mainPath, options.code);
		const interpreter = isPython ? (options.commands?.python ?? "python3") : (options.commands?.node ?? nodeCommand());
		const bridgeEnv = {
			PI_CODE_MODE_TOOLS: JSON.stringify(options.toolNames),
			PYTHONUNBUFFERED: "1",
			PYTHONDONTWRITEBYTECODE: "1",
		};

		let command: string;
		let args: string[];
		let env: Record<string, string | undefined>;
		if (options.sandbox) {
			// The extension directory is not readable inside the sandbox; run copies of the preludes.
			const prelude = join(workDir, isPython ? "prelude.py" : "prelude.mjs");
			copyFileSync(isPython ? PRELUDE_PY : PRELUDE_JS, prelude);
			const resolved = await resolveInterpreter(options.language, interpreter);
			({ command, args } = sandboxCommand(resolved, workDir, isPython ? ["-I", "-u", prelude, mainPath] : [prelude, mainPath]));
			env = sandboxEnv(workDir, bridgeEnv);
		} else {
			command = interpreter;
			args = isPython ? ["-u", PRELUDE_PY, mainPath] : [PRELUDE_JS, mainPath];
			env = { ...process.env, ...bridgeEnv };
		}

		let timedOut = false;
		let aborted = false;
		const child = spawn(command, args, {
			cwd: options.cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
			env,
		});

		const stdout = child.stdio[1] as Readable;
		const stderr = child.stdio[2] as Readable;
		const requests = child.stdio[3] as Readable;
		const responses = child.stdio[4] as Writable;
		responses.on("error", () => {});
		requests.on("error", () => {});

		for (const stream of [stdout, stderr]) {
			const decoder = new StringDecoder("utf8");
			stream.on("data", (chunk: Buffer) => {
				output.append(decoder.write(chunk));
				options.onOutput?.(output.tail(LIVE_TAIL_CHARS));
			});
			stream.on("end", () => output.append(decoder.end()));
		}

		const respond = (message: unknown) => {
			if (!responses.destroyed && responses.writable) responses.write(`${JSON.stringify(message)}\n`);
		};
		createInterface({ input: requests, crlfDelay: Infinity }).on("line", (line) => {
			let request: { id?: unknown; tool?: unknown; args?: unknown };
			try {
				request = JSON.parse(line);
			} catch {
				return;
			}
			const { id, tool, args } = request ?? {};
			if (typeof tool !== "string") {
				respond({ id, ok: false, error: "Invalid tool request" });
				return;
			}
			options.call(tool, args, calls.signal).then(
				(text) => respond({ id, ok: true, text }),
				(error: unknown) => respond({ id, ok: false, error: error instanceof Error ? error.message : String(error) }),
			);
		});

		const stop = () => {
			calls.abort();
			killGroup(child.pid);
		};
		const onAbort = () => {
			aborted = true;
			stop();
		};
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
		const timer =
			options.timeoutSeconds !== undefined && options.timeoutSeconds > 0
				? setTimeout(() => {
						timedOut = true;
						stop();
					}, options.timeoutSeconds * 1000)
				: undefined;

		const exitCode = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => {
				// Let buffered output arrive, but do not wait on descendants that kept the pipes open.
				let pending = 2;
				const done = () => {
					if (--pending === 0) finish();
				};
				const drain = setTimeout(finish, DRAIN_MS);
				function finish() {
					clearTimeout(drain);
					resolve(code);
				}
				for (const stream of [stdout, stderr]) {
					if (stream.readableEnded) done();
					else stream.once("end", done);
				}
			});
		}).finally(() => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			// Tool calls the program never awaited must not outlive it.
			calls.abort();
			killGroup(child.pid);
			for (const stream of [stdout, stderr, requests, responses]) stream.destroy();
		});

		return { ...output.finish(), exitCode, timedOut, aborted };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			const name = options.language === "python" ? "python3" : "node";
			throw new Error(`Cannot run ${options.language}: \`${name}\` was not found on PATH`);
		}
		throw error;
	} finally {
		output.close();
		rmSync(workDir, { recursive: true, force: true });
	}
}
