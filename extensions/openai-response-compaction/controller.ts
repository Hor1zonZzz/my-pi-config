import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	generateSummaryWithUsage,
	getAgentDir,
	type BeforeProviderRequestEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type InputEventResult,
	type SessionBeforeCompactEvent,
	type SessionBeforeTreeEvent,
	type SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { executeNativeCompaction } from "./client.ts";
import {
	blockedPayload,
	rewritePayloadWithNativeCheckpoint,
} from "./replay.ts";
import {
	identitiesMatch,
	resolveRuntime,
	type NativeCompactionRuntime,
} from "./runtime.ts";
import {
	buildNativeCompactionRequest,
	serializeCompactionPlaceholder,
	serializeFallbackSummary,
} from "./serializer.ts";
import { shrinkNativeCompactionRequest } from "./shrink.ts";
import {
	createCheckpointSummary,
	findLatestNativeCheckpointState,
	isNativeCompactionDetails,
	isValidCompactedWindow,
	type NativeCompactionDetails,
	type NativeCompactionEntry,
} from "./types.ts";

const EXTENSION_NAME = "OpenAI native compaction";
const FALLBACK_TRUNCATION_MARKER =
	"\n\n[Fallback summary truncated to fit the persisted checkpoint.]";
const MIN_FALLBACK_SUMMARY_CHARACTERS = 4_096;

async function readFastEnabled(): Promise<boolean> {
	try {
		const parsed = JSON.parse(
			await readFile(join(getAgentDir(), "codex-fast.json"), "utf8"),
		) as unknown;
		return (
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			"enabled" in parsed &&
			parsed.enabled === true
		);
	} catch {
		return true;
	}
}

function compactionInstructions(
	ctx: ExtensionContext,
	customInstructions: string | undefined,
): string {
	const guidance = customInstructions?.trim();
	return guidance
		? `${ctx.getSystemPrompt()}\n\nAdditional user guidance for this compaction:\n${guidance}`
		: ctx.getSystemPrompt();
}

function failureDescription(result: {
	reason: string;
	status?: number;
	message?: string;
}): string {
	const status = result.status ? ` HTTP ${result.status}` : "";
	const detail = result.message?.trim() ? `: ${result.message.trim()}` : "";
	return `${result.reason}${status}${detail}`;
}

function checkpointState(ctx: ExtensionContext) {
	return findLatestNativeCheckpointState(ctx.sessionManager.getBranch());
}

function invalidCheckpointMessage(): string {
	return [
		"This session contains an invalid or incompatible OpenAI native compaction checkpoint.",
		"The request was blocked to avoid sending only its visible marker.",
	].join(" ");
}

function bindingMessage(entry: NativeCompactionEntry): string {
	return [
		"This session contains an OpenAI native compaction checkpoint bound to",
		`${entry.details.provider}/${entry.details.model}, its original ChatGPT account, and ${entry.details.baseUrl}.`,
		"Restore that exact account and model before continuing.",
	].join(" ");
}

function buildDetails(args: {
	runtime: NativeCompactionRuntime;
	event: SessionBeforeCompactEvent;
	compactedWindow: Record<string, unknown>[];
	responseId?: string;
	createdAt: string;
	previous: NativeCompactionEntry | undefined;
	rewrittenToolOutputs: number;
	fallbackMode?: "pi-summary";
}): NativeCompactionDetails {
	return {
		strategy: "openai-codex-responses-compact-v1",
		provider: "openai-codex",
		api: "openai-codex-responses",
		model: args.runtime.model,
		baseUrl: args.runtime.baseUrl,
		accountIdHash: args.runtime.accountIdHash,
		compactedWindow: args.compactedWindow,
		compactResponseId: args.responseId,
		createdAt: args.createdAt,
		requestMeta: {
			reason: args.event.reason,
			tokensBefore: args.event.preparation.tokensBefore,
			firstKeptEntryId: args.event.preparation.firstKeptEntryId,
			previousNativeCheckpoint: args.previous !== undefined,
			rewrittenToolOutputs: args.rewrittenToolOutputs,
			fallbackMode: args.fallbackMode,
		},
	};
}

