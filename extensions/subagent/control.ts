import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents } from "./agents.ts";
import type { BackgroundJobs } from "./background.ts";
import { glyph } from "./render.ts";
import type { SubagentDetails } from "./render.ts";
import { runAgent } from "./runner.ts";
import { interrupted, type LiveRun, type RunRegistry, type RunSnapshot, type WaitingRun } from "./runs.ts";
import { listRuns, parentSessionDir, sessionFileOf, shortRunId } from "./store.ts";
import { finalAnswers, modelStatus } from "./tool.ts";

// subagent_control: the main agent's two ways to act on a run it started.
// send  - to a running run: delivered after its current step, or at once with
//         interrupt; to a finished run: continues it in the background on its
//         own session file, like a new single-run job.
// stop  - ends a running run (abort, orderly exit, then signals if needed).

/** How long send waits for a just-dispatched run to start before calling it queued. */
const SEND_START_WAIT_MS = 5000;

export const ControlParams = Type.Object({
	action: StringEnum(["send", "stop"] as const, { description: "send: give a run a message; stop: end a running run" }),
	run: Type.String({ description: "Run ID from a subagent result (the 8-character short ID is enough)" }),
	message: Type.Optional(Type.String({ description: "send: the message for the subagent" })),
	interrupt: Type.Optional(
		Type.Boolean({ description: "send to a running run: stop its current step and handle the message at once. Default: false (delivered after the current step)." }),
	),
});

export const CONTROL_DESCRIPTION = [
	"Act on a subagent run started from this session.",
	"send: to a running run the message is delivered after its current step (interrupt: true stops that step and handles it at once);",
	"to a finished run it continues that run in the background with its full context, and its answer arrives like any background result.",
	"stop: end a running run.",
].join(" ");

interface ControlEntry {
	snapshot?: RunSnapshot;
	live?: LiveRun;
	/** Dispatched but not started yet. */
	waiting?: WaitingRun;
	id: string;
}

/** This session's runs: live ones from the registry and finished ones recorded on disk. */
function sessionRuns(registry: RunRegistry, sessionId: string): ControlEntry[] {
	const entries = new Map<string, ControlEntry>();
	for (const snapshot of listRuns(parentSessionDir(sessionId))) entries.set(snapshot.id, { id: snapshot.id, snapshot: interrupted(snapshot) });
	for (const waiting of registry.waitingRuns()) {
		if (waiting.parentSessionId === sessionId) entries.set(waiting.id, { id: waiting.id, waiting });
	}
	for (const live of registry.list()) {
		if (live.snapshot.parentSessionId === sessionId) entries.set(live.id, { id: live.id, snapshot: live.snapshot, live });
	}
	return [...entries.values()];
}

export function resolveRun(entries: ControlEntry[], ref: string): ControlEntry {
	const key = ref.trim();
	const matches = entries.filter((e) => e.id === key || e.id.startsWith(key));
	if (!key || matches.length === 0) throw new Error(`No subagent run "${ref}" in this session.`);
	if (matches.length > 1) throw new Error(`"${ref}" matches ${matches.length} runs (${matches.map((e) => shortRunId(e.id)).join(", ")}); use more characters.`);
	return matches[0]!;
}

export interface ControlDeps {
	registry: RunRegistry;
	background: BackgroundJobs;
}

