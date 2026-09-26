import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";

// The global on/off switch, `"subagents": { "enabled": false }` in
// <agent dir>/settings.json. Absent means on. Pi keeps keys it does not know
// when it saves its own settings, and the extension reads the file once per
// load, so a change takes effect on the reload /subagent on|off performs.

export function settingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

export function subagentsEnabled(file = settingsPath()): boolean {
	try {
		const settings = JSON.parse(fs.readFileSync(file, "utf8"));
		return settings?.subagents?.enabled !== false;
	} catch {
		return true;
	}
}

/** Sets the switch, keeping every other setting. Refuses to rewrite a file it cannot parse. */
export function setSubagentsEnabled(enabled: boolean, file = settingsPath()): void {
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot update ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const current = settings.subagents && typeof settings.subagents === "object" ? settings.subagents : {};
	settings.subagents = { ...current, enabled };
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	fs.renameSync(temporary, file);
}

/**
 * /subagent on|off: writes the switch and reloads, so the extension starts over
 * with its tools, prompts, panel, and notices present or absent.
 */
export async function toggleSubagents(enabled: boolean, ctx: ExtensionCommandContext, running = 0): Promise<void> {
	if (subagentsEnabled() === enabled) {
		ctx.ui.notify(`Subagents are already ${enabled ? "on" : "off"}.`, "info");
		return;
	}
	if (!enabled && running > 0 && ctx.hasUI) {
		const ok = await ctx.ui.confirm(
			"Turn subagents off?",
			`${running} subagent${running === 1 ? " is" : "s are"} running. Turning subagents off stops ${running === 1 ? "it" : "them"}.`,
		);
		if (!ok) return;
	}
	try {
		setSubagentsEnabled(enabled);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}
	ctx.ui.notify(`Subagents ${enabled ? "on" : "off"}; reloading.`, "info");
	await ctx.reload();
}