function fitFallbackWindow(args: {
	runtime: NativeCompactionRuntime;
	previous: NativeCompactionEntry;
	summary: string;
}): Record<string, unknown>[] | undefined {
	const preserved = args.previous.details.compactedWindow.map((item) =>
		structuredClone(item),
	);
	const build = (text: string): Record<string, unknown>[] => [
		...preserved,
		...serializeFallbackSummary(args.runtime.modelConfig, text),
	];
	const complete = build(args.summary);
	if (isValidCompactedWindow(complete)) return complete;

	const characters = Array.from(args.summary);
	let low = 0;
	let high = characters.length;
	let best: Record<string, unknown>[] | undefined;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = build(
			`${characters.slice(0, middle).join("")}${FALLBACK_TRUNCATION_MARKER}`,
		);
		if (isValidCompactedWindow(candidate)) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}

function preflightReplay(args: {
	runtime: NativeCompactionRuntime;
	event: SessionBeforeCompactEvent;
	details: NativeCompactionDetails;
	summary: string;
}): boolean {
	const entry: NativeCompactionEntry = {
		type: "compaction",
		id: "native-compaction-preflight",
		parentId: null,
		timestamp: args.details.createdAt,
		summary: args.summary,
		firstKeptEntryId: args.event.preparation.firstKeptEntryId,
		tokensBefore: args.event.preparation.tokensBefore,
		details: args.details,
	};
	const placeholder = serializeCompactionPlaceholder(
		args.runtime.modelConfig,
		entry,
	);
	if (placeholder.length === 0) return false;
	const probe = rewritePayloadWithNativeCheckpoint({
		payload: {
			model: args.runtime.model,
			input: [...placeholder, { role: "user", content: "retained tail" }],
		},
		model: args.runtime.modelConfig,
		entry,
	});
	return (
		probe.ok &&
		probe.payload.input.length === args.details.compactedWindow.length + 1
	);
}

export class NativeCompactionController {
	constructor(
		private readonly pi: ExtensionAPI,
		private readonly summarize: typeof generateSummaryWithUsage = generateSummaryWithUsage,
	) {}

	async compactCommand(
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		await ctx.waitForIdle();
		ctx.compact({ customInstructions: args.trim() || undefined });
	}

	async startSession(ctx: ExtensionContext): Promise<void> {
		await this.notifyBindingMismatch(ctx, "warning");
	}

	async modelSelected(ctx: ExtensionContext): Promise<void> {
		await this.notifyBindingMismatch(ctx, "warning");
	}

	beforeTree(event: SessionBeforeTreeEvent, ctx: ExtensionContext) {
		if (!event.preparation.userWantsSummary) return undefined;
		const state = checkpointState(ctx);
		if (state.kind === "none") return undefined;
		ctx.ui.notify(
			"Tree navigation with branch summarization is blocked while an OpenAI native checkpoint is active. Retry without a branch summary so the encrypted checkpoint remains on its original branch.",
			"error",
		);
		return { cancel: true };
	}

	async handleInput(ctx: ExtensionContext): Promise<InputEventResult> {
		const mismatch = await this.currentBindingError(ctx);
		if (!mismatch) return { action: "continue" };
		ctx.ui.notify(mismatch, "error");
		return { action: "handled" };
	}

