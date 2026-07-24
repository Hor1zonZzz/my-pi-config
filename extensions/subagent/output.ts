// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

export const SUBAGENT_OUTPUT_CAP_BYTES = 50 * 1024;
export const SUBAGENT_OUTPUT_CAP_LINES = 2000;

export function truncateSubagentOutput(
	output: string,
	resultPath?: string,
): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	const lines = output.split("\n");
	if (
		byteLength <= SUBAGENT_OUTPUT_CAP_BYTES &&
		lines.length <= SUBAGENT_OUTPUT_CAP_LINES
	) {
		return output;
	}

	const location = resultPath
		? ` Read the complete result at ${resultPath}.`
		: "";
	const notice = `\n\n[Output truncated from ${byteLength} bytes and ${lines.length} lines.${location}]`;
	const contentBudget = Math.max(
		0,
		SUBAGENT_OUTPUT_CAP_BYTES - Buffer.byteLength(notice, "utf8"),
	);
	let truncated = lines.slice(0, SUBAGENT_OUTPUT_CAP_LINES - 2).join("\n");
	while (Buffer.byteLength(truncated, "utf8") > contentBudget) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}${notice}`;
}
