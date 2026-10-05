#!/usr/bin/env node
// Bounded offline smoke for a built checkout.
//
//   npm run build && npm run smoke
//
// Proves, without a TTY, network, Pi or Herdr:
//   1. the companion renders and reacts (its own --self-check),
//   2. the workflow initializer prints a valid file for a shipped provider,
//      and the tracker initializer prints a binding without writing,
//   3. the doctor runs against an isolated empty agent dir and reports,
//   4. the package inventory (npm pack --dry-run) carries dist, skills and examples.
// Exit 1 on the first failure. Nothing is installed, launched or sent.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist", "src");
const failures = [];
const log = (line) => process.stdout.write(`${line}\n`);

function step(name, fn) {
  try {
    const detail = fn();
    log(`ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failures.push(name);
    log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function run(args, env = {}) {
  const res = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000 });
  return { code: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

if (!existsSync(path.join(dist, "companion", "spike.mjs"))) {
  log("FAIL build output missing — run `npm run build` first");
  process.exit(1);
}

const scratch = mkdtempSync(path.join(tmpdir(), "promptr-smoke-"));
try {
  step("companion self-check", () => {
    const r = run([path.join(dist, "companion", "spike.mjs"), "demo", "--self-check"]);
    if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.out.slice(0, 300)}`);
    if (!/paste refused/.test(r.out) || !/hosted review consumable: requested=true/.test(r.out)) throw new Error("self-check output incomplete");
    return "renders at 80x16, 20x8, 3x3; paste refused; review consumable";
  });

  step("workflow init --print for a shipped provider", () => {
    const r = run([path.join(dist, "workflow", "init.mjs"), "--provider", "openai-codex", "--print", "--path", path.join(scratch, "wf.json")]);
    if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.out.slice(0, 300)}`);
    if (/not usable yet/.test(r.out)) throw new Error("shipped provider must not print placeholders");
    if (existsSync(path.join(scratch, "wf.json"))) throw new Error("--print must not write");
    return "valid file printed, nothing written";
  });

  step("tracker init --print binds without writing", () => {
    const r = run([path.join(dist, "tracking", "init.mjs"), "--provider", "github", "--owner", "example-owner", "--repo", "promptr", "--cwd", scratch, "--print"], { GITHUB_TOKEN: "" });
    if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.out.slice(0, 300)}`);
    if (!/"provider": "github"/.test(r.out) || !/would write .*tracker\.json/.test(r.out)) throw new Error("binding not printed");
    if (!/GITHUB_TOKEN not set/.test(r.out)) throw new Error("token presence line missing");
    if (existsSync(path.join(scratch, ".promptr", "tracker.json"))) throw new Error("--print must not write");
    return "github example-owner/promptr printed, nothing written";
  });

  step("workflow init --provider github-copilot --keep-models writes a valid override", () => {
    const file = path.join(scratch, "copilot.json");
    const r = run([path.join(dist, "workflow", "init.mjs"), "--provider", "github-copilot", "--all-pi", "--keep-models", "--path", file]);
    if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.out.slice(0, 300)}`);
    if (!existsSync(file)) throw new Error("file not written");
    const again = run([path.join(dist, "workflow", "init.mjs"), "--provider", "github-copilot", "--path", file]);
    if (again.code !== 1 || !/already exists/.test(again.out)) throw new Error("existing file must be refused without --force");
    return "written once; second run refused";
  });

  step("doctor against an isolated agent dir", () => {
    const agent = path.join(scratch, "agent");
    const r = run([path.join(dist, "doctor", "cli.mjs"), "--json", "--cwd", scratch], { PI_CODING_AGENT_DIR: agent, OPENKNOWLEDGE_USERNAME: "", OPENKNOWLEDGE_PASSWORD: "", GITEA_TOKEN: "", GITHUB_TOKEN: "" });
    const report = JSON.parse(r.out);
    const ids = report.checks.map((c) => c.id);
    for (const id of ["node", "install", "skill:promptr-generate-task-prompt", "workflows", "capabilities", "openknowledge:auth", "tracker", "state:root"]) {
      if (!ids.includes(id)) throw new Error(`check ${id} missing`);
    }
    const skill = report.checks.find((c) => c.id === "skill:promptr-generate-task-prompt");
    if (skill.level !== "ok") throw new Error(`packaged skill not found: ${skill.summary}`);
    const text = JSON.stringify(report);
    if (/OPENKNOWLEDGE_PASSWORD=|token [A-Za-z0-9]{20}/.test(text)) throw new Error("report leaks a secret-shaped value");
    return `${report.checks.length} checks, exit ${r.code} (fresh dir: install/probe warnings expected)`;
  });

  step("package inventory carries dist, skills and examples", () => {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", timeout: 60_000 });
    const [pkg] = JSON.parse(out);
    const files = pkg.files.map((f) => f.path);
    for (const needed of [
      "dist/src/extension/index.mjs", "dist/src/companion/spike.mjs", "dist/src/workflow/init.mjs", "dist/src/tracking/init.mjs", "dist/src/doctor/cli.mjs",
      "docs/workflow-overrides.md", "skills/promptr-generate-task-prompt/SKILL.md", "examples/workflows.copilot.json", "examples/workflows.example.json", "index.ts", "package.json",
    ]) {
      if (!files.includes(needed)) throw new Error(`${needed} missing from the package`);
    }
    if (files.some((f) => f.startsWith("node_modules/") || f.startsWith("test/") || f.startsWith("src/"))) throw new Error("package must not ship node_modules, test or src");
    return `${files.length} files, ${pkg.size} bytes packed`;
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  log(`smoke: ${failures.length} failure(s): ${failures.join("; ")}`);
  process.exit(1);
}
log("smoke: all checks passed (offline, nothing installed, launched or sent)");
