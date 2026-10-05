#!/usr/bin/env node
// Isolated installed-copy smoke: prove the copy that install.mjs
// produces actually runs, not just the dev checkout.
//
//   npm run build && npm run smoke:installed
//   node scripts/installed-smoke.mjs --out result.json --keep
//
// In a fresh temporary HOME, agent dir and backup root (never ~/.pi):
//   1. seeds a dummy previous install plus Promptr queue/notebook state,
//   2. runs the real scripts/install.mjs (npm pack + npm install --omit=dev),
//   3. checks the runtime pi-tui dependency is installed at the pinned version
//      and no second pi-coding-agent runtime is shipped,
//   4. checks built-code hash parity and the packed pi-atelier MIT notice,
//   5. runs the installed standalone companion --self-check and doctor,
//   6. loads the installed index.ts in `pi --mode rpc` (offline, no models,
//      input sink fixture) and reads get_commands,
//   7. checks the old copy was moved to the backup root and state is unchanged.
// Nothing is sent; RPC is skipped with a note if `pi` is not on PATH.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const keep = argv.includes("--keep");
const outFile = value("--out");
const log = (line) => process.stdout.write(`${line}\n`);
const failures = [];
const result = { checks: [] };

async function step(name, fn) {
  try {
    const detail = await fn();
    result.checks.push({ name, ok: true, detail });
    log(`ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failures.push(name);
    result.checks.push({ name, ok: false, detail });
    log(`FAIL ${name} — ${detail}`);
  }
}

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function tree(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const rel of readdirSync(dir, { recursive: true })) {
    const full = path.join(dir, rel);
    if (statSync(full).isFile()) out[rel] = sha(full);
  }
  return out;
}

if (!existsSync(path.join(root, "dist", "src", "extension", "index.mjs"))) {
  log("FAIL build output missing — run `npm run build` first");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const scratch = mkdtempSync(path.join(tmpdir(), "promptr-installed-smoke-"));
const home = path.join(scratch, "home");
const agentDir = path.join(scratch, "agent");
const backupRoot = path.join(scratch, "backups");
const project = path.join(scratch, "project");
const target = path.join(agentDir, "extensions", "promptr");
const cleanEnv = { HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", TERM: "dumb", LANG: "C.UTF-8" };
const run = (cmd, args, opts = {}) => {
  const res = spawnSync(cmd, args, { encoding: "utf8", env: cleanEnv, timeout: 300_000, ...opts });
  return { code: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
};
result.scratch = scratch;

try {
  // 1. Dummy previous install and durable state that must survive untouched.
  for (const dir of [home, path.join(target, "dist"), path.join(agentDir, "promptr", "projects", "demo"), path.join(project, ".promptr")]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "promptr", version: "0.0.0-dummy-old" }));
  writeFileSync(path.join(target, "dist", "OLD-MARKER"), "old install\n");
  writeFileSync(path.join(agentDir, "promptr", "client.json"), JSON.stringify({ clientId: "smoke" }));
  writeFileSync(path.join(agentDir, "promptr", "projects", "demo", "queue.json"), JSON.stringify({ items: [{ id: "q1", text: "queued draft" }] }));
  writeFileSync(path.join(agentDir, "promptr", "projects", "demo", "notebook.md"), "# notebook\nkept line\n");
  writeFileSync(path.join(project, ".promptr", "notebook.md"), "project notebook\n");
  const stateBefore = { agent: tree(path.join(agentDir, "promptr")), project: tree(path.join(project, ".promptr")) };

  // 2. The real installer, isolated.
  await step("install.mjs into temporary agent dir", () => {
    const r = run(process.execPath, [path.join(root, "scripts", "install.mjs"), "--agent-dir", agentDir, "--backup-root", backupRoot, "--tag", "installed-smoke"], { cwd: root });
    result.installLog = r.out.split("\n").filter((l) => !l.startsWith("npm notice")).join("\n");
    if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.out.slice(-400)}`);
    if (!existsSync(path.join(target, "index.ts"))) throw new Error("installed index.ts missing");
    return target;
  });

  // 3. Runtime dependencies.
  await step("runtime pi-tui installed at pinned version", () => {
    const want = pkg.dependencies?.["@earendil-works/pi-tui"];
    if (!want) throw new Error("package.json dependencies lacks @earendil-works/pi-tui");
    const file = path.join(target, "node_modules", "@earendil-works", "pi-tui", "package.json");
    if (!existsSync(file)) throw new Error("node_modules/@earendil-works/pi-tui missing after npm install --omit=dev");
    const got = JSON.parse(readFileSync(file, "utf8")).version;
    if (got !== want) throw new Error(`installed ${got}, pinned ${want}`);
    if (!existsSync(path.join(target, "node_modules", "@earendil-works", "pi-tui", "dist", "layout.js"))) throw new Error("pi-tui dist/layout.js deep path missing");
    return `@earendil-works/pi-tui ${got} (dist/layout.js present)`;
  });
  await step("no bundled pi-coding-agent runtime", () => {
    if (existsSync(path.join(target, "node_modules", "@earendil-works", "pi-coding-agent"))) throw new Error("installed copy ships its own pi-coding-agent; Pi must provide it");
    const shipped = existsSync(path.join(target, "node_modules")) ? readdirSync(path.join(target, "node_modules", "@earendil-works")).sort() : [];
    return `@earendil-works/* shipped: ${shipped.join(", ")}`;
  });

  // 4. Built-code parity and licence notice.
  await step("built dist hash parity", () => {
    const src = tree(path.join(root, "dist", "src"));
    const got = tree(path.join(target, "dist", "src"));
    const differ = Object.keys({ ...src, ...got }).filter((k) => src[k] !== got[k]);
    if (differ.length) throw new Error(`${differ.length} differ, e.g. ${differ.slice(0, 3).join(", ")}`);
    const digest = createHash("sha256").update(Object.keys(src).sort().map((k) => `${src[k]}  ${k}\n`).join("")).digest("hex");
    result.distFiles = Object.keys(src).length;
    result.distListSha256 = digest;
    return `${Object.keys(src).length} files identical; list sha256 ${digest.slice(0, 16)}…`;
  });
  await step("packed pi-atelier MIT notice", () => {
    const want = path.join(root, "docs", "PI-ATELIER-LICENSE.txt");
    const got = path.join(target, "docs", "PI-ATELIER-LICENSE.txt");
    if (!existsSync(got)) throw new Error("docs/PI-ATELIER-LICENSE.txt not packed");
    if (sha(want) !== sha(got)) throw new Error("packed notice differs from source");
    if (!/MIT License/.test(readFileSync(got, "utf8"))) throw new Error("notice lacks MIT License text");
    return `sha256 ${sha(got).slice(0, 16)}…`;
  });

  // 5. Standalone companion and doctor from the installed copy.
  await step("installed standalone companion --self-check", () => {
    const r = run(process.execPath, [path.join(target, "dist", "src", "companion", "spike.mjs"), "demo", "--self-check"], { cwd: project, timeout: 60_000 });
    if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.out.split("\n").filter((l) => /Error|Cannot find/.test(l)).slice(0, 2).join(" | ") || r.out.slice(-300)}`);
    if (!/paste refused/.test(r.out)) throw new Error("self-check output incomplete");
    return "exit 0; paste refused";
  });
  await step("installed doctor has no failures", () => {
    const r = run(process.execPath, [path.join(target, "dist", "src", "doctor", "cli.mjs")], { cwd: project, timeout: 60_000 });
    const lines = r.out.split("\n").filter((l) => /^\[/.test(l));
    result.doctor = { code: r.code, lines };
    const fails = lines.filter((l) => l.startsWith("[fail"));
    const install = lines.find((l) => /Installed copy/.test(l));
    if (!install?.startsWith("[ok")) throw new Error(`install check: ${install ?? "missing"}`);
    if (fails.length) throw new Error(`exit ${r.code}; ${fails.join(" | ")}`);
    return `exit ${r.code}; ${lines.filter((l) => l.startsWith("[warn")).length} warn(s); install ok`;
  });

  // 6. Installed extension loads in Pi RPC mode.
  await step("installed index.ts loads in pi --mode rpc", async () => {
    if (run("sh", ["-c", "command -v pi"]).code !== 0) return "SKIPPED: pi not on PATH";
    const sinkFile = path.join(scratch, "sink.jsonl");
    const fixture = path.join(scratch, "sink.ts");
    writeFileSync(fixture, [
      "// Swallows every input so nothing can reach a model.",
      "import { appendFileSync } from \"node:fs\";",
      "export default function (pi: any) {",
      "  pi.on(\"input\", (event: any) => { appendFileSync(process.env.SMOKE_SINK!, JSON.stringify({ source: event.source, text: event.text }) + \"\\n\"); return { action: \"handled\" }; });",
      "}",
    ].join("\n"));
    const child = spawn("pi", ["--mode", "rpc", "--no-session", "--offline", "--no-approve", "--no-extensions", "--no-skills",
      "-e", path.join(target, "index.ts"), "-e", fixture], { cwd: project, env: { ...cleanEnv, SMOKE_SINK: sinkFile }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(4000);
    child.stdin.write(`${JSON.stringify({ id: "cmds", type: "get_commands" })}\n`);
    for (let i = 0; i < 20 && !stdout.includes("\"cmds\""); i++) await sleep(250);
    child.kill("SIGTERM");
    await sleep(300);
    if (child.exitCode === null) child.kill("SIGKILL");
    const records = stdout.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return { unparsed: l }; } });
    const names = records.find((r) => r.id === "cmds")?.data?.commands?.map((c) => c.name) ?? [];
    const loadError = `${stderr}\n${stdout}`.split("\n").find((l) => /Failed to load extension|Cannot find module/.test(l));
    const promptr = names.filter((n) => /promptr|coordinatr|handoffr|work-status/.test(n)).sort();
    result.rpc = { commandCount: names.length, promptrCommands: promptr, atelier: names.some((n) => /atelier/i.test(n)),
      sinkRecords: existsSync(sinkFile) ? readFileSync(sinkFile, "utf8").trim().split("\n").filter(Boolean).length : 0, loadError };
    if (loadError) throw new Error(loadError.trim().slice(0, 300));
    if (!promptr.includes("promptr") || !promptr.includes("coordinatr")) throw new Error(`Promptr commands not registered (${names.length} commands)`);
    if (result.rpc.atelier) throw new Error("standalone /atelier registered");
    if (result.rpc.sinkRecords) throw new Error("input reached the sink");
    return `${promptr.length} Promptr commands; no /atelier; 0 inputs`;
  });

  // 7. Backup replacement and untouched state.
  await step("previous copy moved to backup root", () => {
    const backups = existsSync(backupRoot) ? readdirSync(backupRoot) : [];
    if (backups.length !== 1) throw new Error(`expected 1 backup, found ${backups.length}`);
    const old = path.join(backupRoot, backups[0]);
    if (readFileSync(path.join(old, "dist", "OLD-MARKER"), "utf8") !== "old install\n") throw new Error("backup lacks old marker");
    if (existsSync(path.join(target, "dist", "OLD-MARKER"))) throw new Error("old file leaked into new install");
    return backups[0];
  });
  await step("queue and notebook state unchanged", () => {
    const after = { agent: tree(path.join(agentDir, "promptr")), project: tree(path.join(project, ".promptr")) };
    for (const scope of ["agent", "project"]) {
      for (const [rel, hash] of Object.entries(stateBefore[scope])) {
        if (after[scope][rel] !== hash) throw new Error(`${scope}:${rel} changed or removed`);
      }
    }
    result.stateBefore = stateBefore;
    result.stateAfter = after;
    return `${Object.keys(stateBefore.agent).length + Object.keys(stateBefore.project).length} seeded files byte-identical`;
  });
} finally {
  if (outFile) writeFileSync(path.resolve(outFile), `${JSON.stringify({ ...result, failures }, null, 2)}\n`);
  if (!keep) rmSync(scratch, { recursive: true, force: true });
}

log(failures.length ? `installed smoke FAILED: ${failures.join(", ")}` : "installed smoke passed");
process.exit(failures.length ? 1 : 0);
