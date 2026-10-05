import type { NextMove } from "../extensions/context-meter/next-move.ts";
import { contextState, snapshot, type ContextState } from "../extensions/context-meter/snapshot.ts";
import { defaults as meterDefaults } from "../extensions/context-meter/settings.ts";
import type { ContextService, DashboardSnapshot, IntegrationSnapshot, LimitsSnapshot } from "../extensions/ops-footer/types.ts";

/** Shared footer fixtures for tests and the preview script. Times are fixed so output is stable. */
export const NOW = Date.parse("2026-09-22T07:00:00Z");
export const HOUR = 3_600_000;

export interface ContextInput { used?: number; window?: number; system?: number; estimates?: { sys: number; prompt: number; assistant: number; think: number; tools: number }; nextMove?: NextMove }
/** Build a context service from numbers. The real meter computes the semantic state; the footer only reads it. */
export function contextStub(input: ContextInput = {}): ContextService {
  const window = "window" in input ? input.window : 272_000, used = "used" in input ? input.used : 72_500, system = input.system ?? 8_000;
  const estimates = input.estimates ?? { sys: system, prompt: 4_000, assistant: 12_000, think: 6_000, tools: 42_500 };
  const s = snapshot("openai-codex/gpt-5.6-sol", used, window, system, estimates, meterDefaults);
  const state: ContextState = contextState(s, meterDefaults, input.nextMove);
  return { state: () => state, render: () => [], report: () => `Stage: ${state.stage}; used ${used}`, subscribe: () => () => {}, dispose() {} };
}
export const contextUnknown = (): ContextService => contextStub({ used: undefined, window: undefined });

