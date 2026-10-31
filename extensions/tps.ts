import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

export default function (pi: ExtensionAPI) {
	let agentStartMs: number | null = null;

	pi.on("agent_start", () => {
		agentStartMs = Date.now();
	});

	pi.on("agent_end", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (agentStartMs === null) return;

		const wallMs = Date.now() - agentStartMs;
		agentStartMs = null;

		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let totalTokens = 0;
		// Pi records each model request's own duration, so tool execution and
		// work between turns are excluded. Responses without it (legacy or
		// deferred results) fall back to the whole run's wall-clock time.
		let modelMs = 0;
		let allTimed = true;

		for (const message of event.messages) {
			if (!isAssistantMessage(message)) continue;
			input += message.usage.input || 0;
			output += message.usage.output || 0;
			cacheRead += message.usage.cacheRead || 0;
			cacheWrite += message.usage.cacheWrite || 0;
			totalTokens += message.usage.totalTokens || 0;
			if (typeof message.durationMs === "number") modelMs += message.durationMs;
			else allTimed = false;
		}

		if (output <= 0) return;

		const elapsedMs = allTimed ? modelMs : wallMs;
		if (elapsedMs <= 0) return;

		const elapsedSeconds = elapsedMs / 1000;
		const tokensPerSecond = output / elapsedSeconds;
		const clock = allTimed ? "" : " (wall clock)";
		const message = `TPS ${tokensPerSecond.toFixed(1)} tok/s. out ${output.toLocaleString()}, in ${input.toLocaleString()}, cache r/w ${cacheRead.toLocaleString()}/${cacheWrite.toLocaleString()}, total ${totalTokens.toLocaleString()}, ${elapsedSeconds.toFixed(1)}s${clock}`;
		ctx.ui.notify(message, "info");
	});
}
