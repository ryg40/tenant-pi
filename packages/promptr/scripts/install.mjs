#!/usr/bin/env node
// Reproducible local install of the built extension into a Pi agent dir.
//
//   npm run build && npm run install:local            # ~/.pi/agent/extensions/promptr
//   node scripts/install.mjs --agent-dir /path/agent   # any PI_CODING_AGENT_DIR
//   node scripts/install.mjs --dry-run                 # show what would happen
//   node scripts/install.mjs --uninstall               # remove the installed copy only
//
// What it does: `npm pack` this checkout, unpack the tarball into
// <agentDir>/extensions/promptr, then `npm install --omit=dev --ignore-scripts`
// there for the runtime dependency (pi-tui). The previous copy is moved to
// <backupRoot>/<stamp>-<tag>/ first. Durable data is never touched:
// <agentDir>/promptr/ (state, prompt-logs, queues, overrides) and every
// project's .promptr/ stay where they are, on install and on uninstall.
//
// Afterwards: start a fresh Pi process (`/reload` can keep cached compiled
// modules), and close + reopen any /coordinatr-herdr companion (a running
// companion keeps the old code).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
if (flag("--help") || flag("-h")) {
  process.stdout.write("install.mjs [--agent-dir <dir>] [--backup-root <dir>] [--tag <label>] [--dry-run] [--uninstall]\n");
  process.exit(0);
}
const agentDir = path.resolve(value("--agent-dir") ?? process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent"));
const target = path.join(agentDir, "extensions", "promptr");
const backupRoot = path.resolve(value("--backup-root") ?? path.join(homedir(), ".local", "share", "promptr-handoffs", "install-backups"));
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const tag = (value("--tag") ?? "local").replace(/[^A-Za-z0-9._-]+/g, "-");
const dryRun = flag("--dry-run");
const log = (line) => process.stdout.write(`${line}\n`);

function backupExisting() {
  if (!existsSync(target)) return undefined;
  const dest = path.join(backupRoot, `${stamp}-${tag}`);
  log(`${dryRun ? "would move" : "moving"} previous copy ${target} -> ${dest}`);
  if (!dryRun) {
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    renameSync(target, dest);
  }
  return dest;
}

if (flag("--uninstall")) {
  const moved = backupExisting();
  log(moved ? `uninstalled; copy retained at ${moved}. State under ${path.join(agentDir, "promptr")} and project .promptr/ directories are untouched.` : `nothing installed at ${target}`);
  log("Quit and start a fresh Pi process, and close any open /coordinatr-herdr companion.");
  process.exit(0);
}

if (!existsSync(path.join(root, "dist", "src", "extension", "index.mjs"))) {
  process.stderr.write("build output missing — run `npm run build` first\n");
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
log(`installing ${pkg.name} ${pkg.version} from ${root}`);
log(`agent dir ${agentDir}`);
const work = mkdtempSync(path.join(tmpdir(), "promptr-install-"));
try {
  const packed = execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", work, ...(dryRun ? ["--dry-run"] : [])], { cwd: root, encoding: "utf8", timeout: 120_000 }).trim().split("\n").pop();
  if (dryRun) {
    log(`would unpack ${packed} into ${target} and run npm install --omit=dev --ignore-scripts there`);
    backupExisting();
    process.exit(0);
  }
  const tarball = path.join(work, packed);
  const unpack = path.join(work, "unpack");
  mkdirSync(unpack, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", unpack], { timeout: 60_000 });
  const staged = path.join(unpack, "package");
  execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: staged, stdio: "inherit", timeout: 300_000 });
  backupExisting();
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  cpSync(staged, target, { recursive: true });
  log(`installed to ${target}`);
  log("next: quit and start a fresh Pi process (/reload can keep cached compiled modules); close and reopen any /coordinatr-herdr companion; run /promptr-doctor. Bind the tracker with promptr-tracker-init --provider gitea|github or /promptr-tracker init.");
} finally {
  rmSync(work, { recursive: true, force: true });
}
