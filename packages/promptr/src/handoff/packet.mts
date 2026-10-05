/**
 * /handoffr v2 packet helpers. Pure: no fs, env, clock or exec.
 *
 * The running Coordinator authors the handoff from its own context following
 * the packaged `promptr-handoff` skill. The extension supplies an evidence
 * file (everything it can observe deterministically), a short author prompt
 * that names only paths, a validator for the produced document, and the
 * successor naming/prompt helpers used by `launch.mts`.
 */
import { createHash } from "node:crypto";
import type { ProgressEntry } from "../progress/tracker.mts";
import { validateBriefing } from "../briefing/openknowledge.mts";

export interface HandoffRuntime { provider: string; model: string; thinking: string }
export type HandoffRuntimeSource = "ctx" | "env";
export interface ResolvedHandoffRuntime extends HandoffRuntime { source: HandoffRuntimeSource }

/**
 * Same-model resolution: ctx.model + thinking first, else PI_PROVIDER/PI_MODEL/
 * PI_REASONING_LEVEL. All three parts required; a partial triple is refused
 * (undefined). Never substitutes a default model.
 */
export function resolveHandoffRuntime(input: {
  model?: { provider?: unknown; id?: unknown } | undefined;
  thinkingLevel?: unknown;
  env: Readonly<Record<string, string | undefined>>;
}): ResolvedHandoffRuntime | undefined {
  const provider = str(input.model?.provider);
  const model = str(input.model?.id);
  const thinking = str(input.thinkingLevel);
  if (provider && model && thinking) return { provider, model, thinking, source: "ctx" };
  const ep = str(input.env.PI_PROVIDER);
  const em = str(input.env.PI_MODEL);
  const et = str(input.env.PI_REASONING_LEVEL);
  if (ep && em && et) return { provider: ep, model: em, thinking: et, source: "env" };
  return undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function runtimeTriple(runtime: HandoffRuntime): string {
  return `${runtime.provider}/${runtime.model}:${runtime.thinking}`;
}

/** The ten required `## ` headings of a handoff document, in order. */
export const HANDOFF_HEADINGS: readonly string[] = [
  "Runtime and evidence",
  "Objective and user directives",
  "Done this session",
  "In progress and not started",
  "Decisions and rationale",
  "Open questions and blockers",
  "Active resources",
  "Do not repeat",
  "Queued prompts carried over",
  "How to continue",
];

export const HANDOFF_TITLE_PREFIX = "# Promptr handoff";
export const HANDOFF_MAX_BYTES = 64 * 1024;

export interface HandoffEvidenceInput {
  slug: string;
  cwd: string;
  ref: string;
  head: string;
  dirty: boolean;
  changed: string[];
  progress: ProgressEntry[];
  queueTexts: string[];
  runtime: ResolvedHandoffRuntime | undefined;
  sessionFile: string;
  sessionId: string;
  observedTokens: number | undefined;
  focus?: string | undefined;
  at: string; // ISO timestamp supplied by the caller
}

/** Deterministic evidence file the Coordinator reads before authoring the handoff. */
export function buildHandoffEvidence(input: HandoffEvidenceInput): string {
  const lines: string[] = [];
  lines.push(`# Promptr handoff evidence - ${input.slug} - ${input.at}`);
  lines.push("");
  lines.push("Facts observed by the Promptr extension. Copy them into `## Runtime and evidence`; do not infer beyond them.");
  lines.push("");
  lines.push("## Runtime");
  if (input.runtime) {
    lines.push(`- provider: \`${input.runtime.provider}\``);
    lines.push(`- model: \`${input.runtime.model}\``);
    lines.push(`- thinking: \`${input.runtime.thinking}\``);
    lines.push(`- runtime source: ${input.runtime.source}`);
  } else {
    lines.push("- runtime: UNKNOWN (no provider/model/thinking triple resolved; successor launch will be refused)");
  }
  lines.push(`- session file: \`${input.sessionFile || "UNKNOWN"}\``);
  lines.push(`- session id: \`${input.sessionId || "UNKNOWN"}\``);
  lines.push(`- observed context tokens: ${input.observedTokens === undefined ? "UNKNOWN" : String(input.observedTokens)}`);
  lines.push("");
  lines.push("## Project");
  lines.push(`- cwd: \`${input.cwd}\``);
  lines.push(`- ref: \`${input.ref || "unknown"}\``);
  lines.push(`- head: \`${input.head}\``);
  lines.push(`- dirty: ${input.dirty ? "yes" : "no"}`);
  lines.push(`- changed paths: ${input.changed.length === 0 ? "none" : input.changed.slice(0, 40).map((c) => `\`${c}\``).join(", ")}`);
  lines.push("");
  if (input.focus?.trim()) {
    lines.push("## Focus");
    lines.push(input.focus.trim().slice(0, 2000));
    lines.push("");
  }
  lines.push("## Checkpoints (last 8)");
  const recent = input.progress.slice(-8);
  if (recent.length === 0) lines.push("No checkpoints recorded.");
  for (const e of recent) {
    lines.push(`### ${e.at} (${e.id}) - ${e.ref || "?"} @ ${e.head}${e.dirty ? " dirty" : ""}`);
    lines.push(e.text);
    lines.push("");
  }
  lines.push("");
  lines.push(`## Queued prompts (${input.queueTexts.length})`);
  if (input.queueTexts.length === 0) lines.push("None.");
  input.queueTexts.slice(0, 10).forEach((q, i) => {
    lines.push(`### Queued ${i + 1}`);
    lines.push(q.slice(0, 3000));
    lines.push("");
  });
  return lines.join("\n");
}

