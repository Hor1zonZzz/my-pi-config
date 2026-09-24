/** Compact counts in the same style as Pi's footer: 950, 1.2k, 118k, 3.4M. */
export function formatCount(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Tool durations keep one decimal below ten seconds. */
export function formatToolDuration(ms: number): string {
	return ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : formatDuration(ms);
}

export function formatSpeed(tokensPerSecond: number): string {
	return tokensPerSecond >= 10 ? String(Math.round(tokensPerSecond)) : tokensPerSecond.toFixed(1);
}

/**
 * Output tokens per second for one assistant message, measured from its
 * message_start to message_end. Very short or empty messages are ignored.
 */
export function messageSpeed(outputTokens: number, startedAt: number, endedAt: number): number | undefined {
	const seconds = (endedAt - startedAt) / 1000;
	if (!(outputTokens > 0) || !(seconds >= 0.25)) return undefined;
	return outputTokens / seconds;
}

/** Share of one request's prompt served from the prompt cache, in percent (Pi footer's `CH`). */
export function cacheHitRate(usage: { input?: number; cacheRead?: number; cacheWrite?: number }): number | undefined {
	const cacheRead = usage.cacheRead ?? 0;
	const prompt = (usage.input ?? 0) + cacheRead + (usage.cacheWrite ?? 0);
	return prompt > 0 ? (cacheRead / prompt) * 100 : undefined;
}

const LEVELS = "▁▂▃▄▅▆▇█";

/** Block levels relative to the largest value in the window. */
export function sparkLevels(values: readonly number[]): string[] {
	const max = Math.max(0, ...values);
	return values.map((value) => LEVELS[max > 0 ? Math.min(7, Math.max(0, Math.round((value / max) * 7))) : 0]!);
}

/** Counts `+`/`-` lines in Pi's display diff (`+12 text`, `-12 text`). */
export function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

/** GitHub-style squares: [added, removed, unchanged], always `cells` long. */
export function diffBlocks(added: number, removed: number, cells = 5): [number, number, number] {
	const total = added + removed;
	if (total <= 0) return [0, 0, cells];
	if (total <= cells) return [added, removed, cells - total];
	let plus = Math.round((added / total) * cells);
	if (added > 0 && plus === 0) plus = 1;
	if (removed > 0 && plus === cells) plus = cells - 1;
	return [plus, cells - plus, 0];
}

/** Exit code from Pi's bash error text (`Command exited with code N`). */
export function exitCodeOf(text: string): number | undefined {
	const match = /Command exited with code (\d+)/.exec(text);
	return match ? Number(match[1]) : undefined;
}

export function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

/** Last non-empty line, skipping Pi's own status footers. */
export function lastLine(text: string): string {
	const lines = text.split("\n").map((line) => line.trim());
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		if (!line || /^Command (exited with code|terminated without)/.test(line) || /^\[.*\]$/.test(line)) continue;
		return line;
	}
	return "";
}

export function countLines(text: string): number {
	if (!text) return 0;
	const lines = text.split("\n");
	return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

/** Lines shown by Pi's read tool, plus the file total from its continuation notice. */
export function readLines(text: string): { shown: number; total?: number } {
	const notice = /\n\n\[([^\n]*)\]\s*$/.exec(text);
	const shown = countLines(notice ? text.slice(0, notice.index) : text);
	if (!notice) return { shown };
	const range = /^Showing lines (\d+)-(\d+) of (\d+)/.exec(notice[1]!);
	if (range) return { shown: Number(range[2]) - Number(range[1]) + 1, total: Number(range[3]) };
	const more = /^(\d+) more lines in file/.exec(notice[1]!);
	return more ? { shown, total: shown + Number(more[1]) } : { shown };
}

export function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Paths relative to cwd when inside it, otherwise with `~` for home. */
export function displayPath(path: string, cwd: string, home: string): string {
	if (!path) return "";
	if (cwd && path === cwd) return ".";
	if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
	if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
	return path;
}

export type Weekly = { percent: number; stale: boolean } | "loading" | "unavailable";

/**
 * Weekly quota from codex-statusline's footer text, e.g.
 * `me@example.com · weekly 63% left (stale)`. Keep in sync with its `formatStatus()`.
 */
export function parseWeekly(text: string | undefined): Weekly | undefined {
	if (!text) return undefined;
	const match = /\bweekly (\d{1,3})% left( \(stale\))?/.exec(text);
	if (match) return { percent: Math.min(100, Number(match[1])), stale: Boolean(match[2]) };
	if (/\bweekly loading\b/.test(text)) return "loading";
	if (/\bweekly unavailable\b/.test(text)) return "unavailable";
	return undefined;
}

/** The account label alone: `me@example.com · weekly 63% left` → `me@example.com`. */
export function stripWeekly(text: string): string {
	return text.replace(/\s*·\s*weekly\b.*$/, "").trim();
}

/** Status text from other extensions, flattened to one line like Pi's footer. */
export function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}
