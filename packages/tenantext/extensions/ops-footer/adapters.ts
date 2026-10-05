import type { AnthropicStatusSnapshot } from "../anthropic-usage/status.ts";
import type { CodexStatusSnapshot } from "../codex-accounts/status.ts";
import type { CopilotStatusSnapshot } from "../copilot-usage/status.ts";
import type { IntegrationSnapshot, IntegrationSource, LimitsAccount, LimitsSnapshot, LimitsWindow, StatusSnapshot, StatusState } from "./types.ts";

const states = new Set(["ok", "warning", "error", "unknown"]);
export function state(value: unknown): StatusState {
  return typeof value === "string" && states.has(value) ? value as StatusState : "unknown";
}
export function number(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;
}
export function count(value: unknown): number | undefined {
  const n = number(value, 1_000_000);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}
/** Only display labels, never arbitrary status bodies, URLs, or credential locations. */
export function safeText(value: unknown): string {
  if (typeof value !== "string") return "n/a";
  if (/(?:bearer\s|sk-|eyJ|access.?token|refresh.?token|api.?key|authorization|auth\.json|credentials|\.ssh|\.aws)/i.test(value)) return "[redacted]";
  for (const [key, secret] of Object.entries(process.env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)/i.test(key) && secret && secret.length >= 4 && value.includes(secret)) return "[redacted]";
  }
  return value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "").slice(0, 256);
}
export function freshness(snapshot: StatusSnapshot, now = Date.now()): "fresh" | "stale" | "unknown" {
  return snapshot.checkedAt <= 0 ? "unknown" : now - snapshot.checkedAt >= snapshot.staleAfter ? "stale" : "fresh";
}
export function unknown(summary = "unavailable"): StatusSnapshot {
  return { state: "unknown", summary, checkedAt: 0, staleAfter: 0 };
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const MAX_LIFETIME_MS = 3_600_000;
/** A quota source publishes two times its poll time, and the longest poll time is 3600 seconds. */
const MAX_QUOTA_LIFETIME_MS = 7_200_000;
/** `floor` is the footer's own minimum: it comes from the footer settings, never from the bus, so the cap does not apply to it. */
function times(v: Record<string, unknown>, now: number, cap = MAX_LIFETIME_MS, floor = 0) {
  return { checkedAt: Math.min(number(v.checkedAt) ?? now, now), staleAfter: Math.max(Math.min(number(v.staleAfter) ?? 60000, cap), floor) };
}
/** Public bus boundary. Summary/details are deliberately ignored. */
export function integrationStatus(value: unknown, now = Date.now()): IntegrationSnapshot | undefined {
  const v = record(value);
  if (!v || !["MCP", "OK", "OV", "Wiki", "Hermes", "work"].includes(String(v.source))) return;
  const out: IntegrationSnapshot = { source: v.source as IntegrationSource, state: state(v.state), summary: state(v.state), ...times(v, now) };
  for (const key of ["active", "configured", "failed", "working", "blocked", "done", "prompts", "background", "dirty"] as const) {
    const n = count(v[key]);
    if (n !== undefined) out[key] = n;
  }
  if (out.source === "MCP" && out.configured !== undefined &&
    ((out.active ?? 0) > out.configured || (out.failed ?? 0) > out.configured)) return;
  if ((out.failed ?? 0) > 0) out.state = "error";
  else if ((out.blocked ?? 0) > 0 && out.state === "ok") out.state = "warning";
  for (const key of ["review", "deploy"] as const) if (typeof v[key] === "boolean") out[key] = v[key];
  if ((out.review || out.deploy) && out.state === "ok") out.state = "warning";
  out.summary = out.state;
  if (["ready", "building", "unknown"].includes(String(v.index))) out.index = v.index as IntegrationSnapshot["index"];
  // Names require an explicit local allow-list. Unknown names never cross the boundary.
  const allowed = new Set((process.env.OPS_FOOTER_MCP_NAMES ?? "").split(",").filter(n => /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(n)));
  if (Array.isArray(v.failedNames)) out.failedNames = v.failedNames.filter((n): n is string => typeof n === "string" && allowed.has(n)).slice(0, 16).map(safeText);
  return out;
}
/** Preserve the suite's language/guard status without accepting arbitrary status prose. */
export function languageStatus(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const match = /^STE (on|off) · guard (passed|armed|off)(?: · ([0-9]{1,9}) flagged)?$/.exec(value);
  if (!match || match[0] !== value) return;
  return `STE ${match[1]} guard ${match[2]}${match[3] ? ` ${Number(match[3])} flagged` : ""}`;
}
export function publicStatuses(statuses: ReadonlyMap<string, string>, now = Date.now()): IntegrationSnapshot[] {
  const out: IntegrationSnapshot[] = [];
  for (const [key, source] of [["openknowledge", "OK"], ["openviking", "OV"], ["llm-wiki", "Wiki"], ["hermes-memory", "Hermes"]] as const) {
    const raw = statuses.get(key);
    // Exact, fixed tokens only. Arbitrary extension prose is not a health protocol.
    if (raw && states.has(raw)) out.push({ source, state: raw as StatusState, summary: raw, checkedAt: now, staleAfter: 60000 });
    else if (source === "OV" && raw) {
      // The verified OpenViking prefix is public. Its suffix contains a session ID.
      const match = /^OV (✓|✗)(?:\s|$)/u.exec(raw.replace(/\x1b\[[0-9;]*m/g, ""));
      if (match) {
        const health = match[1] === "✓" ? "ok" : "error";
        out.push({ source, state: health, summary: health, checkedAt: now, staleAfter: 60000 });
      }
    }
  }
  return out;
}
function resetEpoch(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}
/** Mirrors the account extension's normalized plan names. Any other value never crosses the boundary. */
const CODEX_PLANS = new Set(["free", "go", "plus", "pro", "pro_lite", "team", "business", "enterprise", "edu", "unknown"]);
/** Codex orders stay below 900, so every Codex account sorts before Claude (900) and Copilot (1000). The fallback is the last Codex place. */
function accountIdentity(provider: unknown): { label: string; order: number } {
  if (provider === "openai-codex") return { label: "Codex1", order: 1 };
  const match = typeof provider === "string" ? /^openai-codex-(\d{1,3})$/.exec(provider) : null;
  return match ? { label: `Codex${Number(match[1])}`, order: Number(match[1]) } : { label: "Codex", order: 899 };
}
/** Accept the `CodexStatusSnapshot` shape but whitelist every field. No runtime provider import, no pre-formatted strings. */
/** `lifetimeFloor` is the shortest lifetime the footer gives a quota reading: see `quotaLifetimeFloor` in `runtime.ts`. */
export function codexStatus(value: unknown, now = Date.now(), lifetimeFloor = 0): LimitsSnapshot | undefined {
  const v = record(value);
  if (!v || !Array.isArray(v.accounts)) return;
  const typed = value as CodexStatusSnapshot;
  const accounts: LimitsAccount[] = [];
  let severity: StatusState = "ok";
  for (const raw of typed.accounts.slice(0, 8)) {
    const account = record(raw);
    if (!account) continue;
    // Only the literal boolean crosses. An account with no login has no windows and does not change the severity.
    if (account.login === false) { accounts.push({ ...accountIdentity(account.provider), state: "unknown", windows: [], login: false }); continue; }
    const s = state(account.state);
    if (s !== "ok") severity = s === "error" ? "error" : severity === "ok" ? "unknown" : severity;
    const windows: LimitsWindow[] = [];
    for (const rawWindow of Array.isArray(account.windows) ? account.windows.slice(0, 8) : []) {
      const w = record(rawWindow);
      if (!w) continue;
      const percent = number(w.remainingPercent, 100);
      // Duration labels (`5h`, `7d`, `90m`) or fixed names. Slot names such as `primary` do not state a duration and become `window`.
      const name = typeof w.label === "string" && /^(?:[1-9]\d{0,2}[mhd]|week|weekly|daily)$/i.test(w.label) ? w.label.toLowerCase() : "window";
      if (w.unavailable === true || percent === undefined) { windows.push({ name, unavailable: true }); if (severity === "ok") severity = "unknown"; }
      else { windows.push({ name, percent, unavailable: false, resetsAt: resetEpoch(w.resetsAt) }); if (percent <= 10 && severity !== "error") severity = "warning"; }
    }
    const plan = typeof account.plan === "string" && CODEX_PLANS.has(account.plan) ? account.plan : undefined;
    accounts.push({ ...accountIdentity(account.provider), state: s, windows, ...(plan ? { plan } : {}) });
  }
  // Identity order only. A low window changes styling inside its group, never the group order.
  accounts.sort((a, b) => a.order - b.order);
  const routing = record(v.routing);
  const routeState = state(routing?.state);
  const selected = routing?.selectedAccount;
  const route: LimitsSnapshot["route"] = { state: routeState, ...(typeof selected === "string" && /^codex[1-9][0-9]*$/.test(selected) ? { selected } : {}) };
  if (routeState === "error") severity = "error";
  if (!accounts.length && severity === "ok") severity = "unknown";
  return { state: severity, summary: severity, accounts, route, ...times(v, now, MAX_QUOTA_LIFETIME_MS, lifetimeFloor) };
}
/** Copilot quota as one `Copilot` account after the Codex accounts. `absent` or a malformed value clears the meter. */
export function copilotStatus(value: unknown, now = Date.now(), lifetimeFloor = 0): (LimitsSnapshot & { source?: string; plan?: string }) | undefined {
  const v = record(value);
  if (!v || !Array.isArray(v.windows) || (v.state !== "ok" && v.state !== "error")) return;
  const typed = value as CopilotStatusSnapshot;
  const windows: LimitsWindow[] = [];
  let severity: StatusState = v.state === "error" ? "error" : "ok";
  for (const raw of typed.windows.slice(0, 4)) {
    const w = record(raw);
    if (!w || !["premium", "chat", "compl"].includes(String(w.label))) continue;
    const percent = number(w.remainingPercent, 100);
    if (percent === undefined) { windows.push({ name: String(w.label), unavailable: true }); continue; }
    windows.push({ name: String(w.label), percent, unavailable: false, resetsAt: resetEpoch(w.resetsAt), remaining: number(w.remaining), entitlement: number(w.entitlement) });
    if (percent <= 10 && severity === "ok") severity = "warning";
  }
  // A plan whose every quota is unlimited has nothing to meter.
  if (severity !== "error" && !windows.length) return;
  const source = typeof v.source === "string" && /^[a-z-]{1,16}$/.test(v.source) ? v.source : undefined;
  const plan = typeof v.plan === "string" && /^[a-z_]{1,40}$/.test(v.plan) ? v.plan : undefined;
  return { state: severity, summary: severity, accounts: [{ label: "Copilot", order: 1000, state: v.state === "error" ? "error" : "ok", windows }],
    route: { state: "unknown" }, source, plan, ...times(v, now, MAX_QUOTA_LIFETIME_MS, lifetimeFloor) };
}
/** Mirrors the plan values of the Anthropic extension. Any other value never crosses the boundary. */
const ANTHROPIC_PLANS = new Set(["free", "pro", "max", "team", "enterprise"]);
const ANTHROPIC_WINDOWS = new Set(["5h", "7d", "opus", "sonnet"]);
const ANTHROPIC_SOURCES = new Set(["claude-code", "pi"]);
/** Anthropic quota as one `Claude` account after the Codex accounts and before Copilot. `absent` or a malformed value clears the meter. */
export function anthropicStatus(value: unknown, now = Date.now(), lifetimeFloor = 0): (LimitsSnapshot & { source?: string; plan?: string }) | undefined {
  const v = record(value);
  if (!v || !Array.isArray(v.windows) || (v.state !== "ok" && v.state !== "error" && v.state !== "unknown")) return;
  const typed = value as AnthropicStatusSnapshot;
  const windows: LimitsWindow[] = [];
  // `unknown`: the last request failed and the windows are the last good reading. It shows no error chip.
  let severity: StatusState = v.state === "error" ? "error" : v.state === "unknown" ? "unknown" : "ok";
  for (const raw of typed.windows.slice(0, 4)) {
    const w = record(raw);
    if (!w || typeof w.label !== "string" || !ANTHROPIC_WINDOWS.has(w.label)) continue;
    const percent = number(w.remainingPercent, 100);
    if (percent === undefined) continue;
    windows.push({ name: w.label, percent, unavailable: false, resetsAt: resetEpoch(w.resetsAt) });
    if (percent <= 10 && severity !== "error") severity = "warning";
  }
  // A reading with no valid window has nothing to meter.
  if (severity !== "error" && !windows.length) return;
  const source = typeof v.source === "string" && ANTHROPIC_SOURCES.has(v.source) ? v.source : undefined;
  const plan = typeof v.plan === "string" && ANTHROPIC_PLANS.has(v.plan) ? v.plan : undefined;
  return { state: severity, summary: severity, accounts: [{ label: "Claude", order: 900, state: v.state === "error" ? "error" : v.state === "unknown" ? "unknown" : "ok", windows: v.state === "error" ? [] : windows, ...(plan ? { plan } : {}) }],
    route: { state: "unknown" }, source, plan, ...times(v, now, MAX_QUOTA_LIFETIME_MS, lifetimeFloor) };
}

export type HealthFetch = typeof fetch;
export class HealthAdapter {
  private controllers = new Set<AbortController>();
  private disposed = false;
  private fetcher: HealthFetch;
  constructor(fetcher: HealthFetch = fetch) { this.fetcher = fetcher; }
  async check(source: "OK" | "OV", url: string, timeout: number, lifetime: number): Promise<IntegrationSnapshot> {
    const controller = new AbortController();
    this.controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.disposed) throw new Error("stopped");
      const response = await Promise.race([
        this.fetcher(url, { method: "GET", redirect: "error", signal: controller.signal, cache: "no-store" }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
          timer = setTimeout(() => controller.abort(), timeout);
        }),
      ]);
      // Do not read or log the body, headers, URL, or error text.
      void response.body?.cancel().catch(() => {});
      return { source, state: response.ok ? "ok" : "error", summary: response.ok ? "accessible" : "unavailable", checkedAt: Date.now(), staleAfter: lifetime };
    } catch {
      return { source, state: "error", summary: "unavailable", checkedAt: Date.now(), staleAfter: lifetime };
    } finally {
      clearTimeout(timer); controller.abort(); this.controllers.delete(controller);
    }
  }
  dispose(): void { this.disposed = true; for (const controller of this.controllers) controller.abort(); this.controllers.clear(); }
}
