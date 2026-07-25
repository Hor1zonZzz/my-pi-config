// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

export const SUBAGENT_OUTPUT_CAP_BYTES = 50 * 1024;
export const SUBAGENT_OUTPUT_CAP_LINES = 2000;

function utf8Prefix(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}
	let end = low;
	if (
		end > 0 &&
		end < value.length &&
		/[\uD800-\uDBFF]/.test(value[end - 1]) &&
		/[\uDC00-\uDFFF]/.test(value[end])
	) {
		end -= 1;
	}
	return value.slice(0, end);
}

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

	const boundedPath = resultPath ? utf8Prefix(resultPath, 1_024) : undefined;
	const location = boundedPath
		? ` Read the complete result at ${boundedPath}.`
		: "";
	let notice = `\n\n[Output truncated from ${byteLength} bytes and ${lines.length} lines.${location}]`;
	notice = utf8Prefix(notice, SUBAGENT_OUTPUT_CAP_BYTES);
	const noticeLines = notice.split("\n").length - 1;
	const maxContentLines = Math.max(0, SUBAGENT_OUTPUT_CAP_LINES - noticeLines);
	const lineBounded = lines.slice(0, maxContentLines).join("\n");
	const contentBudget = Math.max(
		0,
		SUBAGENT_OUTPUT_CAP_BYTES - Buffer.byteLength(notice, "utf8"),
	);
	return `${utf8Prefix(lineBounded, contentBudget)}${notice}`;
}
