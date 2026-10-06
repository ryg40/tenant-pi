import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import {
  buildInteractiveStartArgs, buildPromptArgs, buildTabCreateArgs, buildWaitArgs,
  matchesAgentIdentity, parseAgent, parseHerdrResult, parseTabCreate, type HerdrRuntime,
} from "./adapter.mts";
import { isHerdrWorkspaceId } from "./identity.mts";
import { herdrRoleNameFromList, type HerdrRole } from "./naming.mts";
import { createRunReceiptDir, readBoundedFile, runReceiptDir, writeRunReceipt } from "../state/run-receipts.mts";

const execute = promisify(execFile);
const MAX_REPORT = 32 * 1024;
const MARKER = "ROLE_HANDOFF_COMPLETE";
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface RoleHandoffDeps {
  /** Must enforce its own wall-clock deadline and output bound. */
  exec: (args: string[]) => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
const defaults: RoleHandoffDeps = {
  exec: async args => (await execute("herdr", args, {
    timeout: args[1] === "start" ? 70_000 : args[1] === "get" ? 5000 : 15_000,
    maxBuffer: 1024 * 1024,
  })).stdout,
  now: Date.now,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

export interface RoleHandoffInput {
  explicitlyRequested: true;
  runId: string;
  packetPath: string;
  taskRef: string;
  workspace: string;
  cwd: string;
  role: HerdrRole;
  runtime: HerdrRuntime & { harness: "pi" };
}

export interface RunReceipt {
  version: 1;
  runId: string;
  packetHash: string;
  taskRef: string;
  role: HerdrRole;
  cwd: string;
  runtime: RoleHandoffInput["runtime"];
  owner: string;
  reportPath: string;
  completionMarker: string;
  attemptedAt: number;
  promptAt?: number;
  pane?: string;
  harnessSession?: string;
  terminal?: string;
  outcome: "attempted" | "submitted" | "uncertain" | "failed-before-send";
  stage: "tab" | "start" | "ready" | "prompt";
}

/** One explicitly requested visible Pi role. Every failure leaves its pane open. */
export async function startRoleHandoff(input: RoleHandoffInput, deps: RoleHandoffDeps = defaults): Promise<RunReceipt> {
  if (input.explicitlyRequested !== true || input.runtime.harness !== "pi"
    || !isHerdrWorkspaceId(input.workspace) || !path.isAbsolute(input.cwd) || !path.isAbsolute(input.packetPath)
    || !["coordinator", "researcher", "planner", "reviewer", "worker", "generator"].includes(input.role)
    || !/^[a-zA-Z0-9._/-]{1,160}$/.test(input.taskRef)
    || !/^[a-zA-Z0-9._-]{1,100}$/.test(input.runtime.provider)
    || !/^[a-zA-Z0-9._/:-]{1,160}$/.test(input.runtime.model)
    || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(input.runtime.thinking)) {
    throw new Error("Explicit role, exact Pi runtime, task reference and absolute paths required");
  }
  const packet = readBoundedFile(input.packetPath, 256 * 1024);
  if (!packet.text.trim()) throw new Error("Packet is empty");
  const dir = createRunReceiptDir(input.runId);
  const receipt: RunReceipt = {
    version: 1, runId: input.runId, packetHash: hash(packet.text), taskRef: input.taskRef,
    role: input.role, cwd: input.cwd,
    runtime: { harness: "pi", provider: input.runtime.provider, model: input.runtime.model, thinking: input.runtime.thinking },
    owner: `promptr-${input.role.slice(0, 5)}-${hash(input.runId).slice(0, 12)}`,
    reportPath: path.join(dir, "report.json"), completionMarker: `${MARKER}:${randomUUID()}`,
    attemptedAt: deps.now(), outcome: "attempted", stage: "tab",
  };
  writeRunReceipt(dir, "attempted.json", receipt);
  let sendAttempted = false;
  try {
    let workspaces: string | undefined;
    try { workspaces = await deps.exec(["workspace", "list"]); } catch { /* opaque label fallback */ }
    const label = herdrRoleNameFromList(input.workspace, input.role, workspaces);
    const pane = parseTabCreate(await deps.exec(buildTabCreateArgs(input.workspace, input.cwd, label)), input.workspace);
    if (!pane) throw new Error("Tab identity unavailable");
    receipt.pane = pane;
    receipt.stage = "start";
    writeRunReceipt(dir, "pane.json", receipt);
    await deps.exec(buildInteractiveStartArgs(receipt.owner, pane, input.runtime));
    receipt.stage = "ready";
    const readyDeadline = deps.now() + 60_000;
    // A fixed count also bounds an injected clock that does not advance.
    for (let attempt = 0; attempt < 30 && deps.now() <= readyDeadline; attempt++) {
      let agent;
      try { agent = parseAgent(await deps.exec(["agent", "get", pane])); } catch { agent = undefined; }
      if (matchesAgentIdentity(agent, { pane, cwd: input.cwd, foreground: true, name: receipt.owner })
        && (agent?.agent_status === "idle" || agent?.agent_status === "done")
        && typeof agent.agent_session?.value === "string" && agent.agent_session.value.length > 0
        && typeof agent.terminal_id === "string" && agent.terminal_id.length > 0) {
        receipt.harnessSession = agent.agent_session.value;
        receipt.terminal = agent.terminal_id;
        break;
      }
      if (agent?.agent_status === "blocked") break;
      if (attempt < 29) await deps.sleep(2000);
    }
    if (!receipt.harnessSession) throw new Error("Session identity unavailable");
    if (hash(readBoundedFile(input.packetPath, 256 * 1024).text) !== receipt.packetHash) throw new Error("Packet changed");
    receipt.stage = "prompt";
    receipt.promptAt = deps.now();
    // This file fences a lost acknowledgement. Reopening never replays the send.
    writeRunReceipt(dir, "prompt-attempted.json", receipt);
    const prompt = `Act as the explicitly requested ${input.role}. Read the coordinator packet at ${JSON.stringify(input.packetPath)}.\n`
      + `Keep this full interactive session open. Do not claim correctness from a report shape.\n`
      + `When complete, write one JSON report at ${JSON.stringify(receipt.reportPath)} with these fields:\n`
      + JSON.stringify({ runId: input.runId, packetHash: receipt.packetHash, session: receipt.harnessSession,
        completedAt: "ISO timestamp when the report is written", marker: receipt.completionMarker, report: "bounded result, at most 24000 characters" });
    const args = buildPromptArgs(pane, prompt);
    sendAttempted = true;
    const response = await deps.exec(args);
    const agent = parseAgent(response);
    receipt.outcome = parseHerdrResult(response)?.type === "agent_prompted" && matchesReceipt(agent, receipt)
      ? "submitted" : "uncertain";
  } catch {
    // No raw error text: it can contain packet text, environment values or CLI output.
    receipt.outcome = sendAttempted ? "uncertain" : "failed-before-send";
  }
  writeRunReceipt(dir, "launch.json", receipt);
  return receipt;
}

function matchesReceipt(agent: ReturnType<typeof parseAgent>, receipt: RunReceipt): boolean {
  return !!receipt.pane && !!receipt.harnessSession && !!receipt.terminal
    && matchesAgentIdentity(agent, { pane: receipt.pane, cwd: receipt.cwd, session: receipt.harnessSession,
      terminal: receipt.terminal, name: receipt.owner, foreground: true });
}

export type CollectionResult =
  | { outcome: "collected"; report: string; reportHash: string }
  | { outcome: "rejected"; reason: string; reportHash?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunReceipt(value: unknown): value is RunReceipt {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.runtime)) return false;
  const strings = [value.runId, value.packetHash, value.taskRef, value.role, value.cwd, value.owner,
    value.reportPath, value.completionMarker, value.outcome, value.stage,
    value.runtime.provider, value.runtime.model, value.runtime.thinking];
  return strings.every(field => typeof field === "string" && field.length > 0)
    && value.runtime.harness === "pi"
    && ["coordinator", "researcher", "planner", "reviewer", "worker", "generator"].includes(String(value.role))
    && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value.runtime.thinking))
    && ["attempted", "submitted", "uncertain", "failed-before-send"].includes(String(value.outcome))
    && ["tab", "start", "ready", "prompt"].includes(String(value.stage))
    && typeof value.attemptedAt === "number" && Number.isFinite(value.attemptedAt)
    && (value.promptAt === undefined || (typeof value.promptAt === "number" && Number.isFinite(value.promptAt)))
    && [value.pane, value.harnessSession, value.terminal].every(field => field === undefined
      || (typeof field === "string" && field.length > 0))
    && (value.outcome !== "submitted" || (value.promptAt !== undefined && value.pane !== undefined
      && value.harnessSession !== undefined && value.terminal !== undefined && value.stage === "prompt"));
}

