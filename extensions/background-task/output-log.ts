import { StringDecoder } from "node:string_decoder";

// Complete CSI, OSC, and two-byte escape sequences.
const ANSI_SEQUENCE =
	/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// An escape sequence cut off at the end of a chunk.
const PARTIAL_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*|)$/;
// Control characters other than tab, newline, and carriage return.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;
const LINE_BREAK = /[\r\n]/g;
const MAX_CARRY = 4096;

/**
 * Turns raw terminal output into plain log lines.
 *
 * Escape sequences and control characters are removed, and a carriage return that is not
 * part of CRLF overwrites the current line, so progress bars leave only their final state.
 * Over-long lines are split. The last `tailSize` lines are kept in memory for notifications.
 */
export class OutputLog {
	lineCount = 0;
	readonly tail: string[] = [];
	private current = "";
	private pendingCarriageReturn = false;
	private carry = "";
	private readonly decoder = new StringDecoder("utf8");
	private readonly write: (text: string) => void;
	private readonly tailSize: number;
	private readonly maxLineLength: number;

	constructor(write: (text: string) => void, tailSize = 50, maxLineLength = 16 * 1024) {
		this.write = write;
		this.tailSize = tailSize;
		this.maxLineLength = maxLineLength;
	}

	push(chunk: Buffer | string): void {
		this.consume(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
	}

	end(): void {
		this.consume(this.decoder.end());
		this.carry = "";
		if (this.current.length > 0) this.flushLine();
	}

	private consume(input: string): void {
		let text = this.carry + input;
		this.carry = "";
		const partial = PARTIAL_SEQUENCE.exec(text);
		if (partial) {
			text = text.slice(0, partial.index);
			// An unterminated sequence that keeps growing is not a real escape sequence; drop it.
			if (partial[0].length <= MAX_CARRY) this.carry = partial[0];
		}
		text = text.replace(ANSI_SEQUENCE, "");

		let start = 0;
		LINE_BREAK.lastIndex = 0;
		for (let match = LINE_BREAK.exec(text); match; match = LINE_BREAK.exec(text)) {
			this.appendSegment(text.slice(start, match.index));
			if (match[0] === "\n") {
				this.flushLine();
			} else {
				this.pendingCarriageReturn = true;
			}
			start = match.index + 1;
		}
		this.appendSegment(text.slice(start));
	}

	private appendSegment(segment: string): void {
		const clean = segment.replace(CONTROL, "");
		if (clean.length === 0) return;
		if (this.pendingCarriageReturn) {
			this.current = "";
			this.pendingCarriageReturn = false;
		}
		this.current += clean;
		while (this.current.length > this.maxLineLength) {
			const rest = this.current.slice(this.maxLineLength);
			this.current = this.current.slice(0, this.maxLineLength);
			this.flushLine();
			this.current = rest;
		}
	}

	private flushLine(): void {
		const line = this.current;
		this.current = "";
		this.pendingCarriageReturn = false;
		this.write(`${line}\n`);
		this.lineCount += 1;
		this.tail.push(line);
		if (this.tail.length > this.tailSize) this.tail.shift();
	}
}
