type SessionStartContext = {
	hasUI: boolean;
	ui: {
		notify(message: string, level: "warning"): void;
	};
};

type HerdrCheckAPI = {
	exec(
		command: string,
		args: string[],
		options: { timeout: number },
	): Promise<{ code: number | null; killed: boolean; stdout: string }>;
	on(
		event: "session_start",
		handler: (
			event: { reason: string },
			ctx: SessionStartContext,
		) => void | Promise<void>,
	): void;
};

const CHECK_TIMEOUT_MS = 2_000;
const PI_STATUS_PATTERN =
	/^pi:\s+(current|outdated|not installed)(?:\s+\(([^)\r\n]+)\))?/m;

function isRunningInHerdr(): boolean {
	const runtime = globalThis as typeof globalThis & {
		process?: { env?: Record<string, string | undefined> };
	};
	return runtime.process?.env?.HERDR_ENV === "1";
}

export default function registerHerdrIntegrationCheck(pi: HerdrCheckAPI) {
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" || !isRunningInHerdr() || !ctx.hasUI) {
			return;
		}

		try {
			const result = await pi.exec("herdr", ["integration", "status"], {
				timeout: CHECK_TIMEOUT_MS,
			});
			if (result.code !== 0 || result.killed) return;

			const match = result.stdout.match(PI_STATUS_PATTERN);
			if (!match) return;

			const [, status, detail] = match;
			if (status === "outdated") {
				ctx.ui.notify(
					`Herdr Pi integration is outdated${detail ? ` (${detail})` : ""}.\nRun: herdr integration install pi\nThen run /reload or restart Pi.`,
					"warning",
				);
			} else if (status === "not installed") {
				ctx.ui.notify(
					"Herdr Pi integration is not installed.\nRun: herdr integration install pi\nThen run /reload or restart Pi.",
					"warning",
				);
			}
		} catch {
			// Startup checks are advisory. Fail silently unless Herdr reports a
			// definitive outdated or missing Pi integration.
		}
	});
}
