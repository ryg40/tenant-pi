import { nextMoveChip } from "../context-meter/next-move.ts";
import type { ContextState } from "../context-meter/snapshot.ts";
import { freshness } from "./adapters.ts";
import type { PaintKind } from "./paint.ts";
import type { Settings } from "./settings.ts";
import type { DashboardSnapshot, GitSnapshot, IntegrationSnapshot, LimitsSnapshot, SessionSnapshot, StatusState } from "./types.ts";

/**
 * Pure view model. It decides severity, priority, visibility, and wording.
 * It holds no ANSI, no widths, and no colors. render.ts turns it into rows.
 */
export type AlertKind = "error" | "warning" | "accent";
export interface Alert { key: string; text: string; compact: string; glyph: string; kind: AlertKind }
export interface Group extends Alert { alert: boolean }
export interface MemoryGroup extends Group { minimal: string }
export type QuotaLevel = "normal" | "low" | "exhausted" | "unavailable";
export interface QuotaWindow { name: string; percent?: number; level: QuotaLevel; resetsAt?: number; alert?: Alert }
export interface QuotaAccount { label: string; short: string; state: StatusState; windows: QuotaWindow[]; alert?: Alert; /** `false`: configured, no login. Dim text, no alert. */ login?: false }
export interface QuotaView {
  accounts: QuotaAccount[]; route?: { text: string; kind: PaintKind; alert?: Alert; selected?: string }; stale: boolean; alerts: Alert[];
  /** The count of accounts that the row budget dropped. The last quota row shows it as a dim `+N`. */
  more?: number;
}
export interface View {
  context: { stage?: string; kind: PaintKind; totals?: string; percent: string; sys?: string; next?: string };
  repo: { name?: string; branch?: string; facts: string[]; compactFacts: string[]; worktrees?: string; pwd: string; cwd?: string; error?: Alert };
  model: { tokens?: string; provider: string; model: string; thinking?: string; state: { text: string; kind: PaintKind; alert?: Alert }; queued: boolean; duration?: string; session?: string; host?: string };
  quota?: QuotaView;
  services: Group[];
  memory: MemoryGroup[];
  /** Every actionable alert in priority order. Keys drive decay; glyphs drive the narrow layout. */
  alerts: Alert[];
}

export const LOW_PERCENT = 25;
export const EXHAUSTED_PERCENT = 10;

export const tokens = (n: number): string => n < 1000 ? `${Math.round(n)}` : n < 100_000 ? `${(n / 1000).toFixed(1)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`;
export const percent = (n: number): string => `${Math.round(n)}%`;

