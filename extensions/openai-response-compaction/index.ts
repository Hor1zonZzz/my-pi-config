import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NativeCompactionController } from "./controller.ts";
import { initializeResponsesSerializer } from "./serializer.ts";

export default async function openAIResponseCompaction(
	pi: ExtensionAPI,
): Promise<void> {
	await initializeResponsesSerializer();
	const controller = new NativeCompactionController(pi);

	pi.registerCommand("compact-openai", {
		description: "Compact context with the OpenAI Codex Responses API",
		handler: (args, ctx) => controller.compactCommand(args, ctx),
	});

	pi.on("session_start", (_event, ctx) => controller.startSession(ctx));
	pi.on("model_select", (_event, ctx) => controller.modelSelected(ctx));
	pi.on("input", (_event, ctx) => controller.handleInput(ctx));
	pi.on("session_before_tree", (event, ctx) =>
		controller.beforeTree(event, ctx),
	);
	pi.on("session_before_compact", (event, ctx) =>
		controller.beforeCompact(event, ctx),
	);
	pi.on("before_provider_request", (event, ctx) =>
		controller.beforeProviderRequest(event, ctx),
	);
	pi.on("session_compact", (event, ctx) =>
		controller.sessionCompacted(event, ctx),
	);
	pi.on("session_shutdown", () => controller.shutdown());
}
