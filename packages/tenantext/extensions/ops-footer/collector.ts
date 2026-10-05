import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hostname } from "node:os";
import { number, safeText } from "./adapters.ts";
import type { AgentState, SessionSnapshot } from "./types.ts";

/** Read numeric accounting only. Do not retain message content or provider auth. `startedIn` is the cwd recorded at session start. */
export function collectSession(pi: ExtensionAPI, ctx: ExtensionContext, state: AgentState, startedIn = ctx.cwd): SessionSnapshot {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of ctx.sessionManager.getBranch()) {
    let usage;
    if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) usage = entry.message.usage;
    else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") usage = entry.usage;
    if (!usage) continue;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) totals[key] += number(usage[key]) ?? 0;
    totals.cost += number(usage.cost?.total) ?? 0;
  }
  const startedAt = Date.parse(ctx.sessionManager.getHeader()?.timestamp ?? "");
  return {
    ...totals, state, provider: safeText(ctx.model?.provider), model: safeText(ctx.model?.id), thinking: ctx.thinkingLevel ?? "off",
    cwd: safeText(ctx.cwd), startedIn: safeText(startedIn), hostname: safeText(hostname()), remote: Boolean(process.env.SSH_CONNECTION),
    session: safeText(ctx.sessionManager.getSessionName() ?? "unnamed"),
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(), tools: pi.getActiveTools().length, pending: ctx.hasPendingMessages(),
  };
}