async function continueRun(s: RunSnapshot, message: string, deps: ControlDeps, ctx: ExtensionContext): Promise<string> {
	const sessionFile = sessionFileOf(s);
	if (!sessionFile) throw new Error(`Run ${shortRunId(s.id)} has no session file to continue.`);
	const discovery = discoverAgents(ctx.cwd, s.agentSource === "project" ? "both" : "user");
	const agent = discovery.agents.find((a) => a.name === s.agent && (s.agentSource === "unknown" || a.source === s.agentSource));
	if (!agent) throw new Error(`Agent "${s.agent}" is no longer available.`);
	// Continuing a project agent runs repo-controlled instructions again; ask as the subagent tool does.
	if (agent.source === "project" && ctx.hasUI) {
		const ok = await ctx.ui.confirm(
			"Continue a project-local agent?",
			`Agent: ${agent.name}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
		);
		if (!ok) throw new Error("Canceled: project-local agent not approved.");
	}
	const reserved = { id: s.id, sessionFile };
	const requested = [{ agent: agent.name }];
	let jobId = "";
	jobId = deps.background.start(ctx, `${agent.name}: ${message.slice(0, 200)}`, async (signal) => {
		const run = await runAgent({
			agent,
			task: message,
			prompt: message,
			cwd: s.cwd || ctx.cwd,
			defaults: { model: s.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined), thinkingLevel: ctx.thinkingLevel },
			mode: "async",
			group: { kind: "single", index: 0, total: 1 },
			parentSessionId: s.parentSessionId,
			jobId,
			signal,
			registry: deps.registry,
			reserved,
		});
		const snapshot = { ...run.snapshot, group: { ...run.snapshot.group } };
		const details: SubagentDetails = { version: 2, mode: "single", agentScope: "user", projectAgentsDir: null, runs: [snapshot], pending: [], runIds: [shortRunId(s.id)], sessionFiles: [sessionFile] };
		return {
			content: [{ type: "text", text: finalAnswers([snapshot], requested, [reserved]) }],
			details,
			isError: snapshot.status !== "completed",
			cancelled: snapshot.status === "cancelled",
		};
	});
	return `Continued ${shortRunId(s.id)} in background job ${jobId}; its answer arrives when it finishes.\n${shortRunId(s.id)} ${agent.name} running ${sessionFile}`;
}

export async function control(params: { action: "send" | "stop"; run: string; message?: string; interrupt?: boolean }, deps: ControlDeps, ctx: ExtensionContext): Promise<string> {
	const sessionId = ctx.sessionManager.getSessionId();
	let entry = resolveRun(sessionRuns(deps.registry, sessionId), params.run);
	const id = shortRunId(entry.id);

	if (params.action === "stop" && entry.waiting) {
		deps.registry.stopBeforeStart(entry.id);
		return `${id} will not start.`;
	}
	if (params.action === "send" && entry.waiting) {
		// Right after dispatch a run takes a moment to start; a queued one waits for a free slot.
		const started = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => finish(false), SEND_START_WAIT_MS);
			const unsubscribe = deps.registry.subscribe(() => {
				if (deps.registry.get(entry.id)) finish(true);
			});
			function finish(value: boolean) {
				clearTimeout(timer);
				unsubscribe();
				resolve(value);
			}
			if (deps.registry.get(entry.id)) finish(true);
		});
		if (!started) throw new Error(`${id} is queued and has not started; send again after its running notice.`);
		entry = resolveRun(sessionRuns(deps.registry, sessionId), entry.id);
	}
	const live = entry.live?.running ? entry.live : undefined;
	const snapshot = entry.live?.snapshot ?? entry.snapshot!;

	if (params.action === "stop") {
		if (!live) return `${id} is already ${modelStatus(snapshot.status)}.`;
		live.stop("agent");
		// The runner aborts, lets Pi exit, and signals it if needed; wait for the result.
		await new Promise<void>((resolve) => {
			if (!live.running) return resolve();
			const unsubscribe = deps.registry.subscribe(() => {
				if (live.running) return;
				unsubscribe();
				resolve();
			});
		});
		return `${id} ${modelStatus(live.snapshot.status)}.`;
	}

	const message = params.message?.trim();
	if (!message) throw new Error("send needs a message.");
	if (!live) return continueRun(snapshot, message, deps, ctx);
	if (params.interrupt) {
		if (!live.interrupt) throw new Error(`${id} is finishing; send again once it has finished to continue it.`);
		await live.interrupt(message);
		return `Interrupted ${id}; it is working on your message now.`;
	}
	if (!live.steer) throw new Error(`${id} is finishing; send again once it has finished to continue it.`);
	await live.steer(message);
	return `Sent to ${id}; it sees the message after its current step.`;
}

function callLine(theme: Theme, args: { action?: string; run?: string; interrupt?: boolean }, status: "running" | "completed" | "failed", width: number): string {
	const target = [args.run, args.interrupt ? "interrupt" : ""].filter(Boolean).join(" · ");
	const line = `  ${glyph(theme, status, Date.now())}  ${theme.fg("toolTitle", theme.bold("subagent_control"))}  ${theme.fg("accent", args.action ?? "…")}${target ? theme.fg("dim", `  ${target}`) : ""}`;
	return truncateToWidth(line, width, "");
}

export function registerControlTool(pi: ExtensionAPI, deps: ControlDeps): void {
	pi.registerTool({
		name: "subagent_control",
		label: "Subagent control",
		description: CONTROL_DESCRIPTION,
		promptSnippet: "Send a message to a subagent run (steer, interrupt, or continue it) or stop it",
		parameters: ControlParams,
		renderShell: "self",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const text = await control(params, deps, ctx);
			return { content: [{ type: "text", text }], details: { action: params.action, run: params.run } };
		},

		renderCall(args, theme, context) {
			const state = context.state as { status?: "completed" | "failed" };
			const lines: Component = { render: (width) => [callLine(theme, args, state.status ?? "running", width)], invalidate() {} };
			return lines;
		},

		renderResult(result, { isPartial }, theme, context) {
			const state = context.state as { status?: "completed" | "failed" };
			if (!isPartial) state.status = context.isError ? "failed" : "completed";
			const first = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n").split("\n")[0] ?? "";
			return {
				render: (width: number) => (first ? [truncateToWidth(`     ${theme.fg("dim", "╰")} ${theme.fg(context.isError ? "error" : "dim", first)}`, width, "")] : []),
				invalidate() {},
			};
		},
	});
}