	async beforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
		const state = checkpointState(ctx);
		if (state.kind === "invalid") {
			ctx.ui.notify(invalidCheckpointMessage(), "error");
			return { cancel: true };
		}
		const previous = state.kind === "valid" ? state.entry : undefined;
		let resolution: Awaited<ReturnType<typeof resolveRuntime>> | undefined;
		try {
			resolution = await resolveRuntime(ctx);
			if (previous) {
				if (
					!resolution.ok ||
					!identitiesMatch(resolution.runtime, previous.details)
				) {
					ctx.ui.notify(bindingMessage(previous), "error");
					return { cancel: true };
				}
			}
			if (!resolution.ok) return undefined;
			if (event.signal.aborted) return { cancel: true };
			return await this.executeCompaction(
				event,
				ctx,
				resolution.runtime,
				previous,
			);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (!previous) {
				ctx.ui.notify(
					`${EXTENSION_NAME} failed (${reason}); Pi compaction will run instead.`,
					"warning",
				);
				return undefined;
			}
			if (!resolution?.ok) {
				ctx.ui.notify(
					`${EXTENSION_NAME} failed (${reason}); compaction was cancelled to preserve the existing checkpoint.`,
					"error",
				);
				return { cancel: true };
			}
			return this.fallbackAfterNativeFailure({
				event,
				ctx,
				runtime: resolution.runtime,
				previous,
				reason,
			});
		}
	}

	async beforeProviderRequest(
		event: BeforeProviderRequestEvent,
		ctx: ExtensionContext,
	): Promise<unknown | undefined> {
		const state = checkpointState(ctx);
		if (state.kind === "none") return undefined;
		if (state.kind === "invalid") {
			ctx.ui.notify(invalidCheckpointMessage(), "error");
			ctx.abort();
			return blockedPayload(event.payload);
		}
		const entry = state.entry;
		try {
			const resolution = await resolveRuntime(ctx);
			if (
				!resolution.ok ||
				!identitiesMatch(resolution.runtime, entry.details)
			) {
				ctx.ui.notify(bindingMessage(entry), "error");
				ctx.abort();
				return blockedPayload(event.payload);
			}
			const replay = rewritePayloadWithNativeCheckpoint({
				payload: event.payload,
				model: resolution.runtime.modelConfig,
				entry,
			});
			if (replay.ok) return replay.payload;

			ctx.ui.notify(
				`${EXTENSION_NAME} replay failed (${replay.reason}); the request was blocked to preserve context.`,
				"error",
			);
			ctx.abort();
			return blockedPayload(event.payload);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`${EXTENSION_NAME} replay raised an exception (${reason}); the request was blocked to preserve context.`,
				"error",
			);
			ctx.abort();
			return blockedPayload(event.payload);
		}
	}

	sessionCompacted(event: SessionCompactEvent, ctx: ExtensionContext): void {
		if (
			!event.fromExtension ||
			!isNativeCompactionDetails(event.compactionEntry.details)
		) {
			return;
		}
		const details = event.compactionEntry.details;
		const method = details.requestMeta.fallbackMode
			? "Pi text fallback layered onto the previous native checkpoint"
			: "OpenAI native compaction";
		ctx.ui.notify(
			`${method} completed with ${details.model}: ${details.requestMeta.tokensBefore} tokens before compaction; recent context retained from ${details.requestMeta.firstKeptEntryId}.`,
			"info",
		);
	}

	shutdown(): void {
		// No session-scoped resources are retained.
	}

	private async executeCompaction(
		event: SessionBeforeCompactEvent,
		ctx: ExtensionContext,
		runtime: NativeCompactionRuntime,
		previous: NativeCompactionEntry | undefined,
	) {
		const request = buildNativeCompactionRequest({
			pi: this.pi,
			model: runtime.modelConfig,
			event,
			previousCompactedWindow: previous?.details.compactedWindow,
			instructions: compactionInstructions(ctx, event.customInstructions),
			sessionId: ctx.sessionManager.getSessionId(),
			fastEnabled: await readFastEnabled(),
		});
		if (request.input.length === 0) return undefined;

		if (!this.preflightBeforeRequest(runtime, event, previous)) {
			ctx.ui.notify(
				`${EXTENSION_NAME} replay preflight failed; compaction was ${previous ? "cancelled to preserve the existing checkpoint" : "delegated to Pi"}.`,
				previous ? "error" : "warning",
			);
			return previous ? { cancel: true } : undefined;
		}
		const shrink = shrinkNativeCompactionRequest(
			request,
			runtime.modelConfig.contextWindow,
		);
		if (!shrink.fitsBudget) {
			return this.fallbackAfterNativeFailure({
				event,
				ctx,
				runtime,
				previous,
				reason: "compact request remained over its context budget",
			});
		}

		const response = await executeNativeCompaction({
			runtime,
			request: shrink.request,
			sessionId: ctx.sessionManager.getSessionId(),
			signal: event.signal,
		});
		if (!response.ok) {
			if (response.reason === "aborted") return { cancel: true };
			return this.fallbackAfterNativeFailure({
				event,
				ctx,
				runtime,
				previous,
				reason: failureDescription(response),
			});
		}

		const details = buildDetails({
			runtime,
			event,
			compactedWindow: response.compactedWindow,
			responseId: response.responseId,
			createdAt: response.createdAt,
			previous,
			rewrittenToolOutputs: shrink.rewrittenToolOutputs,
		});
		return {
			compaction: {
				summary: createCheckpointSummary(
					details,
					event.preparation.tokensBefore,
					response.createdAt,
				),
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details,
				usage: response.usage,
			},
		};
	}

	private preflightBeforeRequest(
		runtime: NativeCompactionRuntime,
		event: SessionBeforeCompactEvent,
		previous: NativeCompactionEntry | undefined,
	): boolean {
		const createdAt = new Date().toISOString();
		const details = buildDetails({
			runtime,
			event,
			compactedWindow: [{ type: "compaction", encrypted_content: "preflight" }],
			createdAt,
			previous,
			rewrittenToolOutputs: 0,
		});
		return preflightReplay({
			runtime,
			event,
			details,
			summary: createCheckpointSummary(
				details,
				event.preparation.tokensBefore,
				createdAt,
			),
		});
	}

	private preflightFallback(
		runtime: NativeCompactionRuntime,
		event: SessionBeforeCompactEvent,
		previous: NativeCompactionEntry,
	): boolean {
		const compactedWindow = [
			...previous.details.compactedWindow.map((item) => structuredClone(item)),
			...serializeFallbackSummary(
				runtime.modelConfig,
				`${"x".repeat(MIN_FALLBACK_SUMMARY_CHARACTERS)}${FALLBACK_TRUNCATION_MARKER}`,
			),
		];
		if (!isValidCompactedWindow(compactedWindow)) return false;
		const createdAt = new Date().toISOString();
		const details = buildDetails({
			runtime,
			event,
			compactedWindow,
			createdAt,
			previous,
			rewrittenToolOutputs: 0,
			fallbackMode: "pi-summary",
		});
		return preflightReplay({
			runtime,
			event,
			details,
			summary: createCheckpointSummary(
				details,
				event.preparation.tokensBefore,
				createdAt,
			),
		});
	}

	private async fallbackAfterNativeFailure(args: {
		event: SessionBeforeCompactEvent;
		ctx: ExtensionContext;
		runtime: NativeCompactionRuntime;
		previous: NativeCompactionEntry | undefined;
		reason: string;
	}) {
		const { event, ctx, runtime, previous, reason } = args;
		if (!previous) {
			ctx.ui.notify(
				`${EXTENSION_NAME} failed (${reason}); Pi compaction will run instead.`,
				"warning",
			);
			return undefined;
		}

		try {
			if (!this.preflightFallback(runtime, event, previous)) {
				ctx.ui.notify(
					"Pi text fallback was cancelled before generation because its persisted replay window would be unsafe or too large.",
					"error",
				);
				return { cancel: true };
			}
			ctx.ui.notify(
				`${EXTENSION_NAME} failed (${reason}); generating a Pi text fallback while preserving the previous native checkpoint.`,
				"warning",
			);
			const messages = [
				...event.preparation.messagesToSummarize,
				...event.preparation.turnPrefixMessages,
			];
			const fallback = await this.summarize(
				messages,
				runtime.modelConfig,
				event.preparation.settings.reserveTokens,
				runtime.apiKey,
				runtime.headers,
				event.signal,
				event.customInstructions,
				undefined,
				this.pi.getThinkingLevel(),
				undefined,
				runtime.env,
			);
			if (!fallback.text.trim())
				throw new Error("Pi returned an empty summary");
			const compactedWindow = fitFallbackWindow({
				runtime,
				previous,
				summary: fallback.text,
			});
			if (!compactedWindow) {
				throw new Error("fallback replay window was not safely serializable");
			}
			const createdAt = new Date().toISOString();
			const details = buildDetails({
				runtime,
				event,
				compactedWindow,
				responseId: previous.details.compactResponseId,
				createdAt,
				previous,
				rewrittenToolOutputs: 0,
				fallbackMode: "pi-summary",
			});
			return {
				compaction: {
					summary: createCheckpointSummary(
						details,
						event.preparation.tokensBefore,
						createdAt,
					),
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details,
					usage: fallback.usage,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`Pi text fallback failed (${message}); compaction was cancelled to preserve the existing native checkpoint.`,
				"error",
			);
			return { cancel: true };
		}
	}

	private async currentBindingError(
		ctx: ExtensionContext,
	): Promise<string | undefined> {
		const state = checkpointState(ctx);
		if (state.kind === "none") return undefined;
		if (state.kind === "invalid") return invalidCheckpointMessage();
		try {
			const resolution = await resolveRuntime(ctx);
			return resolution.ok &&
				identitiesMatch(resolution.runtime, state.entry.details)
				? undefined
				: bindingMessage(state.entry);
		} catch {
			return bindingMessage(state.entry);
		}
	}

	private async notifyBindingMismatch(
		ctx: ExtensionContext,
		level: "warning" | "error",
	): Promise<void> {
		const mismatch = await this.currentBindingError(ctx);
		if (mismatch) ctx.ui.notify(mismatch, level);
	}
}
