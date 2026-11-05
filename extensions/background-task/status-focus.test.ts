import assert from "node:assert/strict";
import test from "node:test";
import { focusTransition, listWindow, reconcileFocus } from "./status-focus.ts";

test("down with the editor cursor at the bottom focuses the first visible footer entry", () => {
	assert.deepEqual(focusTransition(undefined, "down", ["bg", "mon"], true), { focused: "bg", consume: true });
	assert.deepEqual(focusTransition(undefined, "down", ["mon"], true), { focused: "mon", consume: true });
	assert.deepEqual(focusTransition(undefined, "down", ["bg"], false), { focused: undefined, consume: false });
	assert.deepEqual(focusTransition(undefined, "down", [], true), { focused: undefined, consume: false });
	assert.deepEqual(focusTransition(undefined, "enter", ["bg"], true), { focused: undefined, consume: false });
});

test("left and right move between visible entries and stop at the ends", () => {
	assert.deepEqual(focusTransition("bg", "right", ["bg", "mon"], true), { focused: "mon", consume: true });
	assert.deepEqual(focusTransition("mon", "right", ["bg", "mon"], true), { focused: "mon", consume: true });
	assert.deepEqual(focusTransition("mon", "left", ["bg", "mon"], true), { focused: "bg", consume: true });
	assert.deepEqual(focusTransition("bg", "left", ["bg", "mon"], true), { focused: "bg", consume: true });
});

test("enter opens the focused list; up and escape return to the editor", () => {
	assert.deepEqual(focusTransition("mon", "enter", ["bg", "mon"], true), {
		focused: "mon",
		consume: true,
		open: "mon",
	});
	assert.deepEqual(focusTransition("bg", "up", ["bg"], true), { focused: undefined, consume: true });
	assert.deepEqual(focusTransition("bg", "escape", ["bg"], true), { focused: undefined, consume: true });
	assert.deepEqual(focusTransition("bg", "down", ["bg"], true), { focused: "bg", consume: true });
});

test("other keys return focus to the editor and reach it", () => {
	assert.deepEqual(focusTransition("bg", "other", ["bg"], true), { focused: undefined, consume: false });
});

test("focus on an entry that disappeared goes back to the editor", () => {
	assert.equal(reconcileFocus("bg", ["mon"]), undefined);
	assert.equal(reconcileFocus("mon", ["bg", "mon"]), "mon");
	assert.deepEqual(focusTransition("bg", "right", ["mon"], true), { focused: undefined, consume: false });
});

test("the list window keeps the selection visible", () => {
	assert.deepEqual(listWindow(0, 0, 5), { selected: 0, start: 0, end: 0 });
	assert.deepEqual(listWindow(2, 3, 5), { selected: 2, start: 0, end: 3 });
	assert.deepEqual(listWindow(9, 20, 5), { selected: 9, start: 7, end: 12 });
	assert.deepEqual(listWindow(19, 20, 5), { selected: 19, start: 15, end: 20 });
	assert.deepEqual(listWindow(25, 20, 5), { selected: 19, start: 15, end: 20 });
	assert.deepEqual(listWindow(-1, 20, 5), { selected: 0, start: 0, end: 5 });
});
