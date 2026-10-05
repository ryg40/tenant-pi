/**
 * Sanitized doctor: versions, transport, auth presence, required
 * skills, ownership. Pure: every fact arrives through `DoctorProbe`, so the
 * report is testable without a machine and can never read a token or a note
 * by itself. Callers must only ever pass presence flags for credentials.
 */
import path from "node:path";
import { WORKFLOWS_FILE_ENV } from "../workflow/config.mts";
import { loadWorkflowConfig, loadEffectiveCatalog, resolveWorkflowsFile, resolveCapabilityProbeFile } from "../workflow/load.mts";
import { catalogPort } from "../workflow/catalog.mts";
import { parseCapabilityProbe } from "../workflow/registry.mts";
import { resolveTracker } from "../tracking/config.mts";
import type { resolveTrackerBinding } from "../tracking/binding.mts";
import { briefingTarget } from "../briefing/openknowledge.mts";

export type CheckLevel = "ok" | "info" | "warn" | "fail";

export interface DoctorCheck {
  readonly id: string;
  readonly level: CheckLevel;
  readonly summary: string;
  readonly detail?: string;
}

export interface DoctorReport {
  readonly version: 1;
  readonly at: string;
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

export interface FileFacts {
  readonly exists: boolean;
  readonly isDir: boolean;
  readonly mode: number;
  readonly uid: number;
  readonly mtimeMs: number;
}

export interface DoctorProbe {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly nowMs: number;
  readonly nodeVersion: string;
  readonly nodeEngines: string;
  readonly packageVersion: string;
  /** Root of this package (source checkout or installed copy). */
  readonly packageRoot: string;
  readonly agentDir: string;
  readonly stateRoot: string;
  readonly projectDir: string;
  readonly uid: number;
  readonly exists: (file: string) => boolean;
  readonly readFile: (file: string) => string | undefined;
  readonly stat: (file: string) => FileFacts | undefined;
  /** Bounded `<bin> --version`; undefined when the binary is missing or fails. */
  readonly version: (bin: string) => string | undefined;
  /** Pi registry models when the doctor runs inside Pi; undefined outside. */
  readonly registryModels?: number | undefined;
  /** Prompt-log facts supplied by the caller (never the entries themselves). */
  readonly promptLog?: { readonly entries: number; readonly pending: number } | undefined;
  /** Tracker binding resolved from env, files and origin remote; absent = env only. */
  readonly trackerBinding?: ReturnType<typeof resolveTrackerBinding> | undefined;
}

export const REQUIRED_SKILLS: readonly string[] = Object.freeze(["promptr-generate-task-prompt"]);

function check(id: string, level: CheckLevel, summary: string, detail?: string): DoctorCheck {
  return Object.freeze(detail === undefined ? { id, level, summary } : { id, level, summary, detail });
}

/** Minimal semver range check for `>=a.b.c <d` style engines. */
export function nodeSatisfies(version: string, engines: string): boolean {
  const parse = (v: string): [number, number, number] | undefined => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
  };
  const cmp = (a: [number, number, number], b: [number, number, number]): number =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const actual = parse(version);
  if (!actual) return false;
  for (const clause of engines.split(/\s+/).filter((c) => c.length > 0)) {
    const m = /^(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(clause);
    if (!m) return false;
    const op = m[1] ?? "=";
    const bound: [number, number, number] = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)];
    const c = cmp(actual, bound);
    const majorOnly = m[3] === undefined;
    if (op === ">=" && c < 0) return false;
    if (op === ">" && c <= 0) return false;
    if (op === "<" && (majorOnly ? actual[0] >= bound[0] : c >= 0)) return false;
    if (op === "<=" && c > 0) return false;
    if (op === "=" && c !== 0) return false;
  }
  return true;
}

