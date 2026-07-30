// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

interface CodeModeState {
	version: 1;
	enabled: boolean;
}

export const CODE_MODE_STATE_PATH = join(getAgentDir(), "code-mode.json");

export async function readCodeModeState(): Promise<boolean> {
	try {
		const parsed = JSON.parse(
			await readFile(CODE_MODE_STATE_PATH, "utf8"),
		) as Partial<CodeModeState>;
		return parsed.version === 1 && parsed.enabled === true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(
				`[code-mode] Failed to read ${CODE_MODE_STATE_PATH}:`,
				error,
			);
		}
		return false;
	}
}

export async function writeCodeModeState(enabled: boolean): Promise<void> {
	await mkdir(dirname(CODE_MODE_STATE_PATH), { recursive: true });
	const temporaryPath = `${CODE_MODE_STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(
			temporaryPath,
			`${JSON.stringify({ version: 1, enabled }, null, 2)}\n`,
			"utf8",
		);
		await rename(temporaryPath, CODE_MODE_STATE_PATH);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}