/** Relative duration: `35m`, `2h 47m`, `5d 7h`. */
export function formatRelative(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return "<1m";
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}
/** Friendly absolute time in the local zone: `Tue 9/22 · 09:46 UTC`. Never raw ISO. */
export function formatWhen(epoch: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short", ...(timeZone ? { timeZone } : {}) }).formatToParts(new Date(epoch));
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("month")}/${get("day")} · ${get("hour")}:${get("minute")} ${get("timeZoneName")}`.trim();
}

export function agentState(s: SessionSnapshot): { text: string; kind: PaintKind; alert?: Alert } {
  switch (s.state) {
    case "waiting": return { text: "⌨ input needed", kind: "warning", alert: { key: "agent:waiting", text: "⌨ input needed", compact: "⌨ input", glyph: "⌨", kind: "warning" } };
    case "failed": return { text: "✗ model error", kind: "error", alert: { key: "agent:failed", text: "✗ model error", compact: "✗ model", glyph: "✗", kind: "error" } };
    case "working": return { text: "working", kind: "accent" };
    case "compacting": return { text: "compacting", kind: "accent" };
    case "retrying": return { text: "retrying", kind: "accent" };
    default: return { text: "idle", kind: "dim" };
  }
}
/** Non-zero Git counters in words. Zero counters stay hidden. */
export function gitFacts(git: GitSnapshot): string[] {
  const facts: string[] = [];
  if (git.staged) facts.push(`${git.staged} staged`);
  if (git.unstaged) facts.push(`${git.unstaged} modified`);
  if (git.untracked) facts.push(`${git.untracked} untracked`);
  if (git.ahead) facts.push(`ahead ${git.ahead}`);
  if (git.behind) facts.push(`behind ${git.behind}`);
  return facts;
}
/** Narrow form: one change total plus divergence. */
export function compactGitFacts(git: GitSnapshot): string[] {
  const changed = (git.staged ?? 0) + (git.unstaged ?? 0) + (git.untracked ?? 0);
  return [changed ? `${changed} changed` : "", git.ahead ? `ahead ${git.ahead}` : "", git.behind ? `behind ${git.behind}` : ""].filter(Boolean);
}
/** The cwd appears once, only when it differs from the session start directory, and never as a repeated absolute path. */
export function cwdLabel(cwd: string, startedIn: string, root?: string, home = process.env.HOME): string | undefined {
  if (!cwd || cwd === startedIn) return;
  const under = (base?: string) => Boolean(base) && (cwd === base || cwd.startsWith(`${base}/`));
  if (under(root)) return cwd === root ? "cwd ./" : `cwd ./${cwd.slice(root!.length + 1)}`;
  if (under(home)) return `cwd ~${cwd.slice(home!.length)}`;
  return `cwd ${cwd}`;
}
/**
 * Codex accounts, the Claude account and the Copilot account as one quota group in identity order.
 * The route belongs to Codex; staleness to whichever source is stale.
 */
export function combinedLimits(data: DashboardSnapshot, now: number): LimitsSnapshot | undefined {
  const codex = data.limits;
  const sources = [codex, data.anthropic, data.copilot].filter((s): s is LimitsSnapshot => s !== undefined);
  if (sources.length < 2) return sources[0];
  const base = sources[0];
  // A later stale source wins, so a stale Copilot or Claude reading marks the group.
  const stale = sources.slice(1).reverse().find(s => freshness(s, now) === "stale") ?? base;
  const rank = (s: StatusState) => ({ ok: 0, unknown: 1, warning: 2, error: 3 })[s];
  const state = sources.reduce<StatusState>((worst, s) => rank(s.state) > rank(worst) ? s.state : worst, base.state);
  return { ...base, state, route: codex?.route ?? { state: "unknown" }, checkedAt: stale.checkedAt, staleAfter: stale.staleAfter,
    accounts: sources.flatMap(s => s.accounts).sort((a, b) => a.order - b.order) };
}
/** A Codex account label is `Codex` or `Codex<N>`. The route and the Codex tail never go to another provider's row. */
export const isCodexLabel = (label: string): boolean => /^Codex\d*\s*$/.test(label);
const shortLabel = (label: string): string => label === "Copilot" ? "CP" : label === "Claude" ? "CL" : label.replace(/^Codex/, "C");
const windowName = (name: string): string => ({ weekly: "week", daily: "24h" })[name] ?? name;
export function quotaView(limits: LimitsSnapshot, now: number): QuotaView {
  const alerts: Alert[] = [];
  const accounts: QuotaAccount[] = limits.accounts.map(account => {
    const short = shortLabel(account.label);
    const windows: QuotaWindow[] = account.windows.map(w => {
      const name = windowName(w.name);
      if (w.unavailable || w.percent === undefined) return { name, level: "unavailable" };
      const level: QuotaLevel = w.percent <= EXHAUSTED_PERCENT ? "exhausted" : w.percent <= LOW_PERCENT ? "low" : "normal";
      const alert = level === "normal" ? undefined : {
        key: `quota:${account.label}:${name}:${level}`, kind: level === "exhausted" ? "error" as const : "warning" as const,
        glyph: level === "exhausted" ? "✗" : "⚠", text: `${account.label} ${name} ${percent(w.percent)}`, compact: `${short} ${name} ${percent(w.percent)}`,
      };
      if (alert) alerts.push(alert);
      return { name, percent: w.percent, level, resetsAt: w.resetsAt, alert };
    });
    const alert = account.state === "error" ? { key: `quota:${account.label}:error`, kind: "error" as const, glyph: "✗", text: `${account.label} ✗ error`, compact: `${short} ✗` } : undefined;
    if (alert) alerts.unshift(alert);
    return { label: account.label, short, state: account.state, windows, alert, ...(account.login === false ? { login: false as const } : {}) };
  });
  let route: QuotaView["route"];
  if (limits.route.state === "error") {
    const alert: Alert = { key: "route:error", kind: "error", glyph: "✗", text: "route ✗", compact: "route ✗" };
    alerts.push(alert); route = { text: alert.text, kind: "error", alert };
  } else if (limits.route.selected) route = { text: `→ ${limits.route.selected}`, kind: "dim", selected: limits.route.selected };
  return { accounts, route, stale: freshness(limits, now) === "stale", alerts };
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
function serviceGroup(s: IntegrationSnapshot, settings: Settings, now: number): Group[] {
  const stale = freshness(s, now) === "stale";
  const out: Group[] = [];
  const push = (key: string, text: string, compact: string, glyph: string, kind: AlertKind, alert = true) => out.push({ key, text, compact, glyph, kind, alert });
  if (s.source === "work") {
    if (s.blocked) push(`blocked:${s.blocked}`, `⛔ ${s.blocked} blocked`, `⛔ ${s.blocked}`, "⛔", "error");
    if (s.prompts) push(`prompts:${s.prompts}`, `⏳ ${plural(s.prompts, "prompt")}`, `⏳ ${s.prompts}`, "⏳", "warning");
    if (s.background) push(`background:${s.background}`, `⚠ ${s.background} background`, `⚠ ${s.background}`, "⚠", "warning");
    if (s.review) push("review", "⚑ REVIEW", "⚑ REVIEW", "⚑", "warning");
    if (s.deploy) push("deploy", "⚑ DEPLOY", "⚑ DEPLOY", "⚑", "warning");
    if (s.dirty) push(`dirty:${s.dirty}`, `${s.dirty} dirty`, `${s.dirty} dirty`, "", "accent", false);
    if (s.state === "error") push("work:error", "work ✗", "work ✗", "✗", "error");
    else if (stale) push("work:stale", "work ⚠ stale", "work ⚠", "⚠", "warning");
    return out;
  }
  if (s.source === "MCP") {
    const counts = s.configured !== undefined ? `${s.active ?? "?"}/${s.configured}` : "";
    if (s.failed) push("mcp:failed", `MCP ${counts} ✗${s.failedNames?.length ? ` ${s.failedNames.join(", ")}` : ""}`.replace(/\s+/g, " "), `MCP ✗`, "✗", "error");
    else if (s.configured !== undefined && (s.active ?? 0) < s.configured) push("mcp:connecting", `MCP ${counts} connecting`, `MCP ${counts}`, "⏳", "warning");
    else if (s.state === "error") push("mcp:error", "MCP ✗", "MCP ✗", "✗", "error");
    else if (stale) push("mcp:stale", "MCP ⚠ stale", "MCP ⚠", "⚠", "warning");
    else if (s.state === "ok" && settings.showHealthyServices) push("mcp:ok", `MCP ${counts} ✓`.replace(/\s+/g, " "), "MCP ✓", "✓", "accent", false);
    return out;
  }
  if (s.state === "error") push(`${s.source}:error`, `${s.source} ✗ unavailable`, `${s.source} ✗`, "✗", "error");
  else if (stale && s.state !== "unknown") push(`${s.source}:stale`, `${s.source} ⚠ stale`, `${s.source} ⚠`, "⚠", "warning");
  else if (s.state === "unknown") { if (settings.showUnavailableOptionalSources) push(`${s.source}:unknown`, `${s.source} · n/a`, `${s.source} n/a`, "", "accent", false); }
  else if (s.source === "Wiki" && s.index === "building") push("wiki:building", "Wiki index building", "Wiki building", "", "accent", false);
  else if (settings.showHealthyServices) push(`${s.source}:ok`, `${s.source} ✓`, `${s.source} ✓`, "✓", "accent", false);
  return out;
}
/** Small colored groups for row 4. Healthy, zero-value, and implementation facts stay in the report. */
export function serviceGroups(data: DashboardSnapshot, settings: Settings, now: number): Group[] {
  const order = ["work", "OK", "OV", "MCP", "Hermes", "Wiki"];
  const sorted = data.integrations.filter(s => !(s.source === "OV" && data.memory?.ov) && !(s.source === "Wiki" && data.memory?.wiki))
    .sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
  const groups = sorted.flatMap(s => serviceGroup(s, settings, now));
  const flagged = /([1-9][0-9]*) flagged/.exec(data.languageStatus ?? "");
  if (flagged) groups.push({ key: `ste:${flagged[1]}`, text: `STE ${flagged[1]} flagged`, compact: `STE ${flagged[1]}`, glyph: "⚑", kind: "warning", alert: true });
  if (data.conflict) groups.push({ key: "conflict", text: "⚠ footer conflict", compact: "⚠ footer", glyph: "⚠", kind: "warning", alert: true });
  // Actionable groups first: blocked and failures, then waiting work, then quiet facts.
  const rank = (g: Group) => g.alert ? (g.kind === "error" ? 0 : 1) : 2;
  return groups.sort((a, b) => rank(a) - rank(b));
}
export function memoryGroups(data: DashboardSnapshot, now: number): MemoryGroup[] {
  const rows: MemoryGroup[] = [];
  const activity = (m: { running: string[]; last?: string; failed?: boolean }): string => m.running.length
    ? `${m.running[0]}${m.running.length > 1 ? ` +${m.running.length - 1}` : ""} running`
    : m.last ? `${m.last} ${m.failed ? "failed" : "returned"}` : "idle";
  const ov = data.memory?.ov;
  if (ov) {
    const health = data.integrations.find(s => s.source === "OV");
    const stale = health && freshness(health, now) === "stale";
    const status = health?.state === "error" ? "unavailable" : stale ? "stale" : health?.state === "warning" ? "warning" : health?.state === "ok" ? "connected" : "unknown";
    const alert = status === "unavailable" || status === "stale" || status === "warning" || Boolean(ov.failed);
    const glyph = status === "unavailable" || ov.failed ? "✗" : status === "stale" || status === "warning" ? "⚠" : status === "connected" ? "✓" : "?";
    const counts = ov.pendingTokens !== undefined ? `pending ${tokens(ov.pendingTokens)}/${tokens(ov.threshold ?? 0)}`
      : ov.added !== undefined ? `synced ${ov.added}` : undefined;
    rows.push({ key: `memory:ov:${status}:${Boolean(ov.failed)}`, text: [`OpenViking ${glyph} ${status}`, activity(ov), counts].filter(Boolean).join(" · "),
      compact: `OV ${glyph} ${status} · ${activity(ov)}`, minimal: `OV ${glyph} ${status}`, glyph, alert,
      kind: status === "unavailable" || ov.failed ? "error" : stale || status === "warning" ? "warning" : "accent" });
  }
  const wiki = data.memory?.wiki;
  if (wiki) {
    const model = wiki.sessionModel ? data.session.model : wiki.model;
    const modelText = model ?? "model unknown";
    const shortModel = model?.split("/").at(-1) ?? modelText;
    const published = data.integrations.find(s => s.source === "Wiki");
    const hasPublishedState = published && published.state !== "unknown";
    const state = hasPublishedState ? published.state : wiki.state;
    const stale = hasPublishedState && freshness(published, now) === "stale";
    const status = state === "error" ? "blocked" : stale ? "stale" : state === "warning" ? "warning" : state === "ok" ? "active" : "status unknown";
    const hint = wiki.suggestCapture ? "suggest wiki_retro" : undefined;
    const action = wiki.running.length || wiki.last ? activity(wiki) : published?.index === "building" ? "index building"
      : wiki.recalled !== undefined ? `recalled ${wiki.recalled}` : undefined;
    const error = state === "error" || Boolean(wiki.failed);
    const alert = error || Boolean(stale) || state === "warning";
    const glyph = error ? "✗" : alert ? "⚠" : "";
    const prefix = `LLM Wiki${glyph ? ` ${glyph}` : ""}`;
    rows.push({ key: `memory:wiki:${status}:${Boolean(wiki.failed)}`, text: [prefix, status, modelText, action, hint].filter(Boolean).join(" · "),
      compact: [prefix, shortModel, alert ? (wiki.failed ? "tool failed" : status) : undefined, hint ?? action].filter(Boolean).join(" · "),
      minimal: [prefix, shortModel, alert ? (wiki.failed ? "tool failed" : status) : undefined, hint].filter(Boolean).join(" · "), glyph, alert, kind: error ? "error" : alert ? "warning" : "accent" });
  }
  return rows;
}
export function buildView(data: DashboardSnapshot, ctx: ContextState, settings: Settings, now: number): View {
  const s = data.session, git = data.git;
  const state = agentState(s);
  const usage = [s.input ? `↑${tokens(s.input)}` : "", s.output ? `↓${tokens(s.output)}` : "", s.cacheRead ? `R${tokens(s.cacheRead)}` : "", s.cost ? `$${s.cost.toFixed(3)}` : ""].filter(Boolean).join(" ");
  const minutes = now - s.startedAt;
  const repoError = git.state === "error" ? { key: "git:error", kind: "error" as const, glyph: "✗", text: `git ✗ ${git.summary}`, compact: "git ✗" } : undefined;
  const view: View = {
    context: {
      stage: ctx.stage === "OK" || ctx.stage === "UNKNOWN" ? undefined : ctx.stage,
      kind: ctx.stage === "CRIT" ? "error" : ctx.stage === "WARN" ? "warning" : ctx.stage === "PLAN" ? "accent" : "muted",
      totals: ctx.used !== undefined && ctx.window !== undefined ? `${tokens(ctx.used)}/${tokens(ctx.window)}` : undefined,
      percent: ctx.percent === undefined ? "?%" : percent(ctx.percent),
      sys: ctx.systemWarning && ctx.system !== undefined ? `sys ${tokens(ctx.system)}!` : undefined,
      next: ctx.nextMove ? nextMoveChip(ctx.nextMove) : undefined,
    },
    repo: {
      name: git.repo, branch: git.branch, facts: git.repo ? gitFacts(git) : [], compactFacts: git.repo ? compactGitFacts(git) : [],
      worktrees: (git.worktrees ?? 0) > 1 ? `${git.worktrees} worktrees` : undefined,
      pwd: `pwd ${s.startedIn || s.cwd}`, cwd: cwdLabel(s.cwd, s.startedIn, git.worktree), error: repoError,
    },
    model: {
      tokens: usage || undefined, provider: s.provider, model: s.model, thinking: s.thinking && s.thinking !== "off" ? s.thinking : undefined,
      state: { text: state.text, kind: state.kind, alert: state.alert }, queued: s.pending && s.state !== "waiting",
      duration: minutes >= 60000 ? formatRelative(minutes) : undefined,
      session: s.session && s.session !== "unnamed" ? s.session : undefined, host: s.remote ? s.hostname : undefined,
    },
    quota: (() => { const limits = combinedLimits(data, now); return limits ? quotaView(limits, now) : undefined; })(),
    services: serviceGroups(data, settings, now),
    memory: memoryGroups(data, now),
    alerts: [],
  };
  const services = [...view.services, ...view.memory].filter(g => g.alert);
  view.alerts = [
    ...(state.alert ? [state.alert] : []),
    ...services.filter(g => g.kind === "error"),
    ...services.filter(g => g.kind !== "error"),
    ...(view.quota?.alerts ?? []),
    ...(repoError ? [repoError] : []),
  ];
  return view;
}