function ageLabel(mtimeMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - mtimeMs) / 60_000));
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${String(hours)}h ago` : `${String(Math.floor(hours / 24))}d ago`;
}

function ownership(probe: DoctorProbe, id: string, label: string, dir: string): DoctorCheck {
  const facts = probe.stat(dir);
  if (!facts) return check(id, "info", `${label}: ${dir} (not created yet)`);
  if (!facts.isDir) return check(id, "fail", `${label}: ${dir} is not a directory`);
  const problems: string[] = [];
  if (facts.uid !== probe.uid) problems.push(`owned by uid ${String(facts.uid)}, running as ${String(probe.uid)}`);
  if ((facts.mode & 0o077) !== 0) problems.push(`mode ${(facts.mode & 0o777).toString(8)} is group/world accessible (expected 0700)`);
  return problems.length > 0
    ? check(id, "warn", `${label}: ${dir}`, problems.join("; "))
    : check(id, "ok", `${label}: ${dir} (owner-only, uid ${String(facts.uid)})`);
}

/** The Pi release line this package is built and tested against (the pinned pi-tui/pi-coding-agent 1.0.2). */
export const TESTED_PI_LINE = "1.0";
const testedPi = (version: string) => version === TESTED_PI_LINE || version.startsWith(`${TESTED_PI_LINE}.`);

export function runDoctor(probe: DoctorProbe): DoctorReport {
  const checks: DoctorCheck[] = [];
  const env = probe.env;

  // ---- versions ----
  checks.push(nodeSatisfies(probe.nodeVersion, probe.nodeEngines)
    ? check("node", "ok", `Node ${probe.nodeVersion} satisfies ${probe.nodeEngines}`)
    : check("node", "fail", `Node ${probe.nodeVersion} does not satisfy ${probe.nodeEngines}`));
  checks.push(check("promptr", "info", `Promptr ${probe.packageVersion} at ${probe.packageRoot}`));
  const pi = probe.version("pi");
  checks.push(pi === undefined
    ? check("pi", "warn", "Pi CLI not found on PATH", `The extension only runs inside Pi; install Pi (${TESTED_PI_LINE}.x) or add it to PATH. Herdr launches and generator sessions need it.`)
    : check("pi", testedPi(pi) ? "ok" : "warn", `Pi ${pi}`, testedPi(pi) ? undefined : `Promptr is built and tested against Pi ${TESTED_PI_LINE}.x; other lines are untested.`));
  const herdr = probe.version("herdr");
  checks.push(herdr === undefined
    ? check("herdr", "warn", "Herdr not found on PATH", "/coordinatr-herdr (the legacy companion), Start fresh and the generator need Herdr; the /promptr sidebar works without it.")
    : check("herdr", "ok", `Herdr ${herdr}${env.HERDR_ENV === "1" ? " (this shell runs inside Herdr)" : " (this shell is not a Herdr pane)"}`));

  // ---- install ----
  const installDir = path.join(probe.agentDir, "extensions", "promptr");
  const installedPkg = probe.readFile(path.join(installDir, "package.json"));
  if (installedPkg === undefined) {
    checks.push(check("install", "warn", `No installed copy at ${installDir}`, "Run `npm run install:local` from the package directory, then start a fresh Pi process."));
  } else {
    let version = "unknown";
    try { version = String((JSON.parse(installedPkg) as { version?: unknown }).version ?? "unknown"); } catch { /* unknown */ }
    const built = probe.exists(path.join(installDir, "dist", "src", "extension", "index.mjs"))
      && probe.exists(path.join(installDir, "dist", "src", "companion", "spike.mjs"));
    const deps = probe.exists(path.join(installDir, "node_modules", "@earendil-works", "pi-tui", "package.json"));
    const drift = version !== probe.packageVersion ? ` (source is ${probe.packageVersion})` : "";
    checks.push(check("install", built && deps ? "ok" : "fail", `Installed copy ${version}${drift} at ${installDir}`,
      [built ? undefined : "dist/src/extension/index.mjs or companion missing: rebuild and reinstall",
        deps ? undefined : "node_modules/@earendil-works/pi-tui missing: run `npm install --omit=dev` in the installed directory"].filter((l) => l !== undefined).join("; ") || undefined));
  }

  // ---- skills ----
  for (const skill of REQUIRED_SKILLS) {
    const packaged = path.join(probe.packageRoot, "skills", skill, "SKILL.md");
    checks.push(probe.exists(packaged)
      ? check(`skill:${skill}`, "ok", `Skill ${skill} packaged at ${packaged}`)
      : check(`skill:${skill}`, "fail", `Skill ${skill} missing at ${packaged}`, "The package ships skills/; reinstall from a build that includes them."));
  }
  const skillOverride = env.PROMPTR_GENERATOR_SKILL?.trim();
  if (skillOverride) {
    checks.push(path.isAbsolute(skillOverride) && probe.exists(skillOverride)
      ? check("skill:override", "info", `PROMPTR_GENERATOR_SKILL overrides the packaged skill: ${skillOverride}`)
      : check("skill:override", "fail", `PROMPTR_GENERATOR_SKILL is set but not an existing absolute path`, "The generator refuses to launch until it is fixed or unset."));
  }

  // ---- workflow overrides and capability probe ----
  const fileDeps = { readFile: probe.readFile, exists: probe.exists };
  const workflows = loadWorkflowConfig(env, fileDeps);
  const wfPath = resolveWorkflowsFile(env).path;
  const effective = loadEffectiveCatalog(catalogPort, env, fileDeps);
  if (effective.error !== undefined) checks.push(check("workflows", "fail", `Workflow override invalid: ${wfPath}`, effective.error));
  else if (!workflows.ok) checks.push(check("workflows", "fail", `Workflow override invalid: ${wfPath}`, workflows.error));
  else if (workflows.config === undefined) checks.push(check("workflows", "info", `Workflow overrides: none (shipped defaults); optional file ${wfPath}${env[WORKFLOWS_FILE_ENV] ? " (from " + WORKFLOWS_FILE_ENV + ")" : ""}`));
  else checks.push(check("workflows", "ok", `Workflow override active: ${wfPath}`, `providers ${workflows.config.providers?.join(", ") ?? "(shipped)"}; configured intent, not verified availability`));
  const resolvedProbe = resolveCapabilityProbeFile(env);
  const probeFile = resolvedProbe.path;
  const probeText = resolvedProbe.error ? undefined : probe.readFile(probeFile);
  if (resolvedProbe.error) {
    checks.push(check("capabilities", "fail", resolvedProbe.error));
  } else if (probeText === undefined) {
    checks.push(check("capabilities", workflows.ok && workflows.config === undefined ? "warn" : "fail", `No capability probe at ${probeFile}`, "Run /promptr-workflows probe inside Pi. Configured workflow launches require a readable probe; shipped defaults remain static candidates."));
  } else {
    const parsed = parseCapabilityProbe(probeText);
    const facts = probe.stat(probeFile);
    checks.push(parsed.ok
      ? check("capabilities", "ok", `Capability probe: ${String(parsed.capabilities.length)} provider/model rows${facts ? `, written ${ageLabel(facts.mtimeMs, probe.nowMs)}` : ""}`, parsed.source)
      : check("capabilities", "fail", `Capability probe unusable: ${probeFile}`, `${parsed.reason}; generator dispatch is blocked until it is rewritten (/promptr-workflows probe) (configured workflows require a probe)`));
  }
  if (probe.registryModels !== undefined) checks.push(check("registry", "info", `Pi registry: ${String(probe.registryModels)} available models in this session`));

  // ---- OpenKnowledge ----
  const origin = env.OPENKNOWLEDGE_ORIGIN?.trim();
  try {
    const checked = briefingTarget(origin && origin.length > 0 ? origin : "https://openknowledge.example.com", "projects/promptr/brief");
    checks.push(check("openknowledge:origin", "ok", `OpenKnowledge origin ${checked.origin} (HTTPS)`));
  } catch (error) {
    checks.push(check("openknowledge:origin", "fail", "OPENKNOWLEDGE_ORIGIN is not a usable HTTPS origin", error instanceof Error ? error.message : undefined));
  }
  const user = Boolean(env.OPENKNOWLEDGE_USERNAME && env.OPENKNOWLEDGE_USERNAME.length > 0);
  const pass = Boolean(env.OPENKNOWLEDGE_PASSWORD && env.OPENKNOWLEDGE_PASSWORD.length > 0);
  checks.push(user && pass
    ? check("openknowledge:auth", "ok", "OpenKnowledge credentials present in this environment (values not shown)")
    : check("openknowledge:auth", "warn", `OpenKnowledge credentials ${user ? "password" : pass ? "username" : "username and password"} missing`, "Export OPENKNOWLEDGE_USERNAME and OPENKNOWLEDGE_PASSWORD in the shell that launches Pi and the companion. Local save keeps working."));
  const binding = probe.readFile(path.join(probe.cwd, ".promptr", "briefing.json"));
  if (binding === undefined) {
    checks.push(check("openknowledge:binding", "info", "This project is not bound to OpenKnowledge pages yet", "Ctrl+O → Connect OpenKnowledge binds projects/<id>/brief; a second client uses the same id to read shared history."));
  } else {
    let target = "unreadable";
    try {
      const parsed = JSON.parse(binding) as { target?: { origin?: unknown; docName?: unknown } };
      target = typeof parsed.target?.docName === "string" ? `${String(parsed.target.origin ?? "")} ${parsed.target.docName}` : "not connected";
    } catch { /* unreadable */ }
    checks.push(check("openknowledge:binding", target === "unreadable" ? "warn" : "ok", `OpenKnowledge binding: ${target}`));
  }

  // ---- tracker (binding-aware; env-only when the caller supplied none) ----
  const bound = probe.trackerBinding ?? { resolution: resolveTracker(env), source: "env" as const, effectiveEnv: env, problems: [] };
  const tracker = bound.resolution;
  const bindHint = "Not bound explicitly. Pi: /promptr-tracker init · shell: promptr-tracker-init --provider gitea|github";
  if (!tracker.ok) {
    checks.push(check("tracker", "warn", `Tracker ${tracker.provider} unconfigured · source ${bound.source}`, tracker.reason));
    checks.push(check("tracker:binding", "warn", bindHint));
  } else {
    const tokenVar = tracker.config.provider === "github" ? "GITHUB_TOKEN" : "GITEA_TOKEN";
    checks.push(check("tracker", "ok", `Tracker ${tracker.config.provider} ${tracker.config.repo.host} ${tracker.config.repo.owner}/${tracker.config.repo.repo} · source ${bound.source}`,
      tracker.config.tokenPresent ? `${tokenVar} present (value not shown)` : `${tokenVar} not set; private repositories will fail`));
    if (bound.source === "default" || bound.source === "remote") checks.push(check("tracker:binding", "info", bindHint));
  }
  for (const problem of bound.problems) checks.push(check("tracker:binding-file", "warn", problem));
  const cache = probe.stat(path.join(probe.projectDir, "tracking.json"));
  checks.push(cache
    ? check("tracker:cache", "info", `Tracking cache written ${ageLabel(cache.mtimeMs, probe.nowMs)}`)
    : check("tracker:cache", "info", "No tracking cache yet for this project"));

  // ---- state and ownership ----
  checks.push(ownership(probe, "state:root", "State root", probe.stateRoot));
  checks.push(ownership(probe, "state:project", "Project state", probe.projectDir));
  if (probe.promptLog) {
    checks.push(check("prompt-log", probe.promptLog.pending > 0 ? "warn" : "ok",
      `Prompt-log: ${String(probe.promptLog.entries)} local entries, ${String(probe.promptLog.pending)} pending sync`,
      probe.promptLog.pending > 0 ? "Pending entries sync on the next reconnect tick; they are retained locally meanwhile." : undefined));
  }

  const ok = checks.every((c) => c.level !== "fail");
  return Object.freeze({ version: 1, at: new Date(probe.nowMs).toISOString(), ok, checks: Object.freeze(checks) });
}

export function renderDoctor(report: DoctorReport): string {
  const lines = [`Promptr doctor · ${report.at} · ${report.ok ? "no failures" : "FAILURES present"}`];
  for (const c of report.checks) {
    lines.push(`[${c.level.padEnd(4)}] ${c.summary}`);
    if (c.detail) lines.push(`       ${c.detail}`);
  }
  lines.push("No tokens, note text or prompt text are included in this report.");
  return lines.join("\n");
}
