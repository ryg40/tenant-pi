import type { NextMove } from "./next-move.ts";
import type { Settings } from "./settings.ts";

export const sources = ["sys", "prompt", "assistant", "think", "tools"] as const;
export type Source = typeof sources[number];
export type Estimates = Record<Source, number>;
export type Stage = "OK" | "PLAN" | "WARN" | "CRIT" | "UNKNOWN";
export const emptyEstimates = (): Estimates => ({ sys: 0, prompt: 0, assistant: 0, think: 0, tools: 0 });
export const textTokens = (text: unknown): number => typeof text === "string" ? Math.ceil(text.length / 4) : 0;
export const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};

// Images use a fixed bounded estimate. Never tokenize image data or signatures.
export function contentTokens(content: unknown): number {
  if (typeof content === "string") return textTokens(content);
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, value) => {
    const block = record(value);
    if (["image", "image_url", "input_image"].includes(String(block.type))) return sum + 1024;
    return sum + textTokens(block.text);
  }, 0);
}
export function estimateSources(messages: readonly unknown[], systemTokens: number): Estimates {
  const result = emptyEstimates();
  result.sys = systemTokens;
  for (const value of messages) {
    const message = record(value);
    if (message.role === "system") continue; // The complete system estimate already owns this source.
    if (message.role === "bashExecution") {
      if (!message.excludeFromContext) result.tools += textTokens(message.command) + textTokens(message.output);
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const value of message.content) {
        const block = record(value);
        if (block.type === "thinking") result.think += textTokens(block.thinking);
        else if (block.type === "toolCall") {
          result.assistant += textTokens(block.name) + textTokens(JSON.stringify(block.arguments ?? {}));
        } else result.assistant += contentTokens([block]);
      }
    } else {
      const source = message.role === "toolResult" ? "tools" : message.role === "assistant" ? "assistant" : "prompt";
      result[source] += contentTokens(message.content) + textTokens(message.summary);
    }
  }
  return result;
}

/** Inspect supported serialized instruction locations, never the whole payload. */
export function providerSystemTokens(payload: unknown): number | undefined {
  const p = record(payload);
  const texts = new Set<string>(); // Do not add identical instructions from alternative provider fields twice.
  const add = (value: unknown): void => {
    if (typeof value === "string") { texts.add(value); return; }
    if (Array.isArray(value)) { for (const block of value) add(record(block).text); return; }
    const object = record(value);
    if (Array.isArray(object.parts)) add(object.parts);
  };
  let supported = false;
  for (const key of ["instructions", "system", "systemInstruction"]) {
    if (key in p) { supported = true; add(p[key]); }
  }
  const config = record(p.config);
  if ("systemInstruction" in config) { supported = true; add(config.systemInstruction); }
  for (const key of ["messages", "input"]) {
    if (!Array.isArray(p[key])) continue;
    supported = true;
    for (const value of p[key]) {
      const message = record(value);
      if (message.role === "system" || message.role === "developer") add(message.content);
    }
  }
  // A recognized Google request with no instructions means an intentionally empty prompt.
  if (Array.isArray(p.contents)) supported = true;
  return supported ? [...texts].reduce((sum, text) => sum + textTokens(text), 0) : undefined;
}

export interface Snapshot {
  model: string;
  used: number | undefined;
  window: number | undefined;
  percent: number | undefined;
  system: number | undefined;
  estimates: Estimates;
  stage: Stage;
}
export function snapshot(model: string, used: unknown, window: unknown, system: number | undefined, estimates: Estimates, settings: Settings): Snapshot {
  const u = typeof used === "number" && Number.isFinite(used) && used >= 0 ? used : undefined;
  const w = typeof window === "number" && Number.isFinite(window) && window > 0 ? window : undefined;
  const percent = u !== undefined && w !== undefined ? u / w * 100 : undefined;
  const stage = percent === undefined ? "UNKNOWN" : percent >= settings.criticalPercent ? "CRIT" :
    percent >= settings.transitionPercent ? "WARN" : percent >= settings.preparePercent ? "PLAN" : "OK";
  return { model, used: u, window: w, percent, system, estimates: { ...estimates }, stage };
}

/** Hamilton (largest-remainder) allocation with stable source-order ties. */
export function allocate(weights: readonly number[], cells: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return weights.map((_, i) => i === weights.length - 1 ? cells : 0);
  const exact = weights.map(n => n / sum * cells);
  const result = exact.map(Math.floor);
  const order = exact.map((n, i) => ({ i, remainder: n - result[i] })).sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  const remaining = cells - result.reduce((a, b) => a + b, 0);
  for (let i = 0; i < remaining; i++) result[order[i].i]++;
  return result;
}
export function reconciledWeights(s: Snapshot): number[] | undefined {
  if (s.used === undefined || s.window === undefined) return undefined;
  const used = Math.min(s.used, s.window);
  const raw = sources.map(key => s.estimates[key]);
  const total = raw.reduce((a, b) => a + b, 0);
  // Without source evidence, use prompt as an explicitly estimated residual bucket.
  return [...raw.map((n, i) => total > 0 ? n / total * used : i === 1 ? used : 0), Math.max(0, s.window - used)];
}
export const guidance: Record<Stage, string> = {
  OK: "Continue normally", PLAN: "Finish this unit; prepare a handoff",
  WARN: "Start a new session or compact", CRIT: "Stop adding large context; transition now",
  UNKNOWN: "Usage or model window unavailable",
};

/** Semantic context state for consumers. It carries every threshold decision, so consumers never recompute one. */
export interface ContextState {
  used: number | undefined;
  window: number | undefined;
  percent: number | undefined;
  stage: Stage;
  system: number | undefined;
  systemWarning: boolean;
  /** Reconciled weights in source order plus free, or undefined when usage is unknown. */
  weights: number[] | undefined;
  thresholds: { prepare: number; transition: number; critical: number };
  guidance: string;
  /** Latest decision-model suggestion, or undefined when off, pending, timed out or not confident. */
  nextMove?: NextMove;
}
export function contextState(s: Snapshot, settings: Settings, nextMove?: NextMove): ContextState {
  return {
    used: s.used, window: s.window, percent: s.percent, stage: s.stage, system: s.system,
    systemWarning: s.system !== undefined && s.system >= settings.systemPromptWarningTokens,
    weights: reconciledWeights(s),
    thresholds: { prepare: settings.preparePercent, transition: settings.transitionPercent, critical: settings.criticalPercent },
    guidance: guidance[s.stage],
    ...(nextMove ? { nextMove } : {}),
  };
}
