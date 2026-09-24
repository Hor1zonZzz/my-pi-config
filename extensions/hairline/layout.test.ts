import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	renderBottomBorder,
	renderCard,
	renderFooter,
	renderHeader,
	renderHud,
	renderSubLine,
	renderTopBorder,
} from "./layout.ts";
import { C, fg, setTrueColorOverride } from "./style.ts";

setTrueColorOverride(true);
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const WIDTHS = [1, 2, 10, 24, 40, 59, 60, 80, 120, 200];

const header = {
	version: "0.87.1",
	model: "gpt-5.6-sol",
	thinking: "medium",
	cwd: "~/workspace/项目/my-pi-config",
	branch: "main",
	hints: [["esc", "interrupt"], ["/", "commands"], ["!", "bash"], ["ctrl+o", "more"]] as Array<[string, string]>,
};
const footer = {
	cwd: "~/workspace/my-pi-config",
	branch: "main",
	input: 12_400,
	output: 3_100,
	cost: 0,
	subscription: true,
	statuses: ["me@example.com · weekly 63% left", "⚡ fast", "子代理: 1 running"],
};

test("every renderer stays within the terminal width", () => {
	for (const width of WIDTHS) {
		const lines = [
			...renderHeader(header, width),
			renderTopBorder({ lineColor: C.rule, hiddenAbove: 3, working: { label: "Running bash", elapsedMs: 12_000, errors: 2, frame: 7 } }, width),
			renderTopBorder({ lineColor: C.rule, hiddenAbove: 0, status: "Retrying (1/3) in 5s..." }, width),
			renderBottomBorder({ lineColor: C.rule, model: "gpt-5.6-sol", thinking: "xhigh", contextPercent: 91.4, hiddenBelow: 4 }, width),
			...renderFooter(footer, width),
			...renderHud({ speeds: [30, 44, 51, 63, 48], turns: 3, elapsedMs: 38_000 }, width),
			renderCard({ name: "bash", arg: "bash -n install.sh && git diff --check && echo 完成", status: "running", summary: fg(C.muted, "running · 4.0s"), frame: 3 }, width),
			renderSubLine("install.sh: line 88: syntax error near unexpected token `fi'", C.error, width),
		];
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(plain(line))}`);
	}
});

test("editor rules fill the width without side borders or corners", () => {
	const top = renderTopBorder({ lineColor: C.rule, hiddenAbove: 0 }, 50);
	const bottom = renderBottomBorder({ lineColor: C.rule, model: "gpt-5.6-sol", thinking: "medium", contextPercent: 42, hiddenBelow: 0 }, 80);
	assert.equal(plain(top), "─".repeat(50));
	assert.equal(visibleWidth(bottom), 80);
	assert.match(plain(bottom), /^─ gpt-5\.6-sol · medium ─+ context ▰▰▰▰▱▱▱▱▱▱ 42% ─$/);
	assert.doesNotMatch(plain(top + bottom), /[╭╮╰╯│]/);
});

test("top rule carries working status and scroll state", () => {
	const line = plain(renderTopBorder({ lineColor: C.rule, hiddenAbove: 3, working: { label: "Thinking", elapsedMs: 12_400, errors: 1, frame: 0 }, }, 80));
	assert.match(line, /^─ ⠋ Thinking · 12s ✕ 1 error ─+ ↑ 3 more ─$/);
	assert.equal(visibleWidth(line), 80);
});

test("bottom rule degrades gracefully", () => {
	assert.match(plain(renderBottomBorder({ lineColor: C.rule, contextPercent: null, hiddenBelow: 0 }, 60)), /no model .* context \? ─$/);
	assert.doesNotMatch(plain(renderBottomBorder({ lineColor: C.rule, model: "m", thinking: "off", contextPercent: 10, hiddenBelow: 0 }, 50)), /▰/);
});

test("footer uses one line when it fits and moves statuses down otherwise", () => {
	const wide = renderFooter(footer, 160).map(plain);
	assert.equal(wide.length, 1);
	assert.match(wide[0]!, /~\/workspace\/my-pi-config  main .*↑12k ↓3\.1k  ·  \$0\.000 sub  ·  me@example\.com · weekly 63% left · ⚡ fast · 子代理: 1 running  $/);
	const narrow = renderFooter(footer, 70).map(plain);
	assert.equal(narrow.length, 2);
	assert.match(narrow[0]!, /↑12k ↓3\.1k  ·  \$0\.000 sub  $/);
	assert.match(narrow[1]!, /^  me@example\.com/);
	assert.equal(renderFooter({ ...footer, statuses: [] }, 70).length, 1);
});

test("HUD shows speed history, peak, turn, and elapsed time", () => {
	assert.match(plain(renderHud({ speeds: [], turns: 0 }, 100)[0]!), /speed    ▁{16}  waiting for the first reply$/);
	const line = plain(renderHud({ speeds: [30, 60, 51], turns: 3, elapsedMs: 38_000 }, 100)[0]!);
	assert.match(line, /speed    ▁{13}[▁-█]{3}  51 tok\/s  ·  peak 60  ·  turn 3  ·  38s$/);
});

test("tool card keeps the summary visible when the argument is long", () => {
	const summary = fg(C.dim, "212 lines");
	const line = plain(renderCard({ name: "read", arg: `src/${"deep/".repeat(30)}file.ts`, status: "ok", summary, frame: 0 }, 60));
	assert.equal(visibleWidth(line), 60);
	assert.match(line, /^  ●  read  src\/deep.*…  212 lines  $/);
});

test("falls back to 256 colors without truecolor", () => {
	setTrueColorOverride(false);
	try {
		assert.match(fg(C.mint, "x"), /^\x1b\[38;5;\d+mx\x1b\[39m$/);
	} finally {
		setTrueColorOverride(true);
	}
	assert.match(fg(C.mint, "x"), /^\x1b\[38;2;159;227;207mx\x1b\[39m$/);
});
