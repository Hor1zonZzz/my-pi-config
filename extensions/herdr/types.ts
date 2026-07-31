export type HerdrAgentStatus =
	| "idle"
	| "working"
	| "blocked"
	| "done"
	| "unknown";

export interface HerdrAgentInfo {
	name?: string;
	agent?: string;
	display_agent?: string;
	agent_status: HerdrAgentStatus;
	state_change_seq?: number;
	revision?: number;
	workspace_id: string;
	tab_id: string;
	pane_id: string;
	focused: boolean;
	cwd?: string;
}

export interface HerdrAgentEnvelope {
	result?: { agent?: HerdrAgentInfo };
	error?: { code?: string; message?: string };
}

export type MonitorStatus =
	| "starting"
	| "working"
	| "completed"
	| "blocked"
	| "failed"
	| "cancelled";

export interface MonitorSubmission {
	taskId: string;
	toolCallId: string;
	target: string;
	submittedAt: number;
}

export interface MonitorTask {
	ownerSessionId: string;
	paneId: string;
	displayTarget: string;
	status: MonitorStatus;
	initialAgentStatus: HerdrAgentStatus;
	baselineStateChangeSeq?: number;
	observedWorking: boolean;
	startedAt: number;
	generation: number;
	submissions: MonitorSubmission[];
	omittedSubmissions: number;
	controller: AbortController;
	promise?: Promise<void>;
}

export interface MonitorOutcome {
	status: "completed" | "blocked" | "failed" | "cancelled";
	agentStatus?: HerdrAgentStatus;
	error?: string;
}

export interface CompletedMonitor {
	ownerSessionId: string;
	paneId: string;
	displayTarget: string;
	submissions: MonitorSubmission[];
	omittedSubmissions: number;
	outcome: MonitorOutcome;
	completedAt: number;
}
