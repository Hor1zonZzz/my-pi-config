import { StringDecoder } from "node:string_decoder";

const scenario = process.argv[2] ?? "normal";
let sequence = 0;
let promptCount = 0;
let awaitingUi;

function send(record) {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

function respond(command, success = true, error) {
	send({
		id: command.id,
		type: "response",
		command: command.type,
		success,
		...(error ? { error } : {}),
	});
}

function complete(message, delay = 0) {
	const run = () => {
		sequence += 1;
		send({ type: "agent_start" });
		send({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `completed:${message}` }],
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: sequence * 2,
					cost: { total: 0 },
				},
				stopReason: "stop",
				model: "fake/model",
			},
		});
		send({ type: "agent_settled" });
	};
	if (delay > 0) setTimeout(run, delay);
	else run();
}

function handle(command) {
	if (command.type === "extension_ui_response") {
		if (
			awaitingUi &&
			command.id === awaitingUi.id &&
			command.cancelled === true
		) {
			const prompt = awaitingUi.command;
			awaitingUi = undefined;
			respond(prompt);
			complete(prompt.message, 5);
		}
		return;
	}
	if (command.type === "abort") {
		respond(command);
		setImmediate(() => process.exit(0));
		return;
	}
	if (command.type === "steer" || command.type === "follow_up") {
		if (scenario === "settle-during-steer") {
			send({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "completed:prior-running-turn" }],
					stopReason: "stop",
				},
			});
			send({ type: "agent_settled" });
			respond(command);
			return;
		}
		respond(command, false, "Agent is not streaming");
		return;
	}
	if (command.type !== "prompt") {
		respond(command);
		return;
	}
	promptCount += 1;

	switch (scenario) {
		case "settle-during-steer":
			respond(command);
			if (promptCount === 1) send({ type: "agent_start" });
			else complete(command.message, 5);
			return;
		case "hang-ack":
			return;
		case "reject":
			respond(command, false, "deterministic startup rejection");
			return;
		case "settle-before-ack":
			complete(command.message);
			respond(command);
			return;
		case "delayed":
			respond(command);
			setTimeout(() => {
				sequence += 1;
				send({ type: "agent_start" });
				setTimeout(() => {
					send({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: `completed:${command.message}` }],
							stopReason: "stop",
						},
					});
					send({ type: "agent_settled" });
				}, 70);
			}, 10);
			return;
		case "callback-exit":
			respond(command);
			complete(command.message, 5);
			setTimeout(() => process.exit(29), 25);
			return;
		case "idle-close":
			respond(command);
			complete(command.message, 5);
			setTimeout(() => process.exit(17), 25);
			return;
		case "running-close":
			respond(command);
			send({ type: "agent_start" });
			setTimeout(() => process.exit(19), 25);
			return;
		case "no-agent":
			respond(command);
			return;
		case "invalid-response":
			send({
				id: command.id,
				type: "response",
				command: "prompt",
				success: "yes",
			});
			return;
		case "invalid-agent-start":
			respond(command);
			send({ type: "agent_start", unexpected: true });
			return;
		case "invalid-message":
			respond(command);
			send({ type: "agent_start" });
			send({
				type: "message_end",
				message: { role: "assistant", content: "not-an-array" },
			});
			return;
		case "invalid-ui":
			respond(command);
			send({ type: "extension_ui_request", id: 42, method: "confirm" });
			return;
		case "agent-fail":
			respond(command);
			send({ type: "agent_start" });
			send({
				type: "message_end",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "deterministic agent failure",
				},
			});
			send({ type: "agent_settled" });
			setTimeout(() => process.exit(23), 5);
			return;
		case "malformed":
			respond(command);
			process.stdout.write("{malformed rpc jsonl\n");
			return;
		case "ui": {
			const id = `ui-${sequence + 1}`;
			awaitingUi = { id, command };
			send({
				type: "extension_ui_request",
				id,
				method: "confirm",
				title: "Unsafe interaction",
				message: "Headless client must cancel",
			});
			return;
		}
		default:
			respond(command);
			complete(command.message, 5);
	}
}

const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	while (true) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) break;
		const line = buffer.slice(0, newline).replace(/\r$/, "");
		buffer = buffer.slice(newline + 1);
		if (line) handle(JSON.parse(line));
	}
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
