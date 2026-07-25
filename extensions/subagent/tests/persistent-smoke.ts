import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	MAX_TERMINAL_JOB_HISTORY,
	PersistentJobManager,
} from "../persistent-jobs.ts";
import { RpcProcessClient } from "../rpc-client.ts";
import { ProcessScheduler } from "../scheduler.ts";
import {
	SUBAGENT_OUTPUT_CAP_BYTES,
	SUBAGENT_OUTPUT_CAP_LINES,
	truncateSubagentOutput,
} from "../output.ts";

const fakeChild = fileURLToPath(
	new URL("./fake-rpc-child.mjs", import.meta.url),
);
const cwd = process.cwd();

const baseAgent = {
	name: "fake",
	description: "deterministic fake",
	extensionMode: "isolated" as const,
	extensionSources: [],
	systemPrompt: "",
	source: "user" as const,
	filePath: fakeChild,
};

function createHarness(
	scenarios: string[],
	overrides: Record<string, unknown> = {},
) {
	const completions: Array<{
		jobId: string;
		generation: number;
		status: string;
		output: string;
	}> = [];
	let clientIndex = 0;
	let clientCreations = 0;
	const suppliedCreateClient = overrides.createClient as
		| ((options: Record<string, unknown>) => unknown)
		| undefined;
	const manager = new PersistentJobManager({
		onChanged: () => {},
		onCompletion: (completion) => completions.push(completion),
		...overrides,
		createClient: (options) => {
			clientCreations += 1;
			if (suppliedCreateClient) return suppliedCreateClient(options);
			return new RpcProcessClient({
				...options,
				invocation: {
					command: process.execPath,
					args: [
						fakeChild,
						scenarios[clientIndex++] ?? scenarios.at(-1) ?? "normal",
					],
				},
			});
		},
	});
	const scheduler = new ProcessScheduler({
		maxConcurrentProcesses: Math.max(1, scenarios.length),
		maxQueuedProcesses: 4,
	});
	return {
		manager,
		scheduler,
		completions,
		get clientCreations() {
			return clientCreations;
		},
	};
}

