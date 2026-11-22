import assert from "node:assert/strict";
import test from "node:test";
import { DOUBLE_PRESS_MS, DoublePress } from "./double-press.ts";

test("a second press over the same draft inside the window completes a double press", () => {
	const presses = new DoublePress();
	assert.equal(presses.press(1000, "draft"), false);
	assert.equal(presses.press(1000 + DOUBLE_PRESS_MS - 1, "draft"), true);
});

test("a slow second press starts over", () => {
	const presses = new DoublePress();
	assert.equal(presses.press(1000, "draft"), false);
	assert.equal(presses.press(1000 + DOUBLE_PRESS_MS, "draft"), false);
	assert.equal(presses.press(1100 + DOUBLE_PRESS_MS, "draft"), true);
});

test("a completed double press does not chain into the next press", () => {
	const presses = new DoublePress();
	presses.press(1000, "draft");
	assert.equal(presses.press(1100, "draft"), true);
	assert.equal(presses.press(1200, "draft"), false);
});

test("an edit between the presses starts over", () => {
	const presses = new DoublePress();
	assert.equal(presses.press(1000, "draft"), false);
	assert.equal(presses.press(1100, "draft!"), false);
	assert.equal(presses.press(1200, "draft!"), true);
});

test("a press over nothing clearable never counts and forgets the earlier press", () => {
	const presses = new DoublePress();
	assert.equal(presses.press(1000, undefined), false);
	assert.equal(presses.press(1100, "draft"), false);
	assert.equal(presses.press(1200, undefined), false);
	assert.equal(presses.press(1300, "draft"), false);
});
