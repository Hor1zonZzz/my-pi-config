import assert from "node:assert/strict";
import test from "node:test";
import {
	countLines,
	diffBlocks,
	diffStats,
	displayPath,
	exitCodeOf,
	firstLine,
	formatCount,
	formatDuration,
	formatSpeed,
	formatToolDuration,
	lastLine,
	messageSpeed,
	oneLine,
	parseWeekly,
	readLines,
	sanitizeStatus,
	sparkLevels,
} from "./format.ts";

test("formats counts and durations compactly", () => {
	assert.deepEqual([0, 950, 1234, 118_400, 3_400_000, 42_000_000].map(formatCount), ["0", "950", "1.2k", "118k", "3.4M", "42M"]);
	assert.deepEqual([800, 8_400, 72_000, 3_780_000].map(formatDuration), ["0s", "8s", "1m 12s", "1h 3m"]);
	assert.deepEqual([1_230, 12_500].map(formatToolDuration), ["1.2s", "12s"]);
	assert.deepEqual([4.26, 51.4, 132.6].map(formatSpeed), ["4.3", "51", "133"]);
});

test("measures message speed only for meaningful messages", () => {
	assert.equal(messageSpeed(510, 0, 10_000), 51);
	assert.equal(messageSpeed(0, 0, 10_000), undefined);
	assert.equal(messageSpeed(40, 0, 200), undefined);
	assert.equal(messageSpeed(40, 500, 100), undefined);
});

test("maps speeds to block levels relative to the window maximum", () => {
	assert.deepEqual(sparkLevels([1, 2, 4, 8]), ["▂", "▃", "▅", "█"]);
	assert.deepEqual(sparkLevels([0, 0]), ["▁", "▁"]);
	assert.deepEqual(sparkLevels([]), []);
});

test("counts Pi display-diff lines and splits five squares", () => {
	assert.deepEqual(diffStats(" 1 a\n-2 old\n+2 new\n+3 add\n   ...\n 9 z"), { added: 2, removed: 1 });
	assert.deepEqual(diffBlocks(3, 1), [3, 1, 1]);
	assert.deepEqual(diffBlocks(40, 10), [4, 1, 0]);
	assert.deepEqual(diffBlocks(1, 100), [1, 4, 0]);
	assert.deepEqual(diffBlocks(100, 0), [5, 0, 0]);
	assert.deepEqual(diffBlocks(0, 0), [0, 0, 5]);
});

test("extracts useful lines from tool output", () => {
	const bashError = "checking install.sh\ninstall.sh: line 88: syntax error\n\nCommand exited with code 2";
	assert.equal(exitCodeOf(bashError), 2);
	assert.equal(exitCodeOf("plain failure"), undefined);
	assert.equal(lastLine(bashError), "install.sh: line 88: syntax error");
	assert.equal(lastLine("out\n[Truncated: showing 10 of 20 lines]\n"), "out");
	assert.equal(firstLine("\n  Could not edit file: a.ts.\nmore"), "Could not edit file: a.ts.");
	assert.deepEqual(["", "a", "a\n", "a\nb"].map(countLines), [0, 1, 1, 2]);
	assert.deepEqual(readLines("a\nb\nc"), { shown: 3 });
	assert.deepEqual(readLines("a\nb\n\n[Showing lines 1-5 of 212. Use offset=6 to continue.]"), { shown: 5, total: 212 });
	assert.deepEqual(readLines("a\nb\n\n[40 more lines in file. Use offset=3 to continue.]"), { shown: 2, total: 42 });
	assert.equal(oneLine("  git status\n  && ls "), "git status && ls");
});

test("parses codex-statusline weekly wording", () => {
	assert.deepEqual(parseWeekly("me@example.com · weekly 63% left"), { percent: 63, stale: false });
	assert.deepEqual(parseWeekly("acct-1234abcd · weekly 0% left (stale)"), { percent: 0, stale: true });
	assert.equal(parseWeekly("Codex · weekly loading"), "loading");
	assert.equal(parseWeekly("me@example.com · weekly unavailable"), "unavailable");
	assert.equal(parseWeekly(undefined), undefined);
	assert.equal(parseWeekly("something else"), undefined);
});

test("shortens paths and flattens statuses", () => {
	assert.equal(displayPath("/home/me/repo/src/a.ts", "/home/me/repo", "/home/me"), "src/a.ts");
	assert.equal(displayPath("/home/me/other/b.ts", "/home/me/repo", "/home/me"), "~/other/b.ts");
	assert.equal(displayPath("/etc/hosts", "/home/me/repo", "/home/me"), "/etc/hosts");
	assert.equal(displayPath("/home/me/repo", "/home/me/repo", "/home/me"), ".");
	assert.equal(sanitizeStatus("a\n b\t\tc   d "), "a b c d");
});
