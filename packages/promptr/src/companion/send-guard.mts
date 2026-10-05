/**
 * Send guard for the companion's direct-send review.
 *
 * Pure decision table over the left Pi's Herdr agent status plus one
 * synchronous status probe. No side effects beyond the injected runner.
 */
import { spawnSync } from "node:child_process";
import { parseAgentStatus, type AgentStatus } from "./host-tracking.mts";

export type SendGuardDecision =
  | { action: "submit" }
  | { action: "arm"; message: string }
  | { action: "refuse"; message: string };

/**
 * idle/unknown submit (Herdr itself rejects bad targets; attempted != delivered
 * stays); working needs a second Enter; blocked refuses.
 */
export function sendGuardDecision(status: AgentStatus, armed: boolean): SendGuardDecision {
  switch (status) {
    case "working":
      return armed
        ? { action: "submit" }
        : { action: "arm", message: "left Pi is working — Enter again submits into the running turn; Esc keeps the queue" };
    case "blocked":
      return { action: "refuse", message: "left Pi is blocked (approval/question) — resolve it in the left pane first; queue kept" };
    default:
      return { action: "submit" };
  }
}

export function reviewStatusLine(pane: string | undefined, status: AgentStatus): string {
  if (!pane) return "Target: no --pi-pane (nothing will be sent)";
  return `Target: left Pi ${pane} · status ${status}`;
}

export type StatusRunner = (
  cmd: string,
  args: string[],
  opts: { timeout: number; encoding: "utf8"; maxBuffer: number },
) => { status: number | null; stdout?: string | null; error?: unknown };

/** `herdr pane get <pane>` with a 5 s timeout; any error or non-zero exit → `unknown`. */
export function readPiStatusNow(pane: string, run: StatusRunner = spawnSync): AgentStatus {
  try {
    const result = run("herdr", ["pane", "get", pane], { timeout: 5000, encoding: "utf8", maxBuffer: 256 * 1024 });
    if (result.error || result.status !== 0) return "unknown";
    return parseAgentStatus(typeof result.stdout === "string" ? result.stdout : "");
  } catch {
    return "unknown";
  }
}
