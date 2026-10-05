/** One model call as seen in a harness trace. */
export interface CallRecord {
	harness: "pi" | "claude";
	sessionId: string;
	sessionFile: string;
	/** Project working directory when known. */
	cwd?: string;
	/** main, or subagent:<role or description>. */
	role: string;
	provider?: string;
	model: string;
	/** Thinking or effort level when the trace records it. */
	thinking?: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** USD. null when the trace has no cost and no price is known. */
	cost: number | null;
	/** Tool names called in this assistant message. */
	tools: string[];
	timestamp: number;
}

export interface TraceFilter {
	/** Only records at or after this epoch ms. */
	since?: number;
	/** Only sessions whose first parsed model call is at or after this epoch ms. */
	sessionStartedSince?: number;
	/** Only sessions whose cwd equals this path. */
	cwd?: string;
	/** Only records whose session cwd is this directory or a subdirectory. */
	cwdInside?: string;
	/** Only these session files. */
	sessionFiles?: string[];
}
