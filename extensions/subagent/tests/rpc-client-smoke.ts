import assert from "node:assert/strict";
import { getPiInvocation } from "../rpc-client.ts";

const args = ["--mode", "rpc", "--no-session"];
const missingScript = "/definitely/not/a/real/pi-entry.ts";

assert.deepEqual(
	getPiInvocation(args, {
		currentScript: missingScript,
		execPath: "node",
		existsSync: () => false,
	}),
	{ command: "pi", args },
	"a missing argv[1] must use the generic runtime fallback",
);

assert.deepEqual(
	getPiInvocation(args, {
		currentScript: missingScript,
		execPath: "pi-standalone",
		existsSync: () => false,
	}),
	{ command: "pi-standalone", args },
	"a missing argv[1] must use the standalone binary fallback",
);

assert.deepEqual(
	getPiInvocation(args, {
		currentScript: "/$bunfs/root/pi.ts",
		execPath: "bun",
		existsSync: () => true,
	}),
	{ command: "pi", args },
	"a Bun virtual argv[1] must not be reused as a script entry",
);

assert.deepEqual(
	getPiInvocation(args, {
		currentScript: "/real/pi-entry.ts",
		execPath: "node",
		existsSync: () => true,
	}),
	{ command: "node", args: ["/real/pi-entry.ts", ...args] },
	"an existing non-virtual argv[1] remains the preferred entry",
);

process.stdout.write("4 deterministic Pi invocation smoke tests passed\n");
