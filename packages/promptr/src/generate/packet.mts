/**
 * Generator packet and prompt.
 *
 * Pure module: no fs, clock or network. Builds the bounded input packet a
 * fresh generator Pi reads from disk, the fixed initial message that names
 * only paths and identifiers (task text never enters the prompt or argv),
 * and the validator that decides whether a produced file is an acceptable
 * Coordinator task prompt for the requested task.
 */
import { createHash } from "node:crypto";
import type { GeneratePromptRequest } from "../tracking/selection.mts";
import type { WorkflowExpansion } from "../tracking/workflow-port.mts";

export interface GeneratorContext {
  readonly cwd: string;
  readonly ref: string;
  readonly head: string;
  readonly dirty: boolean;
  readonly targetLabel: string;
  readonly nowIso: string;
  readonly skillPath: string;
  readonly outputPath: string;
  /** Fresh Catch-Me-Up digest, from `catchUpForPacket`; absent = old behaviour. */
  readonly catchUp?: GeneratorCatchUp;
}

/** The bounded catch-up copy a generator may read: evidence, not instructions. */
export interface GeneratorCatchUp {
  readonly generatedAt: string;
  readonly since: string;
  readonly file: string;
  readonly summary: string;
  readonly markdown: string;
}

export interface GeneratorPacket {
  readonly version: 1;
  readonly kind: "promptr-generator-packet";
  readonly requestId: string;
  readonly createdAt: string;
  readonly task: GeneratePromptRequest["task"];
  readonly workflow: WorkflowExpansion;
  readonly project: { readonly cwd: string; readonly ref: string; readonly head: string; readonly dirty: boolean };
  readonly target: { readonly label: string };
  readonly catalog: { readonly verifiedAt: string; readonly note: "static expansion; runtime availability unverified" };
  readonly output: { readonly path: string };
  readonly skill: { readonly path: string };
  /** Optional context sections; version stays 1 because absent means the old packet. */
  readonly context?: { readonly catchUp: GeneratorCatchUp };
}

/** First 16 hex of sha256 over the serialized request. Deterministic per request. */
export function requestIdOf(request: GeneratePromptRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 16);
}

export function buildGeneratorPacket(request: GeneratePromptRequest, ctx: GeneratorContext): GeneratorPacket {
  return {
    version: 1,
    kind: "promptr-generator-packet",
    requestId: requestIdOf(request),
    createdAt: ctx.nowIso,
    task: request.task,
    workflow: request.workflow,
    project: { cwd: ctx.cwd, ref: ctx.ref, head: ctx.head, dirty: ctx.dirty },
    target: { label: ctx.targetLabel },
    catalog: { verifiedAt: ctx.nowIso, note: "static expansion; runtime availability unverified" },
    output: { path: ctx.outputPath },
    skill: { path: ctx.skillPath },
    ...(ctx.catchUp === undefined ? {} : { context: { catchUp: ctx.catchUp } }),
  };
}

/** Composer contract: printable ASCII plus LF. Anything else becomes `?`. */
function asciiOnly(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a || (code >= 0x20 && code <= 0x7e)) out += ch;
    else out += "?";
  }
  return out;
}

/** The initial Pi message: fixed wording plus paths and identifiers only. */
export function buildGeneratorPrompt(packetPath: string, outputPath: string, requestId: string, taskNumber: number): string {
  return asciiOnly(
    `Promptr Generate Prompt request ${requestId} for task #${String(taskNumber)}. `
    + `Use the read tool to read the packet at ${packetPath}. `
    + "Follow the loaded promptr-generate-task-prompt skill exactly. "
    + `Write the finished Markdown with the write tool to ${outputPath} and nothing else. `
    + "Do not read other files, run commands, implement the task or launch anything. "
    + `Reply with one line: READY ${requestId} or BLOCKED ${requestId} <reason>. Then stop.`,
  );
}

export const GENERATOR_OUTPUT_LIMIT = 256 * 1024;

export type GeneratorValidation = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Accept only a Coordinator task prompt for the requested task. `requestId`
 * is part of the signature for callers but is not required inside the text.
 */
export function validateGeneratorOutput(text: string | undefined, requestId: string, taskNumber: number): GeneratorValidation {
  void requestId;
  if (text === undefined || text.trim().length === 0) return { ok: false, reason: "no output" };
  if (Buffer.byteLength(text, "utf8") > GENERATOR_OUTPUT_LIMIT) return { ok: false, reason: "output too large" };
  const first = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const trimmed = first.trimStart();
  if (trimmed.startsWith("BLOCKED")) return { ok: false, reason: "generator reported BLOCKED" };
  // Accept alternate Coordinator headings that name the requested task,
  // such as "# Coordinator Orchestration Prompt - Task #3".
  if (!/^# Coordinator\b/i.test(trimmed) || !trimmed.includes(`#${String(taskNumber)}`)) {
    return { ok: false, reason: `output is not a Coordinator task prompt for #${String(taskNumber)}` };
  }
  const normalized = asciiOnly(text.replace(/\r\n?/g, "\n"))
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .trimEnd();
  return { ok: true, text: normalized };
}
