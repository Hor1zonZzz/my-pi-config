/**
 * The two background models, behind an interface so capture and dream can be tested without Pi.
 * index.ts implements it with ctx.modelRegistry.
 */
import { appendCall, type CallRecord, type CallRole, type CallUsage } from "./call-log.ts";

export interface ModelRef {
	provider: string;
	model: string;
}

export interface ClassifyReply {
	answers?: Record<string, unknown>;
	usage: CallUsage | null;
	stopReason: string;
	error?: string;
}

export interface WriteReply {
	/** Any text the writer produced besides its tool call. */
	text: string;
	/** Arguments of the writer's first save_memory call, if it made one. */
	toolArgs?: Record<string, unknown>;
	usage: CallUsage | null;
	stopReason: string;
	error?: string;
}

export type Reasoning = "low" | "high";

export interface ModelPort {
	/** Jev through OpenRouter, or a reason it cannot be used. */
	judge: ModelRef | { unavailable: string };
	/** DeepSeek Flash with the save_memory tool, or a reason it cannot be used. */
	writer: ModelRef | { unavailable: string };
	classify(state: Record<string, unknown>, questions: Record<string, unknown>, signal: AbortSignal): Promise<ClassifyReply>;
	write(systemPrompt: string, user: string, reasoning: Reasoning, signal: AbortSignal): Promise<WriteReply>;
}

export function isAvailable(ref: ModelRef | { unavailable: string }): ref is ModelRef {
	return !("unavailable" in ref);
}

/** Times one model call and appends it to calls.jsonl; logging failures never break the caller. */
export async function recordedCall<T extends { usage: CallUsage | null; stopReason: string; error?: string }>(
	options: {
		dir: string;
		session: string;
		role: CallRole;
		ref: ModelRef;
		reasoning: Reasoning | null;
		input: unknown;
	},
	call: () => Promise<T>,
	describe: (reply: T) => { output: unknown; outcome: string },
): Promise<T> {
	const started = Date.now();
	let reply: T;
	try {
		reply = await call();
	} catch (error) {
		reply = { usage: null, stopReason: "error", error: error instanceof Error ? error.message : String(error) } as T;
	}
	const { output, outcome } = describe(reply);
	const record: CallRecord = {
		ts: new Date(started).toISOString(),
		session: options.session,
		role: options.role,
		provider: options.ref.provider,
		model: options.ref.model,
		reasoning: options.reasoning,
		latencyMs: Date.now() - started,
		usage: reply.usage,
		stopReason: reply.stopReason,
		error: reply.error ?? null,
		input: options.input,
		output,
		outcome: reply.error ? "error" : outcome,
	};
	await appendCall(options.dir, record).catch(() => {});
	return reply;
}
