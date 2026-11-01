import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { ExecFn } from "./process.ts";

// A minimal stand-in for Pi's local bash operations: a detached shell whose process
// group is killed on abort, with signal exits reported as 128 + signal number.
export const exec: ExecFn = (command, cwd, { onData, signal }) =>
	new Promise((resolve, reject) => {
		const child = spawn("bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const kill = () => {
			try {
				process.kill(-(child.pid ?? 0), "SIGKILL");
			} catch {}
		};
		signal?.addEventListener("abort", kill, { once: true });
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", reject);
		child.on("close", (code, signalCode) => {
			if (signal?.aborted) return reject(new Error("aborted"));
			resolve({ exitCode: code ?? 128 + (signalCode ? constants.signals[signalCode] : 0) });
		});
	});
