import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBreaker, fetchNextMove, sessionState, type NextMove } from "./next-move.ts";
import { loadSettings, defaults } from "./settings.ts";
import { DECISIONS_EVENT, loadSettings as loadTenantextSettings } from "../../src/settings.ts";
import { renderMeter, formatPercent } from "./render.ts";
import { contextState, emptyEstimates, estimateSources, guidance, providerSystemTokens, snapshot, sources, textTokens, type ContextState } from "./snapshot.ts";

export interface ContextMeterService {
  render(width: number): string[];
  /** Semantic snapshot for other presenters. The footer reads this instead of computing thresholds. */
  state(): ContextState;
  report(): string;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/** Collect only on events. The factory registers hooks but performs no I/O or background work. */
export function createContextMeter(pi: ExtensionAPI): ContextMeterService {
  let settings = { ...defaults };
  let state = snapshot("unknown", undefined, undefined, undefined, emptyEstimates(), settings);
  let settingsWarning: string | undefined;
  let systemSource = "not measured";
  let requestSystem: number | undefined;
  let disposed = false;
  let nextMove: NextMove | undefined;
  // Decision-model policy: the /tenantext-decisions gate, one call in flight, and a per-endpoint cooldown after failures.
  let decisions = true;
  let inflight: AbortController | undefined;
  const breaker = createBreaker();
  const color = process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
  const listeners = new Set<() => void>();
  const unsubs: (() => void)[] = [];
  const notify = () => { for (const listener of listeners) listener(); };

  function refresh(ctx: ExtensionContext, messages?: Parameters<typeof convertToLlm>[0], resetSystem = false) {
    if (disposed) return;
    if (resetSystem) { requestSystem = undefined; systemSource = "current Pi prompt estimate"; }
    const active = messages ?? ctx.sessionManager.buildSessionProjection().messages;
    // A provider payload owns the sys estimate until a context/model boundary invalidates it.
    const system = requestSystem ?? textTokens(messages ? getCurrentSystemPrompt(convertToLlm(active)) : ctx.getSystemPrompt());
    const estimates = estimateSources(active, system);
    state = snapshot(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown", ctx.getContextUsage()?.tokens,
      ctx.model?.contextWindow, system, estimates, settings);
    notify();
  }
  unsubs.push(pi.on("session_start", (_event, ctx) => {
    const loaded = loadSettings();
    settings = loaded.settings;
    settingsWarning = loaded.warning;
    decisions = loadTenantextSettings().decisions;
    refresh(ctx, undefined, true);
  }));
  unsubs.push(pi.events.on(DECISIONS_EVENT, (value: unknown) => {
    if (!value || typeof value !== "object" || !("enabled" in value) || typeof value.enabled !== "boolean") return;
    decisions = value.enabled;
    if (decisions) return;
    inflight?.abort(); inflight = undefined; nextMove = undefined;
    notify();
  }));
  const reset = (_event: unknown, ctx: ExtensionContext) => { nextMove = undefined; refresh(ctx, undefined, true); };
  const update = (_event: unknown, ctx: ExtensionContext) => { refresh(ctx); };
  unsubs.push(pi.on("session_tree", reset), pi.on("session_compact", reset),
    pi.on("session_compact_failed", reset), pi.on("model_select", reset),
    pi.on("message_end", update), pi.on("agent_end", update), pi.on("agent_settled", update));
  // At most one decision call per finished agent run, never a retry. It never blocks rendering; a late or failed answer shows nothing.
  // A trigger while a call is in flight, or inside a failure cooldown, is dropped, so an offline endpoint sees a bounded number of calls.
  async function advise(ctx: ExtensionContext) {
    if (disposed || !decisions || inflight || !settings.nextMoveUrl || state.percent === undefined) return;
    if (!breaker.allow(settings.nextMoveUrl)) return;
    const controller = inflight = new AbortController();
    const answer = await fetchNextMove({
      url: settings.nextMoveUrl, key: process.env[settings.nextMoveKeyEnv], signal: controller.signal,
      timeoutMs: settings.nextMoveTimeoutMs, minConfidence: settings.nextMoveMinConfidence,
    }, sessionState(ctx.sessionManager.buildSessionProjection().messages, state.percent));
    if (inflight === controller) inflight = undefined;
    if (disposed || controller.signal.aborted) return;
    if (answer.failed) breaker.failure(); else breaker.success();
    nextMove = answer.move;
    notify();
  }
  unsubs.push(pi.on("agent_end", (_event, ctx) => { void advise(ctx); }));
  unsubs.push(pi.on("turn_end", (event, ctx) => { refresh(ctx, event.context.contextMessages); }));
  unsubs.push(pi.on("context_with_system", (event, ctx) => { refresh(ctx, event.messages, true); }));
  unsubs.push(pi.on("before_provider_request", (event, ctx) => {
    if (disposed) return;
    const measured = providerSystemTokens(event.payload);
    requestSystem = measured ?? textTokens(ctx.getSystemPrompt());
    systemSource = measured === undefined ? "Pi prompt fallback; unsupported provider payload" : "provider payload at this handler";
    // Preserve the request's context-hook estimates; never add payload sys to the existing sys estimate.
    const estimates = { ...state.estimates, sys: requestSystem };
    state = snapshot(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown", ctx.getContextUsage()?.tokens,
      ctx.model?.contextWindow, requestSystem, estimates, settings);
    notify();
  }));
  unsubs.push(pi.on("session_shutdown", () => { service.dispose(); }));
  const nextMoveStatus = (): string => {
    if (!settings.nextMoveUrl) return "off; nextMoveUrl is empty.";
    if (!decisions) return "off by /tenantext-decisions off.";
    const { failures, resumeAt } = breaker.state();
    if (failures === 0) return `on; endpoint answered or not yet asked; timeout ${settings.nextMoveTimeoutMs} ms.`;
    return `paused after ${failures} failed call${failures === 1 ? "" : "s"}; next try in ${Math.max(0, Math.ceil((resumeAt - Date.now()) / 1000))} s.`;
  };

  const service: ContextMeterService = {
    render: width => disposed ? [] : renderMeter(state, settings, width, { color, nextMove }),
    state: () => contextState(state, settings, nextMove),
    report() {
      const next = state.percent === undefined ? undefined :
        [settings.preparePercent, settings.transitionPercent, settings.criticalPercent].find(n => n > state.percent!);
      return [
        `Model: ${state.model}`,
        `Context window: ${state.window ?? "unknown"} tokens`,
        `Current context: ${state.used ?? "unknown"} tokens (${formatPercent(state.percent)}); Pi usage includes estimates.`,
        `Stage: ${state.stage}; next threshold: ${next === undefined ? "none or unknown" : `${next}%`}`,
        `Action: ${guidance[state.stage]}`,
        `System prompt: ${state.system ?? "unknown"} estimated tokens (${systemSource}).`,
        `System warning threshold: ${settings.systemPromptWarningTokens}; ${state.system === undefined ? "unknown" : state.system >= settings.systemPromptWarningTokens ? "SYS! reached" : "not reached"}.`,
        `Next-move chip: ${nextMoveStatus()}`,
        `Source estimates before reconciliation: ${sources.map(key => `${key}=${state.estimates[key]}`).join(", ")}.`,
        "Source proportions are estimates, scaled to Pi usage; free space uses the active model window.",
        "Text uses four characters per token. Images use 1024 tokens each, not base64 length.",
        "Tool schemas, framing, and hidden provider reasoning can change actual counts; scaling absorbs this difference.",
        "System fields replace the fallback; identical instruction text is counted once. Serialized patches count as instructions.",
        "Later provider-request handlers can replace this payload. Load the meter consumer last for the final chained payload.",
        "Forced prompts and earlier prompt patches are visible in supported payloads; unsupported payloads use Pi's prompt.",
        ...(settingsWarning ? [settingsWarning] : []),
      ].join("\n");
    },
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unsubs.splice(0)) unsubscribe();
      inflight?.abort(); inflight = undefined;
      listeners.clear();
      requestSystem = undefined;
      nextMove = undefined;
      state = snapshot("unknown", undefined, undefined, undefined, emptyEstimates(), settings);
    },
  };
  return service;
}
