// @ts-nocheck -- Pi's jiti runtime provides these dependencies; this config repository has no local type graph.

import type {
	ResolvedResource,
	SourceInfo,
} from "@earendil-works/pi-coding-agent";

export type ResourceTab =
	| "overview"
	| "tools"
	| "skills"
	| "contexts"
	| "extensions";

export interface ResourceSettings {
	version: 1;
	disabledTools: string[];
	disabledSkills: string[];
	disabledContexts: string[];
}

export interface SessionResourceState {
	version: 1;
	tools?: string[];
	enabledSkills: string[];
	disabledSkills: string[];
	enabledContexts: string[];
	disabledContexts: string[];
}

export interface ToolRecord {
	name: string;
	description: string;
	sourceInfo?: SourceInfo;
}

export interface SkillRecord {
	name: string;
	description: string;
	path: string;
}

export interface ContextRecord {
	path: string;
	content: string;
}

export interface RuntimeLayer {
	id: string;
	disableTools: string[];
	requireTools: string[];
}

export interface ManagerSnapshot {
	ready: boolean;
	contextsKnown: boolean;
	extensionsKnown: boolean;
	tools: ToolRecord[];
	activeTools: Set<string>;
	skills: SkillRecord[];
	enabledSkills: Set<string>;
	contexts: ContextRecord[];
	enabledContexts: Set<string>;
	extensions: ResolvedResource[];
	presetName?: string;
}

export interface ExtensionChange {
	resource: ResolvedResource;
	enabled: boolean;
}

export const DEFAULT_RESOURCE_SETTINGS: ResourceSettings = {
	version: 1,
	disabledTools: [],
	disabledSkills: [],
	disabledContexts: [],
};

export const DEFAULT_SESSION_STATE: SessionResourceState = {
	version: 1,
	enabledSkills: [],
	disabledSkills: [],
	enabledContexts: [],
	disabledContexts: [],
};