function request(task: string, systemPrompt = "") {
	return {
		agent: { ...baseAgent, systemPrompt },
		task,
		defaultCwd: cwd,
	};
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Timed out: ${label}`)),
					2_000,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function waitUntil(
	predicate: () => boolean,
	label: string,
): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function testStopBeforeClient(): Promise<void> {
	let enterBarrier!: () => void;
	let releaseBarrier!: () => void;
	const entered = new Promise<void>((resolve) => (enterBarrier = resolve));
	const barrier = new Promise<void>((resolve) => (releaseBarrier = resolve));
	const harness = createHarness(["hang-ack"], {
		beforeClientCreate: async () => {
			enterBarrier();
			await barrier;
		},
	});
	const { manager, scheduler } = harness;
	const starting = manager.startMany(
		[request("stop-before-client", "secure prompt file")],
		scheduler.reserveImmediate(1),
	);
	await withTimeout(entered, "stop barrier entered");
	const pending = manager.list()[0];
	assert.equal(pending.status, "starting");
	await withTimeout(manager.stop(pending.id), "stop before client");
	releaseBarrier();
	await assert.rejects(withTimeout(starting, "cancelled startup"));
	assert.equal(harness.clientCreations, 0, "client must never be constructed");
	assert.equal(manager.get(pending.id).status, "stopped");
	assert.equal(manager.activeCount, 0);
	assert.equal(scheduler.runningCount, 0);
	await manager.shutdown();
}

async function testShutdownBeforeClient(): Promise<void> {
	let enterBarrier!: () => void;
	let releaseBarrier!: () => void;
	const entered = new Promise<void>((resolve) => (enterBarrier = resolve));
	const barrier = new Promise<void>((resolve) => (releaseBarrier = resolve));
	const harness = createHarness(["hang-ack"], {
		beforeClientCreate: async () => {
			enterBarrier();
			await barrier;
		},
	});
	const { manager, scheduler } = harness;
	const starting = manager.startMany(
		[request("shutdown-before-client", "secure prompt file")],
		scheduler.reserveImmediate(1),
	);
	await withTimeout(entered, "shutdown barrier entered");
	await withTimeout(manager.shutdown(), "shutdown before client");
	releaseBarrier();
	await assert.rejects(withTimeout(starting, "shutdown-cancelled startup"));
	assert.equal(harness.clientCreations, 0, "client must never be constructed");
	assert.equal(manager.activeCount, 0);
	assert.equal(scheduler.runningCount, 0);
}

async function testAbortParallelStartup(): Promise<void> {
	const { manager, scheduler, completions } = createHarness([
		"hang-ack",
		"hang-ack",
	]);
	const controller = new AbortController();
	const starting = manager.startMany(
		[request("abort-a"), request("abort-b")],
		scheduler.reserveImmediate(2),
		undefined,
		controller.signal,
	);
	setTimeout(() => controller.abort(), 10);
	await assert.rejects(withTimeout(starting, "aborted parallel startup"), {
		name: "AbortError",
	});
	assert.equal(completions.length, 0);
	assert.equal(manager.activeCount, 0);
	assert.equal(scheduler.runningCount, 0);
	await manager.shutdown();
}

async function testSettledThenSendUsesPrompt(): Promise<void> {
	const { manager, scheduler, completions } = createHarness(["normal"]);
	const [started] = await manager.startMany(
		[request("initial")],
		scheduler.reserveImmediate(1),
	);
	await waitUntil(
		() => manager.get(started.id).status === "idle",
		"initial idle",
	);
	const sent = await manager.send(started.id, "second-round", "steer");
	assert.equal(sent.generation, 2);
	await waitUntil(
		() => manager.get(started.id).settledGeneration === 2,
		"second generation settlement",
	);
	const read = manager.get(started.id, true);
	assert.match(read.output, /completed:second-round/);
	assert.deepEqual(
		completions.map((completion) => completion.generation),
		[1, 2],
	);
	await manager.shutdown();
}

async function testAcceptedSteerAfterSettlementIsWoken(): Promise<void> {
	const { manager, scheduler, completions } = createHarness([
		"settle-during-steer",
	]);
	const [started] = await manager.startMany(
		[request("steer-race")],
		scheduler.reserveImmediate(1),
	);
	assert.equal(started.status, "running");
	const sent = await manager.send(started.id, "queued-race-message", "steer");
	assert.equal(sent.generation, 2);
	await waitUntil(
		() => manager.get(started.id).settledGeneration === 2,
		"accepted steer wake settlement",
	);
	assert.match(
		manager.get(started.id, true).output,
		/Continue now and process the steering or follow-up instruction/,
	);
	assert.deepEqual(
		completions.map((completion) => completion.generation),
		[1, 2],
	);
	await manager.shutdown();
}

async function testIdleClose(): Promise<void> {
	const { manager, scheduler, completions } = createHarness(["idle-close"]);
	const [started] = await manager.startMany(
		[request("idle-close")],
		scheduler.reserveImmediate(1),
	);
	await waitUntil(
		() => manager.get(started.id).status === "failed",
		"idle close failure",
	);
	assert.equal(manager.activeCount, 0);
	const failures = completions.filter(
		(completion) => completion.status === "failed",
	);
	assert.equal(
		failures.length,
		1,
		"unexpected exit must report failure exactly once",
	);
	assert.match(failures[0].output, /exited unexpectedly/);
	await manager.shutdown();
}

async function testRunningCloseWakesWaiter(): Promise<void> {
	const { manager, scheduler, completions } = createHarness(["running-close"]);
	const [started] = await manager.startMany(
		[request("running-close")],
		scheduler.reserveImmediate(1),
	);
	const waited = await withTimeout(
		manager.wait(started.id, 0),
		"unexpected close waiter",
	);
	assert.equal(waited.status, "failed");
	assert.match(waited.output, /exited unexpectedly/);
	assert.equal(
		completions.filter((completion) => completion.status === "failed").length,
		0,
		"the joined failure is returned by wait instead of being pushed twice",
	);
	assert.equal(manager.activeCount, 0);
	await manager.shutdown();
}

async function testAgentFailureReportsOnce(): Promise<void> {
	const { manager, scheduler, completions } = createHarness(["agent-fail"]);
	const [started] = await manager.startMany(
		[request("agent-fail")],
		scheduler.reserveImmediate(1),
	);
	await waitUntil(
		() => manager.get(started.id).status === "failed",
		"agent failure",
	);
	await waitUntil(() => manager.liveCount === 0, "failed process exit");
	assert.equal(
		completions.filter((completion) => completion.status === "failed").length,
		1,
	);
	await manager.shutdown();
}

async function testSettledBeforeAckBarrier(): Promise<void> {
	const { manager, scheduler, completions } = createHarness([
		"settle-before-ack",
	]);
	const [started] = await manager.startMany(
		[request("settled-before-ack")],
		scheduler.reserveImmediate(1),
	);
	assert.equal(started.status, "idle");
	assert.equal(started.settledGeneration, 1);
	assert.equal(completions.length, 1);
	assert.equal(completions[0].generation, 1);
	await manager.shutdown();
}

async function testParallelPartialFailureIsAtomic(): Promise<void> {
	const { manager, scheduler, completions } = createHarness([
		"normal",
		"reject",
	]);
	await assert.rejects(
		manager.startMany(
			[request("parallel-ok"), request("parallel-fail")],
			scheduler.reserveImmediate(2),
		),
		/Failed to start persistent subagent job/,
	);
	assert.equal(
		completions.length,
		0,
		"failed ACK barrier must not auto-report",
	);
	assert.equal(manager.activeCount, 0);
	assert.equal(scheduler.runningCount, 0);
	assert.ok(
		manager
			.list()
			.every((job) => job.status === "stopped" || job.status === "failed"),
	);
	await manager.shutdown();
}

async function testWaitTimeoutAbortAndDedup(): Promise<void> {
	const { manager, scheduler, completions } = createHarness(["delayed"]);
	const [started] = await manager.startMany(
		[request("wait-timeout")],
		scheduler.reserveImmediate(1),
	);
	await assert.rejects(manager.wait(started.id, 5), /Timed out waiting/);
	await waitUntil(
		() => manager.get(started.id).status === "idle",
		"post-timeout idle",
	);
	assert.equal(completions.length, 1);

	await manager.send(started.id, "wait-abort", "followUp");
	const controller = new AbortController();
	const abortedWait = manager.wait(started.id, 0, controller.signal);
	setTimeout(() => controller.abort(), 5);
	await assert.rejects(abortedWait, /Stopped waiting/);
	await waitUntil(
		() => manager.get(started.id).settledGeneration === 2,
		"post-abort settlement",
	);
	assert.equal(completions.length, 2);

	await manager.send(started.id, "joined", "steer");
	const joined = await manager.wait(started.id, 1_000);
	assert.equal(joined.settledGeneration, 3);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(
		completions.length,
		2,
		"a successful waiter suppresses only its joined generation and never duplicates",
	);
	const keys = completions.map(
		(completion) =>
			`${completion.jobId}:${completion.generation}:${completion.status}`,
	);
	assert.equal(new Set(keys).size, keys.length);
	await manager.shutdown();
}

async function testExtensionUiCancellation(): Promise<void> {
	const { manager, scheduler } = createHarness(["ui"]);
	const [started] = await withTimeout(
		manager.startMany([request("ui")], scheduler.reserveImmediate(1)),
		"extension UI cancellation",
	);
	await waitUntil(
		() => manager.get(started.id).status === "idle",
		"UI job idle",
	);
	await manager.shutdown();
}

async function testMalformedJsonlFailsJob(): Promise<void> {
	const { manager, scheduler, completions } = createHarness(["malformed"]);
	await assert.rejects(
		manager.startMany([request("malformed")], scheduler.reserveImmediate(1)),
		/RPC protocol error/i,
	);
	const failed = manager.list(true)[0];
	assert.equal(failed.status, "failed");
	assert.match(failed.stderr, /protocol error.*malformed JSONL/i);
	assert.equal(
		completions.filter((completion) => completion.status === "failed").length,
		0,
		"a startup protocol failure is returned by the start call, not pushed",
	);
	await manager.shutdown();
}

async function testHandledWithoutAgentRun(): Promise<void> {
	const { manager, scheduler, completions } = createHarness(["no-agent"]);
	const [started] = await withTimeout(
		manager.startMany([request("/fast on")], scheduler.reserveImmediate(1)),
		"handled prompt activity handshake",
	);
	assert.equal(started.status, "idle");
	assert.equal(started.settledGeneration, 1);
	assert.equal(manager.busyCount, 0);
	assert.equal(manager.activeCount, 0);
	assert.equal(manager.liveCount, 1, "the reusable idle child remains live");
	assert.equal((await manager.wait(started.id, 50)).status, "idle");
	assert.equal(completions.length, 0, "handled prompts must not forge output");

	const sent = await manager.send(started.id, "/fast off", "steer");
	assert.equal(sent.status, "idle");
	assert.equal(sent.settledGeneration, 2);
	assert.equal(manager.busyCount, 0);
	assert.equal(completions.length, 0);
	await manager.shutdown();
	assert.equal(scheduler.runningCount, 0);
}

async function testMalformedEventShapes(): Promise<void> {
	for (const scenario of [
		"invalid-response",
		"invalid-agent-start",
		"invalid-message",
		"invalid-ui",
	]) {
		const { manager, scheduler } = createHarness([scenario]);
		await manager
			.startMany([request(scenario)], scheduler.reserveImmediate(1))
			.catch(() => undefined);
		await waitUntil(
			() => manager.list()[0]?.status === "failed",
			`${scenario} protocol failure`,
		);
		assert.match(manager.list(true)[0].stderr, /RPC protocol error/i);
		await manager.shutdown();
	}
}

async function testEventCallbackFailureIsContained(): Promise<void> {
	const client = new RpcProcessClient({
		args: [],
		cwd,
		onEvent: () => {
			throw new Error("deterministic callback failure");
		},
		invocation: {
			command: process.execPath,
			args: [fakeChild, "callback-exit"],
		},
	});
	await client.send({ type: "prompt", message: "callback-failure" });
	const exit = await withTimeout(
		client.exited,
		"callback protocol failure exit",
	);
	assert.match(exit.error?.message ?? "", /event callback failed/i);
}

async function testSystemPromptTempFileCleanup(): Promise<void> {
	const prompt = "private deterministic system prompt";
	let promptPath = "";
	const harness = createHarness(["normal"], {
		createClient: (options: Record<string, unknown>) => {
			const args = options.args as string[];
			const flag = args.indexOf("--append-system-prompt");
			assert.ok(flag >= 0, "system prompt must use the file flag");
			promptPath = args[flag + 1];
			assert.notEqual(
				promptPath,
				prompt,
				"full prompt must not appear in argv",
			);
			return new RpcProcessClient({
				...options,
				invocation: {
					command: process.execPath,
					args: [fakeChild, "normal"],
				},
			});
		},
	});
	const [started] = await harness.manager.startMany(
		[request("prompt-file", prompt)],
		harness.scheduler.reserveImmediate(1),
	);
	assert.equal(await readFile(promptPath, "utf8"), prompt);
	if (process.platform !== "win32") {
		assert.equal((await stat(promptPath)).mode & 0o777, 0o600);
	} else {
		await stat(promptPath);
	}
	const promptDirectory = dirname(promptPath);
	await harness.manager.stop(started.id);
	await assert.rejects(access(promptPath));
	await assert.rejects(access(promptDirectory));
	assert.equal(harness.scheduler.runningCount, 0);
	await harness.manager.shutdown();
}

function createImmediateClient(options: Record<string, unknown>) {
	let exited = false;
	let issuedGeneration = 0;
	let startedGeneration = 0;
	let settledGeneration = 0;
	let resolveExit!: (value: {
		code: number | null;
		signal: NodeJS.Signals | null;
	}) => void;
	const exitPromise = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve) => (resolveExit = resolve));
	const onEvent = options.onEvent as (event: Record<string, unknown>) => void;
	return {
		exited: exitPromise,
		get isExited() {
			return exited;
		},
		getRunState() {
			return {
				running: startedGeneration > settledGeneration,
				issuedGeneration,
				startedGeneration,
				settledGeneration,
			};
		},
		async waitForGenerationActivity(generation: number) {
			return { kind: "settled" as const, generation };
		},
		async send(command: Record<string, unknown>) {
			if (command.type === "prompt") {
				issuedGeneration += 1;
				startedGeneration = issuedGeneration;
				onEvent({ type: "agent_start" });
				onEvent({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						stopReason: "stop",
					},
				});
				settledGeneration = issuedGeneration;
				onEvent({ type: "agent_settled" });
			}
			return { type: "response", command: command.type, success: true };
		},
		async terminate() {
			if (exited) return;
			exited = true;
			resolveExit({ code: 0, signal: null });
		},
	};
}

async function testTerminalJobRetention(): Promise<void> {
	const harness = createHarness(["normal", "normal"], {
		createClient: createImmediateClient,
	});
	const [idleKeeper] = await harness.manager.startMany(
		[request("retention-active-keeper")],
		harness.scheduler.reserveImmediate(1),
	);
	const createdIds: string[] = [];
	for (let index = 0; index < MAX_TERMINAL_JOB_HISTORY + 3; index += 1) {
		const [started] = await harness.manager.startMany(
			[request(`retention-${index}`)],
			harness.scheduler.reserveImmediate(1),
		);
		createdIds.push(started.id);
		await harness.manager.stop(started.id);
	}
	const retained = harness.manager.list();
	assert.equal(retained.length, MAX_TERMINAL_JOB_HISTORY + 1);
	assert.equal(
		retained.filter((job) => job.status === "stopped").length,
		MAX_TERMINAL_JOB_HISTORY,
	);
	assert.equal(harness.manager.get(idleKeeper.id).status, "idle");
	assert.deepEqual(
		retained.filter((job) => job.status === "stopped").map((job) => job.id),
		createdIds.slice(-MAX_TERMINAL_JOB_HISTORY),
	);
	assert.throws(() => harness.manager.get(createdIds[0]), /Unknown persistent/);
	await harness.manager.stop(idleKeeper.id);
	assert.equal(harness.scheduler.runningCount, 0);
	await harness.manager.shutdown();
}

function testWholeMessageTruncation(): void {
	const value = `Task: ${"元".repeat(30_000)}\n${"line\n".repeat(3_000)}`;
	const truncated = truncateSubagentOutput(value);
	assert.ok(Buffer.byteLength(truncated, "utf8") <= SUBAGENT_OUTPUT_CAP_BYTES);
	assert.ok(truncated.split("\n").length <= SUBAGENT_OUTPUT_CAP_LINES);
	assert.match(truncated, /Output truncated/);
}

const tests: Array<[string, () => Promise<void> | void]> = [
	["stop-before-client", testStopBeforeClient],
	["shutdown-before-client", testShutdownBeforeClient],
	["parallel startup abort", testAbortParallelStartup],
	["settled-to-send", testSettledThenSendUsesPrompt],
	["accepted steer settlement race", testAcceptedSteerAfterSettlementIsWoken],
	["idle-close", testIdleClose],
	["running-close waiter", testRunningCloseWakesWaiter],
	["agent failure dedup", testAgentFailureReportsOnce],
	["ACK/settled ordering", testSettledBeforeAckBarrier],
	["parallel partial failure", testParallelPartialFailureIsAtomic],
	["wait timeout/abort dedup", testWaitTimeoutAbortAndDedup],
	["extension UI cancellation", testExtensionUiCancellation],
	["malformed JSONL", testMalformedJsonlFailsJob],
	["handled prompt without agent run", testHandledWithoutAgentRun],
	["malformed event shapes", testMalformedEventShapes],
	["event callback containment", testEventCallbackFailureIsContained],
	["system prompt temp-file cleanup", testSystemPromptTempFileCleanup],
	["terminal job retention", testTerminalJobRetention],
	["whole-message truncation", testWholeMessageTruncation],
];

for (const [name, test] of tests) {
	await test();
	process.stdout.write(`ok - ${name}\n`);
}
process.stdout.write(
	`${tests.length} deterministic persistent subagent smoke tests passed\n`,
);
