#!/usr/bin/env node
/**
 * `promptr-doctor` — sanitized environment check.
 *
 *   promptr-doctor [--cwd <dir>] [--json] [--online] [--init-tracker | --tracker gitea|github]
 *
 * Reads versions, paths and presence flags; never prints a credential, a
 * note or a prompt. `--online` adds two bounded GETs: the tracker repository
 * and, when bound and credentialed, the OpenKnowledge brief. Exit 1 when any
 * check fails.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectPaths, stateRoot } from "../state/paths.mts";
import { runDoctor, renderDoctor, type DoctorCheck, type DoctorProbe, type DoctorReport, type FileFacts } from "./doctor.mts";
import { promptLogFiles, readPromptLog, readSyncCursor } from "../sync/prompt-log.mts";
import { trackingPorts } from "../tracking/ports.mts";
import { loadTrackerBinding } from "../tracking/binding-io.mts";
import { nodeTrackerInitDeps, runTrackerInit } from "../tracking/init.mts";
import { OpenKnowledgeClient } from "../briefing/openknowledge.mts";

function readFile(file: string): string | undefined {
  try { return fs.readFileSync(file, "utf8"); } catch { return undefined; }
}

function exists(file: string): boolean {
  try { fs.statSync(file); return true; } catch { return false; }
}

function stat(file: string): FileFacts | undefined {
  try {
    const s = fs.statSync(file);
    return { exists: true, isDir: s.isDirectory(), mode: s.mode, uid: s.uid, mtimeMs: s.mtimeMs };
  } catch { return undefined; }
}

function version(bin: string): string | undefined {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(out);
    return match ? match[1] : out.trim().slice(0, 40);
  } catch { return undefined; }
}

export function packageRootOf(moduleUrl: string = import.meta.url): string {
  // dist/src/doctor/cli.mjs → package root
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "..", "..");
}

export function buildProbe(cwd: string, env: NodeJS.ProcessEnv = process.env): DoctorProbe {
  const root = packageRootOf();
  let packageVersion = "unknown";
  let nodeEngines = ">=22.22.0 <23";
  try {
    const pkg = JSON.parse(readFile(path.join(root, "package.json")) ?? "{}") as { version?: unknown; engines?: { node?: unknown } };
    if (typeof pkg.version === "string") packageVersion = pkg.version;
    if (typeof pkg.engines?.node === "string") nodeEngines = pkg.engines.node;
  } catch { /* unknown */ }
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || path.join(process.env.HOME ?? "", ".pi", "agent");
  const paths = projectPaths(cwd);
  const files = promptLogFiles(paths.dir);
  const io = { readFile, appendFile: () => {}, writeFile: () => {} };
  const entries = readPromptLog(files, io);
  const cursor = readSyncCursor(files, io);
  const trackerBinding = loadTrackerBinding(cwd, env);
  return {
    env, cwd, nowMs: Date.now(),
    trackerBinding,
    nodeVersion: process.versions.node, nodeEngines, packageVersion, packageRoot: root,
    agentDir, stateRoot: stateRoot(), projectDir: paths.dir,
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    exists, readFile, stat, version,
    promptLog: { entries: entries.length, pending: entries.filter((e) => e.seq > cursor.syncedThrough).length },
  };
}

