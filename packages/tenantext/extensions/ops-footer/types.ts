import type { ContextState } from "../context-meter/snapshot.ts";

export type StatusState = "ok" | "warning" | "error" | "unknown";
export interface StatusSnapshot {
  state: StatusState;
  summary: string;
  details?: string[];
  checkedAt: number;
  staleAfter: number;
}
export interface ContextService {
  render(width: number): string[];
  /** Semantic state: totals, stage, thresholds, weights. The footer never computes its own percentage or stage. */
  state(): ContextState;
  report(): string;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
export interface GitSnapshot extends StatusSnapshot {
  repo?: string; branch?: string; worktree?: string; worktrees?: number;
  staged?: number; unstaged?: number; untracked?: number; ahead?: number; behind?: number;
}
export type IntegrationSource = "MCP" | "OK" | "OV" | "Wiki" | "Hermes" | "work";
export interface IntegrationSnapshot extends StatusSnapshot {
  source: IntegrationSource;
  active?: number; configured?: number; failed?: number;
  working?: number; blocked?: number; done?: number; prompts?: number;
  background?: number; dirty?: number; review?: boolean; deploy?: boolean;
  index?: "ready" | "building" | "unknown";
  failedNames?: string[];
}
export interface LimitsWindow { name: string; percent?: number; unavailable: boolean; resetsAt?: number; remaining?: number; entitlement?: number }
export interface LimitsAccount {
  label: string; order: number; state: StatusState; windows: LimitsWindow[];
  /** Allowlisted Codex plan, e.g. `pro_lite`. */ plan?: string;
  /** `false`: the account is configured but has no login. The footer shows `no login` and raises no alert. */
  login?: false;
}
export interface LimitsSnapshot extends StatusSnapshot {
  /** Stable identity order: Codex1, Codex2, ... Never sorted by severity, percent, route, or refresh order. */
  accounts: LimitsAccount[];
  /** `selected` is a gateway account name of the form codexN. */
  route: { state: StatusState; selected?: string };
}
export type AgentState = "idle" | "working" | "waiting" | "compacting" | "retrying" | "failed";
export interface SessionSnapshot {
  state: AgentState; provider: string; model: string; thinking: string;
  cwd: string; startedIn: string; hostname: string; remote: boolean; session: string; startedAt: number;
  input: number; output: number; cacheRead: number; cacheWrite: number; cost: number;
  tools: number; pending: boolean;
}
export interface MemoryActivity {
  running: string[];
  last?: string;
  failed?: boolean;
}
export interface MemorySnapshot {
  ov?: MemoryActivity & { added?: number; pendingTokens?: number; threshold?: number };
  wiki?: MemoryActivity & { state: StatusState; model?: string; sessionModel?: boolean; recalled?: number; suggestCapture: boolean };
}
export interface DashboardSnapshot {
  session: SessionSnapshot; git: GitSnapshot; limits?: LimitsSnapshot;
  /** GitHub Copilot quota, one account ordered after every Codex account. Absent when no local credential reached the endpoint. */
  copilot?: LimitsSnapshot & { source?: string; plan?: string };
  /** Anthropic subscription quota, one `Claude` account after every Codex account and before Copilot. Absent when no active credential gave a reading. */
  anthropic?: LimitsSnapshot & { source?: string; plan?: string };
  integrations: IntegrationSnapshot[]; extensionStatuses: number; conflict: boolean;
  languageStatus?: string;
  memory?: MemorySnapshot;
}
export const OWNERSHIP = "tenantext:ops-footer:ownership";
export const OWNERSHIP_QUERY = "tenantext:ops-footer:query";
export const INTEGRATION_STATUS = "tenantext:ops-footer:status";
export const CODEX_STATUS = "tenantext:codex:status";
export const CODEX_REFRESH = "tenantext:codex:refresh";
export const COPILOT_STATUS = "tenantext:copilot:status";
export const COPILOT_REFRESH = "tenantext:copilot:refresh";
export const ANTHROPIC_STATUS = "tenantext:anthropic:status";
export const ANTHROPIC_REFRESH = "tenantext:anthropic:refresh";
