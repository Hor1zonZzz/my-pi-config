// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type AgentExtensionMode = "default" | "isolated";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	extensionMode: AgentExtensionMode;
	extensionSources: string[];
	extensionConfigError?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function resolveExtensionSource(source: string, agentFilePath: string): string {
	if (
		source.startsWith("./") ||
		source.startsWith("../") ||
		path.isAbsolute(source)
	) {
		return path.resolve(path.dirname(agentFilePath), source);
	}
	return source;
}

function parseExtensionConfig(value: unknown): {
	mode: AgentExtensionMode;
	sources: string[];
	error?: string;
} {
	if (value === undefined) return { mode: "default", sources: [] };
	if (value === "none") return { mode: "isolated", sources: [] };
	if (
		Array.isArray(value) &&
		value.every((source) => typeof source === "string" && source.trim())
	) {
		return { mode: "isolated", sources: value.map((source) => source.trim()) };
	}
	return {
		mode: "isolated",
		sources: [],
		error:
			'Invalid "extensions" configuration. Use "none" or a YAML array of non-empty strings.',
	};
}

function loadAgentsFromDir(
	dir: string,
	source: "user" | "project",
): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } =
			parseFrontmatter<Record<string, unknown>>(content);

		if (
			typeof frontmatter.name !== "string" ||
			typeof frontmatter.description !== "string"
		) {
			continue;
		}

		const tools =
			typeof frontmatter.tools === "string"
				? frontmatter.tools
						.split(",")
						.map((tool) => tool.trim())
						.filter(Boolean)
				: undefined;
		const extensionConfig = parseExtensionConfig(frontmatter.extensions);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model:
				typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			extensionMode: extensionConfig.mode,
			extensionSources: extensionConfig.sources.map((extensionSource) =>
				resolveExtensionSource(extensionSource, filePath),
			),
			extensionConfigError: extensionConfig.error,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(
	cwd: string,
	scope: AgentScope,
): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents =
		scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents =
		scope === "user" || !projectAgentsDir
			? []
			: loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(
	agents: AgentConfig[],
	maxItems: number,
): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed
			.map((a) => `${a.name} (${a.source}): ${a.description}`)
			.join("; "),
		remaining,
	};
}