/** Two bounded reads; the outcome is a check, never the payload. */
export async function onlineChecks(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const bound = loadTrackerBinding(cwd, env);
  const tracker = bound.resolution;
  if (tracker.ok) {
    try {
      const page = await trackingPorts(bound.effectiveEnv, { timeoutMs: 8000 }).listPage(tracker.config.repo, 1);
      out.push({ id: "online:tracker", level: "ok", summary: `Tracker reachable: ${String(page.items.length)} issue(s) on page 1` });
    } catch (error) {
      out.push({ id: "online:tracker", level: "fail", summary: "Tracker unreachable", detail: error instanceof Error ? error.message.slice(0, 120) : "read failed" });
    }
  }
  const binding = readFile(path.join(cwd, ".promptr", "briefing.json"));
  let target: { origin: string; docName: string } | undefined;
  try {
    const parsed = JSON.parse(binding ?? "{}") as { target?: { origin?: unknown; docName?: unknown } };
    if (typeof parsed.target?.origin === "string" && typeof parsed.target.docName === "string") target = { origin: parsed.target.origin, docName: parsed.target.docName };
  } catch { /* unbound */ }
  if (target) {
    const client = OpenKnowledgeClient.fromEnv(target.origin, env);
    if (!client) out.push({ id: "online:openknowledge", level: "warn", summary: "OpenKnowledge bound but credentials missing; read skipped" });
    else {
      try {
        const doc = await client.readDocument(target.docName);
        out.push({ id: "online:openknowledge", level: doc === null ? "warn" : "ok", summary: doc === null ? `OpenKnowledge reachable; ${target.docName} does not exist yet` : `OpenKnowledge reachable; ${target.docName} readable (${String(doc.length)} chars)` });
      } catch (error) {
        out.push({ id: "online:openknowledge", level: "fail", summary: "OpenKnowledge unreachable or unauthorized", detail: error instanceof Error ? error.message.slice(0, 120) : "read failed" });
      }
    }
  }
  return out;
}

export const DOCTOR_HELP = [
  "promptr-doctor [--cwd <dir>] [--json] [--online] [--init-tracker | --tracker gitea|github]",
  "Sanitized checks: versions, install, skills, workflow overrides, capability probe, OpenKnowledge/tracker configuration, state ownership.",
  "  --online         adds bounded reachability reads (tracker page 1, OpenKnowledge brief).",
  "  --init-tracker   interactive tracker binding (TTY required) before the report; same as /promptr-tracker init.",
  "  --tracker <p>    non-interactive binding to gitea or github with owner/repo from the origin remote (project scope), then the report.",
  "Never prints credentials, notes or prompts.",
].join("\n");

/** Optional binding step before the report. Returns an exit code when it must stop. */
export async function initTrackerStep(
  cwd: string, mode: { interactive: boolean; provider?: string }, tty: boolean = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY),
  run: typeof runTrackerInit = runTrackerInit, deps = nodeTrackerInitDeps,
): Promise<number | undefined> {
  const argv: string[] = ["--cwd", cwd];
  if (mode.provider !== undefined) argv.push("--provider", mode.provider);
  else if (!tty) { process.stderr.write("promptr-doctor: --init-tracker needs a TTY; use --tracker gitea|github or promptr-tracker-init --provider … instead.\n"); return 2; }
  const outcome = await run(argv, process.env, deps(mode.provider === undefined && tty));
  if (!outcome.ok) { process.stderr.write(`promptr-doctor: tracker init failed: ${outcome.error}\n`); return outcome.usage ? 2 : 1; }
  return undefined;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let cwd = process.cwd();
  let json = false;
  let online = false;
  let initTracker = false;
  let trackerProvider: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--json") json = true;
    else if (arg === "--online") online = true;
    else if (arg === "--init-tracker") initTracker = true;
    else if (arg === "--tracker") {
      const v = argv[i + 1];
      if (v !== "gitea" && v !== "github") { process.stderr.write("promptr-doctor: --tracker needs gitea or github\n"); return 2; }
      trackerProvider = v; i += 1;
    }
    else if (arg === "--cwd") { cwd = path.resolve(argv[i + 1] ?? cwd); i += 1; }
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${DOCTOR_HELP}\n`);
      return 0;
    } else {
      process.stderr.write(`promptr-doctor: unknown argument '${arg}'\n`);
      return 2;
    }
  }
  if (initTracker || trackerProvider !== undefined) {
    const stop = await initTrackerStep(cwd, { interactive: initTracker, ...(trackerProvider === undefined ? {} : { provider: trackerProvider }) });
    if (stop !== undefined) return stop;
  }
  let report: DoctorReport = runDoctor(buildProbe(cwd));
  if (online) {
    const extra = await onlineChecks(cwd);
    const checks = [...report.checks, ...extra];
    report = { ...report, checks, ok: checks.every((c) => c.level !== "fail") };
  }
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${renderDoctor(report)}\n`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.stderr.write(`promptr-doctor: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
