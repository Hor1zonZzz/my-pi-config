/**
 * The dream worker: a detached Node process, started by a Pi session of the project, that runs one dream
 * and outlives every Pi session. It ends when the dream ends, when it gets SIGTERM (/memory → Dream →
 * stop), or when the machine stops. Progress and the result go to dream-status.json; output goes to
 * dream-worker.log.
 *
 * Usage: node dream-worker.ts '<WorkerArgs JSON>'
 *
 * Pi resolves `@earendil-works/*` and `typebox` for extensions; a plain Node process cannot, so bare
 * specifiers that fail to resolve here are retried from Pi's package directory (passed in by the
 * extension from `getPackageDir()`). Pi modules are imported only after that hook is registered.
 */
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dream } from "./dream.ts";
import { type DreamStatus, failureSummary, summarize, writeDreamStatus } from "./dream-status.ts";
import { acquireDreamLock, readConfig, writeConfig } from "./store.ts";

export interface WorkerArgs {
	piPackageDir: string;
	agentDir: string;
	dir: string;
	notes: string;
	sessionDir: string;
	/** The session that started the worker: left out of the review, and used to attribute calls. */
	session: string;
	trigger: "manual" | "auto";
	provider: string;
	model: string;
}

const args = JSON.parse(process.argv[2] ?? "{}") as WorkerArgs;
const piParent = pathToFileURL(join(args.piPackageDir, "package.json")).href;
registerHooks({
	resolve(specifier, context, next) {
		try {
			return next(specifier, context);
		} catch (error) {
			if (/^(\.|\/|node:|file:)/.test(specifier)) throw error;
			return next(specifier, { ...context, parentURL: piParent });
		}
	},
});

const log = (text: string) => console.log(`${new Date().toISOString()} ${text}`);

async function main(): Promise<void> {
	const release = await acquireDreamLock(args.dir);
	if (!release) {
		log("another dream holds the lock; exiting");
		return;
	}
	const status: DreamStatus = { state: "running", pid: process.pid, trigger: args.trigger, startedAt: Date.now() };
	const controller = new AbortController();
	const stop = (signal: string) => {
		log(`${signal}: stopping`);
		controller.abort();
	};
	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGINT", () => stop("SIGINT"));
	// Closing the terminal of the Pi that started us must not stop the dream.
	process.on("SIGHUP", () => {});
	try {
		await writeDreamStatus(args.dir, status);
		log(`dream started (${args.trigger}) for ${args.dir}`);
		const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
		const { createDreamAgents } = await import("./dream-agent.ts");
		const runtime = await ModelRuntime.create({ authPath: join(args.agentDir, "auth.json"), modelsPath: join(args.agentDir, "models.json") });
		const flash = runtime.getModel(args.provider, args.model);
		const unavailable = !flash
			? `Pi has no ${args.provider}/${args.model} model`
			: !runtime.getProviderAuthStatus(args.provider).configured
				? "DeepSeek is not logged in"
				: undefined;
		const agents = createDreamAgents({
			agentDir: args.agentDir,
			notes: args.notes,
			dreamsDir: join(args.dir, "dreams"),
			model: flash,
			unavailable,
		});
		const since = (await readConfig(args.dir)).lastDreamAt ?? 0;
		const result = await dream({
			dir: args.dir,
			notes: args.notes,
			sessionDir: args.sessionDir,
			session: args.session,
			since,
			agents,
			signal: controller.signal,
		});
		if (result.readUntil !== undefined && result.readUntil > since) {
			await writeConfig(args.dir, { ...(await readConfig(args.dir)), lastDreamAt: result.readUntil });
		}
		const summary = summarize(result);
		log(summary);
		await writeDreamStatus(args.dir, { ...status, state: result.status, finishedAt: Date.now(), summary });
	} catch (error) {
		log(`failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		const summary = failureSummary(error instanceof Error ? error.message : String(error));
		await writeDreamStatus(args.dir, { ...status, state: "error", finishedAt: Date.now(), summary }).catch(() => {});
	} finally {
		await release();
	}
}

await main();
process.exit(0);
