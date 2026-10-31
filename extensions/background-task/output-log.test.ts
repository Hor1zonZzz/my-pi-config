import assert from "node:assert/strict";
import test from "node:test";
import { OutputLog } from "./output-log.ts";

function collect(chunks: (string | Buffer)[], tailSize?: number, maxLineLength?: number) {
	let text = "";
	const log = new OutputLog((chunk) => (text += chunk), tailSize, maxLineLength);
	for (const chunk of chunks) log.push(chunk);
	log.end();
	return { text, log };
}

test("keeps only the final state of carriage-return progress lines", () => {
	const { text, log } = collect(["start\n10%\r50%", "\r100%\ndone"]);
	assert.equal(text, "start\n100%\ndone\n");
	assert.equal(log.lineCount, 3);
});

test("treats CRLF as one line break, including across chunks", () => {
	assert.equal(collect(["a\r", "\nb\r\n"]).text, "a\nb\n");
});

test("strips escape sequences split across chunks", () => {
	assert.equal(collect(["\x1b[3", "2mgreen\x1b[0m\n", "\x1b]0;title\x07plain\n"]).text, "green\nplain\n");
});

test("decodes UTF-8 split across chunks and drops control characters", () => {
	const bytes = Buffer.from("héllo\b\n");
	assert.equal(collect([bytes.subarray(0, 2), bytes.subarray(2)]).text, "héllo\n");
});

test("splits over-long lines and keeps a bounded tail", () => {
	const { text, log } = collect(["abcdefg\n1\n2\n3\n"], 2, 3);
	assert.equal(text, "abc\ndef\ng\n1\n2\n3\n");
	assert.equal(log.lineCount, 6);
	assert.deepEqual(log.tail, ["2", "3"]);
});
