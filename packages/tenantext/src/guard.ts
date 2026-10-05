/**
 * Startup guard state machine.
 *
 * Invariant: no agent run may start before a human prompt in this session.
 * Pi itself never calls the provider before the first prompt; this guard
 * protects that invariant against extensions that inject prompts, and it
 * records any provider request that happens before a human prompt.
 */
export type InputSource = "interactive" | "rpc" | "extension" | (string & {});

export interface GuardState {
	/** A human prompt (typed or via RPC) has been seen in this session. */
	humanPromptSeen: boolean;
	/** Extension-injected prompts blocked before the first human prompt. */
	blockedInputs: number;
	/** Agent runs that started before a human prompt without passing the input event. */
	unverifiedRuns: number;
	/** Provider requests observed before the first human prompt. */
	requestsBeforeHuman: number;
	/** Provider requests observed in total this session. */
	requestsTotal: number;
}

export function createGuardState(humanPromptSeen = false): GuardState {
	return { humanPromptSeen, blockedInputs: 0, unverifiedRuns: 0, requestsBeforeHuman: 0, requestsTotal: 0 };
}

export type InputDecision = "allow" | "block";

/** Decide on an input event. Mutates state. */
export function onInput(state: GuardState, source: InputSource, guardEnabled: boolean): InputDecision {
	if (source === "interactive" || source === "rpc") {
		state.humanPromptSeen = true;
		return "allow";
	}
	if (source === "extension" && !state.humanPromptSeen && guardEnabled) {
		state.blockedInputs += 1;
		return "block";
	}
	return "allow";
}

/**
 * Record an agent run start. Returns true when no human prompt preceded it.
 * Does not mark the session as human-initiated: a run that bypassed the
 * input event (pi.sendMessage with triggerTurn) is exactly what the guard
 * must keep reporting, and later extension prompts stay blocked.
 */
export function onAgentStart(state: GuardState): boolean {
	if (state.humanPromptSeen) return false;
	state.unverifiedRuns += 1;
	return true;
}

/** Record a provider request. Returns true when it happened before any human prompt. */
export function onProviderRequest(state: GuardState): boolean {
	state.requestsTotal += 1;
	if (state.humanPromptSeen) return false;
	state.requestsBeforeHuman += 1;
	return true;
}

/** Short footer status text. */
export function statusText(state: GuardState, rulesOn: boolean, guardOn: boolean): string {
	const parts: string[] = [];
	parts.push(rulesOn ? "STE on" : "STE off");
	if (guardOn) {
		parts.push(state.humanPromptSeen ? "guard passed" : "guard armed");
	} else {
		parts.push("guard off");
	}
	const flagged = state.blockedInputs + state.unverifiedRuns + state.requestsBeforeHuman;
	if (flagged > 0) parts.push(`${flagged} flagged`);
	return parts.join(" · ");
}
