import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";

const OPENAI_CODEX_PROVIDER = "openai-codex";

type FastState = {
	enabled: boolean;
};

const FAST_STATE_ENTRY_TYPE = "codex-fast";

function isCodexProvider(provider: string | undefined): boolean {
	return provider === OPENAI_CODEX_PROVIDER;
}

function applyFastServiceTier(
	payload: unknown,
	enabled: boolean,
): unknown | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return undefined;
	}

	const request = payload as Record<string, unknown>;
	if (enabled) {
		return { ...request, service_tier: "priority" };
	}
	if (!("service_tier" in request)) {
		return undefined;
	}

	const nextRequest = { ...request };
	delete nextRequest.service_tier;
	return nextRequest;
}

function getFastState(ctx: ExtensionContext): boolean {
	let enabled = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (
			entry.type !== "custom" ||
			entry.customType !== FAST_STATE_ENTRY_TYPE
		) {
			continue;
		}

		const state = entry.data as Partial<FastState> | undefined;
		if (typeof state?.enabled === "boolean") {
			enabled = state.enabled;
		}
	}
	return enabled;
}

function createFastAutocompleteProvider(
	current: AutocompleteProvider,
	isAvailable: () => boolean,
): AutocompleteProvider {
	return {
		triggerCharacters: current.triggerCharacters,

		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			// Pi owns command discovery and completion. Only filter visibility;
			// registerCommand currently has no model-dependent visibility option.
			if (!isAvailable() && /^\/fast\s/.test(beforeCursor)) return null;
			const result = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (isAvailable() || !result || !/^\/[^\s]*$/.test(beforeCursor)) return result;
			const items = result.items.filter((item) => item.value !== "fast");
			return items.length > 0 ? { ...result, items } : null;
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(
				lines,
				cursorLine,
				cursorCol,
				item,
				prefix,
			);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return (
				current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
				true
			);
		},
	};
}

export default function (pi: ExtensionAPI) {
	let fastEnabled = false;

	pi.on("before_provider_request", (event, ctx) => {
		if (!isCodexProvider(ctx.model?.provider)) {
			return undefined;
		}
		return applyFastServiceTier(event.payload, fastEnabled);
	});

	function updateStatus(ctx: ExtensionContext): void {
		const showFast = fastEnabled && isCodexProvider(ctx.model?.provider);
		ctx.ui.setStatus(
			"codex-fast",
			showFast ? ctx.ui.theme.fg("accent", "⚡ fast") : undefined,
		);
	}

	function restoreFastState(ctx: ExtensionContext): void {
		fastEnabled = getFastState(ctx);
		updateStatus(ctx);
	}

	function setFastMode(enabled: boolean, ctx: ExtensionContext): void {
		fastEnabled = enabled;
		pi.appendEntry(FAST_STATE_ENTRY_TYPE, { enabled });
		updateStatus(ctx);
		ctx.ui.notify(
			`Codex Fast: ${enabled ? "On (priority)" : "Off (default)"}`,
			"info",
		);
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") {
			ctx.ui.addAutocompleteProvider((current) =>
				createFastAutocompleteProvider(current, () =>
					isCodexProvider(ctx.model?.provider),
				),
			);
		}
		restoreFastState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreFastState(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Codex priority service tier",
		getArgumentCompletions(prefix) {
			const items = [
				{ value: "on", label: "on", description: "Use priority service tier" },
				{ value: "off", label: "off", description: "Use default service tier" },
			].filter((item) => item.value.startsWith(prefix.toLowerCase()));
			return items.length > 0 ? items : null;
		},
		async handler(args, ctx) {
			if (!isCodexProvider(ctx.model?.provider)) {
				ctx.ui.notify("/fast is only available for OpenAI Codex models", "warning");
				return;
			}

			let requested = args.trim().toLowerCase();
			if (!requested) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /fast on|off", "error");
					return;
				}
				const selection = await ctx.ui.select("Codex Fast", [
					"On — priority service tier",
					"Off — default service tier",
				]);
				if (!selection) return;
				requested = selection.startsWith("On") ? "on" : "off";
			}

			if (requested !== "on" && requested !== "off") {
				ctx.ui.notify("Usage: /fast on|off", "error");
				return;
			}
			setFastMode(requested === "on", ctx);
		},
	});
}
