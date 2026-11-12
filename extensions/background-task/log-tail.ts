import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Bytes read from the end of a log for the output viewer. */
export const TAIL_READ_BYTES = 64 * 1024;

export interface LogTail {
	lines: string[];
	/** True when the file holds more than was read. */
	truncated: boolean;
}

// ANSI escape sequences and control characters other than tab; stderr logs are not cleaned on write.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * The last lines of a file, read synchronously from at most `maxBytes` at its end, with escape
 * sequences and control characters removed and tabs expanded. A partial first line is dropped
 * when the read starts mid-file. A missing or unreadable file has no lines.
 */
export function readLogTail(path: string, maxBytes = TAIL_READ_BYTES): LogTail {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const { size } = fstatSync(fd);
		const length = Math.min(size, maxBytes);
		if (length === 0) return { lines: [], truncated: false };
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		const lines = buffer.toString("utf8").split(/\r?\n/);
		if (lines.at(-1) === "") lines.pop();
		const truncated = size > length;
		if (truncated && lines.length > 1) lines.shift();
		return { lines: lines.map((line) => line.replace(CONTROL, "").replace(/\t/g, "  ")), truncated };
	} catch {
		return { lines: [], truncated: false };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