/** ASCII prompt naming only paths and the handoff name; never content. */
export function buildHandoffAuthorPrompt(evidencePath: string, handoffPath: string, name: string, skillPath?: string): string {
  return [
    `Promptr handoff request \`${name}\`.`,
    skillPath ? `Read and follow the packaged skill at \`${skillPath}\` with the read tool; do not substitute another handoff skill.` : "Load and follow the `promptr-handoff` skill.",
    `Read \`${evidencePath}\` with the read tool.`,
    `Write the handoff with the write tool to \`${handoffPath}\` and nothing else.`,
    "Do not start new work, send, launch or edit anything else.",
    `Reply \`HANDOFF READY ${name}\` or \`HANDOFF BLOCKED ${name} <reason>\`, then stop.`,
  ].join(" ");
}

/** ASCII first message for the successor: fixed text plus paths. */
export function buildSuccessorPrompt(name: string, handoffPath: string, sessionFile: string): string {
  return [
    `Promptr handoff \`${name}\`.`,
    `Read \`${handoffPath}\` with the read tool and follow its \`How to continue\` section.`,
    "First verify `git status --short --branch` and `git log --oneline -5` and say whether HEAD moved.",
    `The previous session \`${sessionFile || "UNKNOWN"}\` is read-only from now on; do not send to it.`,
  ].join(" ");
}

export type HandoffValidation = { ok: true } | { ok: false; reason: string };

/** Structural validation of an authored handoff document. */
export function validateHandoff(text: unknown): HandoffValidation {
  if (typeof text !== "string" || text.trim().length === 0) return { ok: false, reason: "handoff file is missing or empty" };
  if (Buffer.byteLength(text, "utf8") > HANDOFF_MAX_BYTES) return { ok: false, reason: `handoff exceeds ${HANDOFF_MAX_BYTES} bytes` };
  try { validateBriefing(text); } catch { return { ok: false, reason: "handoff contains terminal control characters" }; }
  const lines = text.split("\n");
  const first = lines.find((l) => l.trim().length > 0) ?? "";
  if (!first.startsWith(HANDOFF_TITLE_PREFIX)) return { ok: false, reason: `first line must start with "${HANDOFF_TITLE_PREFIX}"` };
  const headings = lines.filter((l) => /^## /.test(l)).map((l) => l.slice(3).trim());
  let cursor = 0;
  for (const required of HANDOFF_HEADINGS) {
    const at = headings.indexOf(required, cursor);
    if (at === -1) {
      const anywhere = headings.includes(required);
      return { ok: false, reason: anywhere ? `heading "${required}" is out of order` : `missing heading "${required}"` };
    }
    cursor = at + 1;
  }
  const last = HANDOFF_HEADINGS[HANDOFF_HEADINGS.length - 1] as string;
  const start = lines.findIndex((l) => l.trim() === `## ${last}`);
  const body = lines.slice(start + 1).filter((l) => l.trim().length > 0 && !/^## /.test(l));
  if (body.length === 0) return { ok: false, reason: `"${last}" section is empty` };
  return { ok: true };
}

/** Herdr agent name: `promptr-hand-<8 hex sha256(text)>-<hhmmss>`, <=32 chars, lowercase. */
export function successorName(handoffText: string, at: Date): string {
  const hash = createHash("sha256").update(handoffText).digest("hex").slice(0, 8);
  const hhmmss = at.toISOString().slice(11, 19).replace(/:/g, "");
  return `promptr-hand-${hash}-${hhmmss}`.toLowerCase().slice(0, 32);
}

/** ASCII tab label (the design's middle-dot separators are replaced so argv stays ASCII). */
export function successorLabel(slug: string, at: Date): string {
  const hhmm = at.toISOString().slice(11, 16).replace(":", "");
  return `Promptr handoff - ${slug.replace(/[^\x20-\x7e]/g, "?")} - ${hhmm}`;
}

/** Marker line prepended to the OpenKnowledge history block so Catch-Me-Up can find handoffs. */
export function handoffSyncMarker(name: string, iso: string, runtime: HandoffRuntime | undefined): string {
  return `<!-- promptr:handoff ${name} ${iso} ${runtime ? runtimeTriple(runtime) : "UNKNOWN"} -->`;
}

export type HandoffReceiptState = "requested" | "finishing" | "invalid" | "saved" | "launched";

export interface HandoffReceipt {
  version: 1;
  name: string;
  state: HandoffReceiptState;
  sessionId: string;
  leafId: string;
  requestedAt: string;
  /** Absolute path of the evidence file. */
  evidence: string;
  /** Absolute path the Coordinator must write. */
  target: string;
  runtime?: ResolvedHandoffRuntime;
  observedTokens?: number;
  automatic?: boolean;
  reason?: string;
  sync?: string;
  writtenAt?: string;
  bytes?: number;
  launch?: "launched" | "uncertain" | "refused";
  successor?: { workspace: string; pane: string; agentName: string; label: string; successorSession?: string; promptedAt: string };
}

export function parseReceipt(raw: unknown): HandoffReceipt | undefined {
  if (typeof raw !== "string") return undefined;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return undefined; }
  if (!data || typeof data !== "object") return undefined;
  const r = data as Record<string, unknown>;
  const states: readonly string[] = ["requested", "finishing", "invalid", "saved", "launched"];
  if (r.version !== 1 || typeof r.name !== "string" || typeof r.state !== "string" || !states.includes(r.state)
    || typeof r.sessionId !== "string" || typeof r.leafId !== "string" || typeof r.requestedAt !== "string"
    || typeof r.evidence !== "string" || typeof r.target !== "string") return undefined;
  return data as HandoffReceipt;
}
