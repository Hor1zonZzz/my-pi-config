import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import fastExtension from "./index.ts";

// Exercise the public command/event contracts without a terminal or API request.
function setup() {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	let command: Parameters<ExtensionAPI["registerCommand"]>[1];
	const branch: any[] = [];
	const notifications: string[] = [];
	let status: string | undefined;
	let autocomplete: AutocompleteProvider | undefined;
	let selection: string | undefined;
	const base: AutocompleteProvider = {
		triggerCharacters: ["#"],
		async getSuggestions() {
			return { prefix: "/", items: [
				{ value: "fast", label: "fast" },
				{ value: "model", label: "model" },
			] };
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
		shouldTriggerFileCompletion: () => false,
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		model: { provider: "openai-codex", id: "gpt-5.6-sol" },
		sessionManager: { getBranch: () => branch },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: (_key: string, text: string | undefined) => { status = text; },
			notify: (text: string) => { notifications.push(text); },
			select: async () => selection,
			addAutocompleteProvider: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => {
				autocomplete = factory(base);
			},
		},
	};
	fastExtension({
		on: (event: string, handler: (event: any, ctx: any) => any) => handlers.set(event, handler),
		registerCommand: (name: string, options: typeof command) => {
			assert.equal(name, "fast");
			command = options;
		},
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
	} as unknown as ExtensionAPI);
	const emit = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
	emit("session_start");
	return {
		ctx, branch, notifications, handlers, emit,
		run: (args: string) => command.handler(args, ctx as unknown as ExtensionCommandContext),
		complete: (prefix: string) => command.getArgumentCompletions!(prefix),
		get autocomplete() { return autocomplete!; },
		get status() { return status; },
		select: (value: string | undefined) => { selection = value; },
	};
}

test("official command owns parsing, including invalid multi-argument input", async () => {
	const h = setup();
	assert.equal(h.handlers.has("input"), false);
	assert.deepEqual((await h.complete("o"))?.map((item) => item.value), ["on", "off"]);
	assert.equal(await h.complete("unknown"), null);
	await h.run("on extra");
	assert.equal(h.notifications.at(-1), "Usage: /fast on|off");
	assert.equal(h.branch.length, 0);
	await h.run(" ON ");
	assert.deepEqual(h.branch.at(-1), { type: "custom", customType: "codex-fast", data: { enabled: true } });
	assert.equal(h.status, "⚡ fast");
});

test("only service_tier changes; Off removes an existing tier without mutating the payload", async () => {
	const h = setup();
	const payload = { model: "gpt-5.6-sol", input: [], reasoning: { effort: "high" } };
	assert.equal(h.emit("before_provider_request", { payload }), undefined);
	await h.run("on");
	const enabled = h.emit("before_provider_request", { payload });
	assert.deepEqual(enabled, { ...payload, service_tier: "priority" });
	assert.equal("service_tier" in payload, false);
	await h.run("off");
	assert.deepEqual(h.emit("before_provider_request", { payload: enabled }), payload);
	assert.equal(enabled.service_tier, "priority");
	assert.deepEqual(h.emit("before_provider_request", { payload: { ...payload, service_tier: "flex" } }), payload);
	for (const payload of [null, [], "invalid"]) {
		assert.equal(h.emit("before_provider_request", { payload }), undefined);
	}
});

test("selector cancellation and non-UI calls do not change state", async () => {
	const h = setup();
	await h.run("");
	assert.equal(h.branch.length, 0);
	h.select("On — priority service tier");
	await h.run("");
	assert.equal(h.status, "⚡ fast");
	h.ctx.hasUI = false;
	await h.run("");
	assert.equal(h.branch.length, 1);
	assert.equal(h.notifications.at(-1), "Usage: /fast on|off");
	await h.run("off");
	assert.equal(h.status, undefined);
});

test("restore follows the branch and independent instances default Off", async () => {
	const h = setup();
	await h.run("on");
	h.emit("session_start");
	assert.equal(h.status, "⚡ fast");
	await h.run("off");
	h.branch.pop();
	h.emit("session_tree");
	assert.equal(h.status, "⚡ fast");
	h.branch.push({ type: "custom", customType: "codex-fast", data: { enabled: "invalid" } });
	h.emit("session_tree");
	assert.equal(h.status, "⚡ fast");
	assert.equal(setup().status, undefined);
	h.branch.length = 0;
	h.emit("session_start");
	assert.equal(h.status, undefined);
});

test("non-Codex hides completion and status, rejects commands, and leaves requests alone", async () => {
	const h = setup();
	await h.run("on");
	const options = { signal: new AbortController().signal };
	const suggestions = () => h.autocomplete.getSuggestions(["/"], 0, 1, options);
	assert.deepEqual((await suggestions())?.items.map((item) => item.value), ["fast", "model"]);
	h.ctx.model.provider = "anthropic";
	h.emit("model_select");
	assert.equal(h.status, undefined);
	assert.deepEqual((await suggestions())?.items.map((item) => item.value), ["model"]);
	assert.equal(await h.autocomplete.getSuggestions(["/fast "], 0, 6, options), null);
	assert.deepEqual(h.autocomplete.triggerCharacters, ["#"]);
	assert.equal(h.autocomplete.shouldTriggerFileCompletion?.([""], 0, 0), false);
	const payload = { service_tier: "flex" };
	assert.equal(h.emit("before_provider_request", { payload }), undefined);
	await h.run("off");
	assert.equal(h.branch.length, 1);
	h.ctx.model.provider = "openai-codex";
	h.emit("model_select");
	assert.equal(h.status, "⚡ fast");
	assert.deepEqual((await suggestions())?.items.map((item) => item.value), ["fast", "model"]);
});