function claimCollectionAttempt(dir: string, runId: string, at: number): number {
  for (let attempt = 1; ; attempt++) {
    try {
      writeRunReceipt(dir, `collection-attempted-${attempt}.json`, { runId, at, outcome: "attempted" });
      return attempt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** Each call is bounded. Rejections permit another attempt, but success is final. */
export async function collectRoleHandoff(runId: string, deps: RoleHandoffDeps = defaults): Promise<CollectionResult> {
  const dir = runReceiptDir(runId);
  if (fs.existsSync(path.join(dir, "collection.json"))) throw new Error("already-collected");
  const attempt = claimCollectionAttempt(dir, runId, deps.now());
  let reportHash: string | undefined;
  let result: CollectionResult;
  try {
    const text = readBoundedFile(path.join(dir, "launch.json"), 16 * 1024).text;
    let receipt: unknown;
    try { receipt = JSON.parse(text); } catch { throw new Error("invalid-receipt"); }
    if (!isRunReceipt(receipt) || receipt.runId !== runId || receipt.reportPath !== path.join(dir, "report.json")) {
      throw new Error("invalid-receipt");
    }
    if (!receipt.pane || !receipt.harnessSession || receipt.promptAt === undefined || receipt.outcome !== "submitted") {
      throw new Error("submission-unconfirmed");
    }
    const first = parseAgent(await deps.exec(["agent", "get", receipt.pane]));
    if (!matchesReceipt(first, receipt)) throw new Error("session-mismatch");
    if (first?.agent_status === "blocked") throw new Error("blocked");
    const settled = parseAgent(await deps.exec(buildWaitArgs(receipt.pane, 10_000)));
    if (!matchesReceipt(settled, receipt)) throw new Error("session-mismatch");
    if (settled?.agent_status !== "done" && settled?.agent_status !== "idle") throw new Error("not-settled");
    const file = readBoundedFile(receipt.reportPath, MAX_REPORT);
    reportHash = hash(file.text);
    const report = JSON.parse(file.text) as Record<string, unknown>;
    if (report.runId !== runId || report.packetHash !== receipt.packetHash || report.session !== receipt.harnessSession) {
      throw new Error("report-identity-mismatch");
    }
    const at = typeof report.completedAt === "string" ? Date.parse(report.completedAt) : NaN;
    if (!Number.isFinite(at) || at < receipt.promptAt || at > deps.now()
      || file.mtimeMs < receipt.promptAt || file.mtimeMs > deps.now()) throw new Error("stale-report");
    if (report.marker !== receipt.completionMarker) throw new Error("completion-marker-missing");
    if (typeof report.report !== "string" || !report.report.trim() || report.report.length > 24_000) throw new Error("invalid-report");
    const last = parseAgent(await deps.exec(["agent", "get", receipt.pane]));
    if (!matchesReceipt(last, receipt)) throw new Error("session-mismatch");
    if (last?.agent_status !== "idle" && last?.agent_status !== "done") throw new Error("not-settled");
    result = { outcome: "collected", report: report.report, reportHash };
  } catch (error) {
    const known = ["submission-unconfirmed", "session-mismatch", "blocked", "not-settled", "report-identity-mismatch",
      "stale-report", "completion-marker-missing", "invalid-report", "invalid-receipt"];
    const reason = error instanceof Error && known.includes(error.message) ? error.message : "unreadable-or-uncertain";
    result = { outcome: "rejected", reason, ...(reportHash === undefined ? {} : { reportHash }) };
  }
  // Only evidence metadata persists. The report stays in its own coordinator-owned artifact file.
  const evidence = { runId, at: deps.now(), outcome: result.outcome,
    ...(result.outcome === "rejected" ? { reason: result.reason } : {}),
    ...(reportHash === undefined ? {} : { reportHash }) };
  // Exclusive creation also fences concurrent successful collectors.
  if (result.outcome === "collected") writeRunReceipt(dir, "collection.json", evidence);
  writeRunReceipt(dir, `collection-${attempt}.json`, evidence);
  return result;
}