export function limits(overrides: Partial<LimitsSnapshot> = {}): LimitsSnapshot {
  return {
    state: "ok", summary: "ok", checkedAt: NOW - 10_000, staleAfter: 60_000,
    accounts: [
      { label: "Codex1", order: 1, state: "ok", windows: [{ name: "5h", percent: 80, unavailable: false, resetsAt: NOW + 2 * HOUR + 47 * 60_000 }, { name: "7d", percent: 80, unavailable: false, resetsAt: NOW + 6 * 24 * HOUR + 22 * HOUR }] },
      { label: "Codex2", order: 2, state: "ok", windows: [{ name: "5h", percent: 60, unavailable: false, resetsAt: NOW + 35 * 60_000 }, { name: "7d", percent: 60, unavailable: false, resetsAt: NOW + 5 * 24 * HOUR + 7 * HOUR }] },
    ],
    route: { state: "unknown", selected: "codex2" },
    ...overrides,
  };
}
/** A paid Copilot seat: premium requests metered, chat and completions unlimited. */
export function copilot(premium = 83): NonNullable<DashboardSnapshot["copilot"]> {
  return { state: "ok", summary: "ok", checkedAt: NOW - 30_000, staleAfter: 600_000, source: "pi", plan: "individual", route: { state: "unknown" },
    accounts: [{ label: "Copilot", order: 1000, state: "ok", windows: [{ name: "premium", percent: premium, unavailable: false, resetsAt: NOW + 8 * 24 * HOUR + 17 * HOUR, remaining: premium * 3, entitlement: 300 }] }] };
}
/** A Claude Max login: the two base windows and the two model windows. */
export function anthropic(fiveHour = 72): NonNullable<DashboardSnapshot["anthropic"]> {
  return { state: "ok", summary: "ok", checkedAt: NOW - 30_000, staleAfter: 600_000, source: "claude-code", plan: "max", route: { state: "unknown" },
    accounts: [{ label: "Claude", order: 900, state: "ok", plan: "max", windows: [
      { name: "5h", percent: fiveHour, unavailable: false, resetsAt: NOW + 3 * HOUR + 12 * 60_000 }, { name: "7d", percent: 41, unavailable: false, resetsAt: NOW + 4 * 24 * HOUR + 2 * HOUR },
      { name: "opus", percent: 55, unavailable: false, resetsAt: NOW + 4 * 24 * HOUR + 2 * HOUR }, { name: "sonnet", percent: 90, unavailable: false, resetsAt: NOW + 4 * 24 * HOUR + 2 * HOUR }] }] };
}
/** The third Codex account is configured and has no login. */
export const codexNoLogin = (): LimitsSnapshot["accounts"][number] => ({ label: "Codex3", order: 3, state: "unknown", windows: [], login: false });
export function integration(source: IntegrationSnapshot["source"], overrides: Partial<IntegrationSnapshot> = {}): IntegrationSnapshot {
  return { source, state: "ok", summary: "ok", checkedAt: NOW - 5_000, staleAfter: 60_000, ...overrides };
}
export function healthy(): DashboardSnapshot {
  return {
    session: {
      state: "idle", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high",
      cwd: "/home/dev/tenantext", startedIn: "/home/dev/tenantext", hostname: "devbox", remote: false, session: "unnamed", startedAt: NOW - 27 * 60_000,
      input: 72_500, output: 5_800, cacheRead: 228_000, cacheWrite: 0, cost: 0.478, tools: 45, pending: false,
    },
    git: { state: "ok", summary: "local Git", checkedAt: NOW - 1_000, staleAfter: 5_000, repo: "tenantext", branch: "main", worktree: "/home/dev/tenantext", worktrees: 1, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 },
    limits: limits(),
    integrations: [integration("OK"), integration("OV"), integration("MCP", { active: 7, configured: 7, failed: 0 }), integration("work", { working: 0, done: 3, prompts: 0, blocked: 0 })],
    extensionStatuses: 10, conflict: false, languageStatus: "STE on guard passed",
  };
}
export interface Fixture { name: string; data: DashboardSnapshot; context: ContextService }
const change = (name: string, edit: (d: DashboardSnapshot) => void, context = contextStub()): Fixture => { const data = healthy(); edit(data); return { name, data, context }; };
export const fixtures: Fixture[] = [
  { name: "healthy", data: healthy(), context: contextStub() },
  change("context PLAN", () => {}, contextStub({ used: 168_000 })),
  change("context WARN", () => {}, contextStub({ used: 212_000 })),
  change("context CRIT", () => {}, contextStub({ used: 248_000 })),
  change("SYS! crossed", () => {}, contextStub({ system: 20_800, estimates: { sys: 20_800, prompt: 4_000, assistant: 12_000, think: 6_000, tools: 29_700 } })),
  change("low quota", d => { d.limits!.accounts[1].windows[0].percent = 20; d.limits!.state = "warning"; }),
  change("exhausted quota", d => { d.limits!.accounts[1].windows[0].percent = 2; d.limits!.state = "warning"; }),
  change("unavailable window", d => { d.limits!.accounts[0].windows[1] = { name: "7d", unavailable: true }; }),
  change("stale limits", d => { d.limits!.checkedAt = NOW - 10 * 60_000; }),
  change("failed service", d => { d.integrations = [integration("OV", { state: "error", summary: "unavailable" }), integration("OK"), integration("MCP", { active: 6, configured: 7, failed: 1, failedNames: ["example-server"] })]; }),
  change("copilot quota", d => { d.copilot = copilot(); }),
  change("copilot only", d => { d.limits = undefined; d.session.provider = "github-copilot"; d.session.model = "claude-sonnet-5"; d.copilot = copilot(); }),
  change("copilot low premium", d => { d.limits = undefined; d.session.provider = "github-copilot"; d.session.model = "claude-sonnet-5"; d.copilot = copilot(18); }),
  change("three codex, claude, copilot", d => { d.limits!.accounts.push(codexNoLogin()); d.anthropic = anthropic(); d.copilot = copilot(); }),
  change("claude only", d => { d.limits = undefined; d.session.provider = "anthropic"; d.session.model = "claude-opus-5-5"; d.anthropic = anthropic(); }),
  change("dirty repo", d => { Object.assign(d.git, { staged: 2, unstaged: 4, untracked: 1, ahead: 3, behind: 2 }); }),
  change("extra worktrees", d => { d.git.worktrees = 3; }),
  change("cwd differs", d => { d.session.cwd = "/home/dev/tenantext/extensions/ops-footer"; }),
  change("pending prompt", d => { d.session.state = "waiting"; d.integrations.push(integration("work", { prompts: 2, blocked: 1 })); }),
  change("model failure", d => { d.session.state = "failed"; }),
  change("Powerline conflict", d => { d.conflict = true; }),
  change("STE flagged", d => { d.languageStatus = "STE on guard armed 2 flagged"; }),
  change("unknown context", () => {}, contextUnknown()),
  // Next-move chip: sample decision-server answers for the states "early", "ctx-78" and "ctx-93" in scripts/next-move-states.json.
  change("next move continue", () => {}, contextStub({ used: 60_000, nextMove: { choice: "continue", probability: 0.99, confidence: 0.99 } })),
  change("next move compact", () => {}, contextStub({ used: 212_000, nextMove: { choice: "compact", probability: 1.0, confidence: 0.99 } })),
  change("next move handoff CRIT", () => {}, contextStub({ used: 253_000, nextMove: { choice: "handoff", probability: 0.9, confidence: 0.82 } })),
];
