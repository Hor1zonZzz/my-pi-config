import assert from "node:assert/strict";
import { ProcessScheduler } from "../scheduler.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitUntil(
	predicate: () => boolean,
	label: string,
): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

async function testPersistentSaturationFailsFastAndRecovers(): Promise<void> {
	const scheduler = new ProcessScheduler({
		maxConcurrentProcesses: 2,
		maxQueuedProcesses: 4,
	});
	const firstGate = deferred();
	const secondGate = deferred();
	const persistent = scheduler.reserveImmediate(2);
	const first = persistent.run(undefined, async () => firstGate.promise);
	const second = persistent.run(undefined, async () => secondGate.promise);
	persistent.release();

	assert.equal(scheduler.runningCount, 2);
	assert.throws(
		() => scheduler.reserve(1),
		/persistent RPC job.*stop a persistent job/i,
		"ordinary work must fail immediately instead of queueing behind all-sticky occupancy",
	);
	assert.equal(scheduler.queuedCount, 0);

	firstGate.resolve();
	await first;
	assert.equal(scheduler.runningCount, 1);
	const ordinary = scheduler.reserve(1);
	assert.equal(
		await ordinary.run(undefined, async () => "ordinary-ran"),
		"ordinary-ran",
	);
	ordinary.release();

	secondGate.resolve();
	await second;
	assert.equal(scheduler.runningCount, 0);
}

async function testPersistentReservationReleaseAndErrorAccounting(): Promise<void> {
	const scheduler = new ProcessScheduler({
		maxConcurrentProcesses: 1,
		maxQueuedProcesses: 1,
	});
	const unusedPersistent = scheduler.reserveImmediate(1);
	assert.throws(() => scheduler.reserve(1), /persistent RPC job/i);
	unusedPersistent.release();

	const failingPersistent = scheduler.reserveImmediate(1);
	await assert.rejects(
		failingPersistent.run(undefined, async () => {
			throw new Error("persistent failed");
		}),
		/persistent failed/,
	);
	failingPersistent.release();

	const ordinary = scheduler.reserve(1);
	assert.equal(await ordinary.run(undefined, async () => 42), 42);
	ordinary.release();
	assert.equal(scheduler.runningCount, 0);
}

async function testOrdinaryFifoAndPersistentNoBypass(): Promise<void> {
	const scheduler = new ProcessScheduler({
		maxConcurrentProcesses: 1,
		maxQueuedProcesses: 2,
	});
	const firstGate = deferred();
	const secondGate = deferred();
	const order: string[] = [];
	const ordinary = scheduler.reserve(3);
	const first = ordinary.run(undefined, async () => {
		order.push("first");
		await firstGate.promise;
	});
	const second = ordinary.run(undefined, async () => {
		order.push("second");
		await secondGate.promise;
	});
	const third = ordinary.run(undefined, async () => {
		order.push("third");
	});
	ordinary.release();

	assert.deepEqual(order, ["first"]);
	assert.equal(scheduler.queuedCount, 2);
	assert.throws(
		() => scheduler.reserveImmediate(1),
		/cannot bypass the existing FIFO queue/i,
	);

	firstGate.resolve();
	await first;
	await waitUntil(() => order.length === 2, "second FIFO task");
	assert.deepEqual(order, ["first", "second"]);
	secondGate.resolve();
	await second;
	await third;
	assert.deepEqual(order, ["first", "second", "third"]);
	assert.equal(scheduler.queuedCount, 0);
}

async function testImmediateReservationProtectsItsSlot(): Promise<void> {
	const scheduler = new ProcessScheduler({
		maxConcurrentProcesses: 2,
		maxQueuedProcesses: 2,
	});
	const persistentGate = deferred();
	const firstOrdinaryGate = deferred();
	const persistent = scheduler.reserveImmediate(1);
	const ordinary = scheduler.reserve(2);
	const order: string[] = [];
	const firstOrdinary = ordinary.run(undefined, async () => {
		order.push("ordinary-1");
		await firstOrdinaryGate.promise;
	});
	const secondOrdinary = ordinary.run(undefined, async () => {
		order.push("ordinary-2");
	});
	ordinary.release();

	assert.equal(scheduler.runningCount, 1);
	assert.equal(scheduler.queuedCount, 1);
	const persistentRun = persistent.run(undefined, async () => {
		order.push("persistent");
		await persistentGate.promise;
	});
	persistent.release();
	assert.deepEqual(order, ["ordinary-1", "persistent"]);

	firstOrdinaryGate.resolve();
	await firstOrdinary;
	await secondOrdinary;
	assert.deepEqual(order, ["ordinary-1", "persistent", "ordinary-2"]);
	persistentGate.resolve();
	await persistentRun;
}

const tests: Array<[string, () => Promise<void>]> = [
	[
		"persistent saturation fail-fast and recovery",
		testPersistentSaturationFailsFastAndRecovers,
	],
	[
		"persistent reservation release/error accounting",
		testPersistentReservationReleaseAndErrorAccounting,
	],
	[
		"ordinary FIFO and persistent no-bypass",
		testOrdinaryFifoAndPersistentNoBypass,
	],
	[
		"immediate reservation slot protection",
		testImmediateReservationProtectsItsSlot,
	],
];

for (const [name, test] of tests) {
	await test();
	process.stdout.write(`ok - ${name}\n`);
}
process.stdout.write(
	`${tests.length} deterministic scheduler smoke tests passed\n`,
);
