import { record } from "./snapshot.ts";

/**
 * One suggested next move from a decision server that answers a choice question at nextMoveUrl. Off when no URL is set.
 * probability: the top option's share, shown in the chip. confidence: top minus second, used for the gate.
 */
export interface NextMove { choice: string; probability: number; confidence: number }
/** signal: an outside abort (session shutdown or toggle off) on top of the hard timeout. */
export interface NextMoveConfig { url: string; key?: string; timeoutMs: number; minConfidence: number; signal?: AbortSignal }
/** failed: the endpoint did not answer (offline, timeout, HTTP error, bad body). A confident or unconfident answer is not a failure. */
export interface NextMoveAnswer { move?: NextMove; failed: boolean }
export interface SessionState {
  context_used_pct: number;
  turns: number;
  last_tool_error: boolean;
  last_user_message: string;
}

export const MESSAGE_CHARS = 300;
export const question = {
  type: "choice",
  instructions: "What should the user do next in this agent session?",
  criteria: {
    continue: "Context is below 60 percent and the work is going well; keep working",
    compact: "Context is above 75 percent and the current task continues; summarise the session before continuing",
    handoff: "Context is above 85 percent with several open tasks, or the session is stuck; write a handoff and start a fresh session",
    commit: "A unit of work is complete and checked; commit now",
    validate: "Code changed or a tool failed; run tests or checks before going on",
  },
} as const;

const textOf = (content: unknown): string => typeof content === "string" ? content :
  Array.isArray(content) ? content.map(block => { const b = record(block); return b.type === "text" && typeof b.text === "string" ? b.text : ""; }).join(" ") : "";

/** Build the small state the decision model sees. Only the end of the last user message leaves the process. */
export function sessionState(messages: readonly unknown[], percent: number): SessionState {
  let turns = 0, lastUser = "", lastToolError = false;
  for (const value of messages) {
    const message = record(value);
    if (message.role === "user") { turns++; lastUser = textOf(message.content); lastToolError = false; }
    else if (message.role === "toolResult") lastToolError = message.isError === true;
  }
  return {
    context_used_pct: Math.round(percent),
    turns,
    last_tool_error: lastToolError,
    last_user_message: lastUser.replace(/\s+/g, " ").trim().slice(-MESSAGE_CHARS),
  };
}

/** Ask once, never retry. The hard timeout always applies; an outside signal can end the call earlier. */
export async function fetchNextMove(config: NextMoveConfig, state: SessionState, fetchImpl: typeof fetch = fetch): Promise<NextMoveAnswer> {
  if (!config.url) return { failed: false };
  const timeout = AbortSignal.timeout(config.timeoutMs);
  try {
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) },
      body: JSON.stringify({ state, questions: { next_move: question } }),
      signal: config.signal ? AbortSignal.any([timeout, config.signal]) : timeout,
    });
    if (!response.ok) return { failed: true };
    const answer = record(record(record(await response.json()).answers).next_move);
    const choice = answer.choice, confidence = answer.confidence;
    const probability = record(answer.probabilities)[String(choice)];
    if (typeof choice !== "string" || typeof confidence !== "number" || !Number.isFinite(confidence)) return { failed: true };
    if (!(choice in question.criteria) || confidence < config.minConfidence) return { failed: false };
    return { failed: false, move: { choice, confidence, probability: typeof probability === "number" && Number.isFinite(probability) ? probability : confidence } };
  } catch {
    return { failed: true };
  }
}

/** Ask once. Returns undefined on timeout, error, bad shape, or low confidence; the caller then shows nothing. */
export async function askNextMove(config: NextMoveConfig, state: SessionState, fetchImpl: typeof fetch = fetch): Promise<NextMove | undefined> {
  return (await fetchNextMove(config, state, fetchImpl)).move;
}

/** Cooldown after a failed call: first 30 s, doubling to a 10-minute cap. One success clears it. */
export interface BreakerPolicy { baseMs: number; maxMs: number }
export const breakerDefaults: Readonly<BreakerPolicy> = Object.freeze({ baseMs: 30_000, maxMs: 600_000 });
export interface Breaker {
  /** True when a call to this URL may go out now. A new URL starts with a clean record. */
  allow(url: string): boolean;
  failure(): void;
  success(): void;
  /** Failures in a row, and the time when calls resume (0 when open). */
  state(): { failures: number; resumeAt: number };
}

/** A per-endpoint circuit breaker. It holds no timer; the caller asks `allow` on each trigger. */
export function createBreaker(policy: BreakerPolicy = breakerDefaults, now: () => number = Date.now): Breaker {
  let url = "", failures = 0, resumeAt = 0;
  return {
    allow(target) {
      if (target !== url) { url = target; failures = 0; resumeAt = 0; }
      return now() >= resumeAt;
    },
    failure() { failures++; resumeAt = now() + Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(failures - 1, 30)); },
    success() { failures = 0; resumeAt = 0; },
    state: () => ({ failures, resumeAt }),
  };
}

/** Chip text, for example "next: compact 0.74". */
export const nextMoveChip = (move: NextMove): string => `next: ${move.choice} ${move.probability.toFixed(2)}`;
