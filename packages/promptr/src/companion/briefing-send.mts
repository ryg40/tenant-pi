import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicWrite } from "../state/paths.mts";
import { parseAgent, matchesAgentIdentity, buildPromptArgs } from "../herdr/adapter.mts";
import { isHerdrPaneId } from "../herdr/identity.mts";
import type { BriefingDialogs } from "../briefing/overview.mts";
import { validateBriefing } from "../briefing/openknowledge.mts";

export type HerdrExecutor = (args: string[]) => Promise<string>;
const execute = promisify(execFile);
export const executeHerdr: HerdrExecutor = async args => {
  const result = await execute("herdr", args, { timeout: 15000, maxBuffer: 1024 * 1024 });
  return result.stdout;
};
export interface BriefingPiTarget { pane: string; sessionFile: string; cwd: string }

async function readyTarget(target: BriefingPiTarget, exec: HerdrExecutor): Promise<string> {
  const agent = parseAgent(await exec(["agent", "get", target.pane]));
  if (!matchesAgentIdentity(agent, { pane: target.pane, cwd: target.cwd, foreground: true, session: target.sessionFile })
    || agent?.agent_status !== "idle" || typeof agent.terminal_id !== "string") {
    throw new Error("Main Pi identity/readiness changed; nothing submitted. Inspect main Pi and reopen /coordinatr-herdr.");
  }
  return agent.terminal_id;
}

/** Explicit briefing-only send. Durable attempt packet fences uncertain delivery across reopen. */
export async function resumeBriefingInMainPi(
  text: string, target: BriefingPiTarget, ui: BriefingDialogs, exec: HerdrExecutor = executeHerdr,
): Promise<boolean> {
  validateBriefing(text);
  if (!isHerdrPaneId(target.pane) || !path.isAbsolute(target.sessionFile)) {
    ui.notify("No verified main Pi binding. Reopen the companion with /coordinatr-herdr; nothing submitted.", "warning"); return false;
  }
  // Herdr submits interactive input, not sendUserMessage(expandPromptTemplates:false).
  if (!text.trim() || /^[\/!]/.test(text.trimStart())) {
    ui.notify("Use a non-empty Markdown briefing, not a slash or shell command. Nothing submitted.", "warning"); return false;
  }
  const key = createHash("sha256").update(target.sessionFile).update("\0").update(text).digest("hex");
  const packet = path.join(target.cwd, ".promptr", "briefing-history", `${key}-resume-attempt.json`);
  if (existsSync(packet)) {
    ui.notify(`Already attempted; inspect main Pi before any manual recovery. Packet: ${packet}. No retry.`, "warning"); return false;
  }
  let terminal: string;
  try { terminal = await readyTarget(target, exec); }
  catch { ui.notify("Cannot verify idle main Pi in the original project/session. Nothing submitted.", "warning"); return false; }
  if (!await ui.confirm("Submit reviewed briefing to main Pi?", `Pane: ${target.pane}\ncwd: ${target.cwd}\nSession: ${target.sessionFile}\nStarts one turn; may run tools. No launch or queue drain.\n\n${text}`)) return false;
  try {
    if (await readyTarget(target, exec) !== terminal || existsSync(packet)) throw new Error("Target changed");
    atomicWrite(packet, JSON.stringify({ target, terminal, text, outcome: "attempted/unknown", at: new Date().toISOString() }, null, 2) + "\n");
  } catch { ui.notify("Target changed or packet could not be saved; nothing submitted.", "warning"); return false; }
  try {
    await exec(buildPromptArgs(target.pane, text));
    ui.notify(`Submission attempted; verify main Pi's reply. Packet retained: ${packet}. No automatic retry.`, "info");
  } catch {
    ui.notify(`Submission failed or uncertain; inspect main Pi. Packet retained: ${packet}. No retry.`, "warning");
  }
  return true;
}
