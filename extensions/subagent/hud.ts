// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { PersistentJobSnapshot } from "./persistent-jobs.ts";

const PERSISTENT_WIDGET_ID = "subagent-persistent-jobs";
const PERSISTENT_STATUS_ID = "subagent-persistent-status";

export function renderPersistentHud(
	ctx: ExtensionContext | undefined,
	getJobs: () => PersistentJobSnapshot[],
): void {
	if (!ctx || ctx.mode !== "tui") return;
	const jobs = getJobs();
	if (jobs.length === 0) {
		ctx.ui.setStatus(PERSISTENT_STATUS_ID, undefined);
		ctx.ui.setWidget(PERSISTENT_WIDGET_ID, undefined);
		return;
	}

	const active = jobs.filter(
		(job) =>
			job.status === "starting" ||
			job.status === "running" ||
			job.status === "idle" ||
			job.status === "stopping",
	).length;
	ctx.ui.setStatus(
		PERSISTENT_STATUS_ID,
		ctx.ui.theme.fg(
			active > 0 ? "accent" : "muted",
			`persistent subagents ${active}/${jobs.length} live`,
		),
	);
	ctx.ui.setWidget(PERSISTENT_WIDGET_ID, (_tui, theme) => ({
		render(width: number): string[] {
			if (width <= 0) return [];
			const current = getJobs();
			const header =
				theme.fg("accent", theme.bold("Persistent subagents")) +
				theme.fg("muted", ` · ${current.length} session job(s)`);
			const lines = [truncateToWidth(header, width)];
			for (const job of current) {
				let icon = theme.fg("warning", "⏳");
				let status = theme.fg("warning", job.status);
				if (job.status === "idle") {
					icon = theme.fg("success", "✓");
					status = theme.fg("success", job.status);
				} else if (job.status === "failed") {
					icon = theme.fg("error", "✗");
					status = theme.fg("error", job.status);
				} else if (job.status === "stopped") {
					icon = theme.fg("muted", "■");
					status = theme.fg("muted", job.status);
				}
				const task = job.task.replace(/\s+/g, " ").trim() || "(no task)";
				const line =
					`${icon} ${theme.fg("accent", job.id)} ` +
					`${theme.fg("toolTitle", job.agent)} ${status} ` +
					`${theme.fg("dim", "—")} ${theme.fg("text", task)}`;
				lines.push(truncateToWidth(line, width));
			}
			return lines;
		},
		invalidate(): void {},
	}));
}

export function clearPersistentHud(ctx: ExtensionContext | undefined): void {
	if (!ctx || ctx.mode !== "tui") return;
	ctx.ui.setStatus(PERSISTENT_STATUS_ID, undefined);
	ctx.ui.setWidget(PERSISTENT_WIDGET_ID, undefined);
}
