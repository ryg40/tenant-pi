#!/usr/bin/env node
/**
 * `promptr-workflows-init` — inert initialization of the local workflow
 * override file.
 *
 * What it does: writes one schema-valid JSON file describing the workflow
 * matrix this machine should use, for a provider the caller names.
 *
 * What it deliberately does not do: launch an agent, start a Pi session, read
 * or write credentials, log in, contact a provider, touch `settings.json`, or
 * check that the provider is loaded. It cannot tell you a provider works. The
 * file it writes is a *statement of intent*; runtime availability is checked
 * separately when a workflow is actually dispatched.
 *
 * It refuses to clobber an existing file. `--force` is the explicit,
 * documented confirmation for overwriting one.
 *
 * For a provider whose model IDs this machine cannot know (anything other
 * than the shipped OpenAI providers), model values are written as
 * `<angle-bracket>` placeholders. Those are rejected by the loader until they
 * are replaced with the exact IDs the target machine lists, so an unedited
 * file blocks visibly instead of failing later with a provider error.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowCatalogPort, WorkflowRole } from "../tracking/workflow-port.mts";
import { catalogPort } from "./catalog.mts";
import { WORKFLOWS_FILE_ENV, parseWorkflowConfigText } from "./config.mts";
import { resolveWorkflowsFile } from "./load.mts";

export interface InitDeps {
  exists: (file: string) => boolean;
  readFile: (file: string) => string | undefined;
  writeFile: (file: string, text: string) => void;
  log: (line: string) => void;
  /** Absolute path of a packaged example by name, or undefined if unknown. */
  examplePath: (name: string) => string | undefined;
}

export interface InitOptions {
  readonly provider?: string;
  readonly file?: string;
  readonly example?: string;
  readonly force: boolean;
  readonly allPi: boolean;
  /** Keep the shipped model IDs for a provider that serves the same IDs (no placeholders). */
  readonly keepModels: boolean;
  readonly print: boolean;
  readonly help: boolean;
}

export type InitParse =
  | { readonly ok: true; readonly value: InitOptions }
  | { readonly ok: false; readonly error: string };

export const EXAMPLES: readonly string[] = Object.freeze(["default", "copilot"]);

export const INIT_HELP = [
  "promptr-workflows-init - write a local Promptr workflow override file.",
  "",
  "Usage:",
  "  promptr-workflows-init --provider <id> [--path <absolute file>] [--all-pi] [--force] [--print]",
  "  promptr-workflows-init --example <default|copilot> [--path <absolute file>] [--force] [--print]",
  "",
  "Options:",
  "  --provider <id>   Provider ID this machine uses, exactly as Pi loads it",
  "                    (for example openai-codex or github-copilot).",
  "  --example <name>  Copy a packaged example instead of generating one.",
  `                    Known examples: ${EXAMPLES.join(", ")}.`,
  "  --path <file>     Absolute path to write. Defaults to",
  "                    <PI_CODING_AGENT_DIR|~/.pi/agent>/promptr/workflows.json,",
  `                    or ${WORKFLOWS_FILE_ENV} when that is set.`,
  "  --all-pi          Retarget roles that ship on the herdr-claude route onto",
  "                    Pi sessions on the named provider. Without it, those",
  "                    roles keep their shipped Claude/Herdr route.",
  "  --keep-models     Keep the shipped model IDs instead of writing placeholders.",
  "                    Use it only when your provider serves each exact ID.",
  "                    Confirm with pi --list-models.",
  "  --force           Overwrite an existing file. Without it an existing file",
  "                    is refused and nothing is written.",
  "  --print           Print the file that would be written; write nothing.",
  "  --help            Show this help.",
  "",
  "This command is inert: it writes one JSON file. It never launches an agent,",
  "logs in, reads credentials or verifies that the provider is available.",
  "Model IDs written as <angle-bracket> placeholders must be replaced with the",
  "exact IDs the target machine lists before the override will be accepted.",
].join("\n");

/** Providers whose exact model IDs the shipped catalog already knows. */
function shippedProviders(base: WorkflowCatalogPort): readonly string[] {
  return base.listProviders().map((choice) => choice.id);
}

export function parseInitArgs(argv: readonly string[]): InitParse {
  const value: {
    provider?: string; file?: string; example?: string;
    force: boolean; allPi: boolean; keepModels: boolean; print: boolean; help: boolean;
  } = { force: false, allPi: false, keepModels: false, print: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const next = (): string | undefined => argv[index + 1];
    switch (arg) {
      case "--help": case "-h": value.help = true; break;
      case "--force": value.force = true; break;
      case "--all-pi": value.allPi = true; break;
      case "--keep-models": value.keepModels = true; break;
      case "--print": value.print = true; break;
      case "--provider": {
        const id = next();
        if (id === undefined || id.startsWith("-")) return { ok: false, error: "--provider needs a provider ID." };
        value.provider = id; index += 1; break;
      }
      case "--example": {
        const name = next();
        if (name === undefined || name.startsWith("-")) return { ok: false, error: "--example needs a name." };
        if (!EXAMPLES.includes(name)) {
          return { ok: false, error: `unknown example '${name}'. Known examples: ${EXAMPLES.join(", ")}.` };
        }
        value.example = name; index += 1; break;
      }
      case "--path": {
        const file = next();
        if (file === undefined || file.startsWith("-")) return { ok: false, error: "--path needs a file path." };
        if (!path.isAbsolute(file)) return { ok: false, error: `--path must be absolute; received '${file}'.` };
        value.file = file; index += 1; break;
      }
      default:
        return { ok: false, error: `unknown argument '${arg}'. Run with --help.` };
    }
  }
  if (!value.help) {
    if (value.provider === undefined && value.example === undefined) {
      return { ok: false, error: "name the provider with --provider <id>, or copy a packaged example with --example <name>." };
    }
    if (value.provider !== undefined && value.example !== undefined) {
      return { ok: false, error: "use either --provider or --example, not both." };
    }
    if (value.example !== undefined && (value.allPi || value.keepModels)) {
      return { ok: false, error: "--all-pi and --keep-models apply to a generated file; a packaged example is copied as it ships." };
    }
  }
  return { ok: true, value: Object.freeze(value) };
}

function placeholderModel(role: WorkflowRole["role"]): string {
  return `<set-${role}-model-id>`;
}

interface RoleJson { provider?: string; model?: string; thinking?: string; route?: string }

/**
 * Build a schema-valid override for one provider from the shipped catalog, so
 * every workflow level and role is present in the file and easy to retune.
 */
export function buildInitConfig(
  base: WorkflowCatalogPort, provider: string, allPi: boolean, keepModels = false,
): { ok: true; text: string } | { ok: false; error: string } {
  const shipped = shippedProviders(base);
  // Shipped providers serve the catalog's IDs by definition; `--keep-models`
  // is the operator's explicit statement that another provider does too.
  const known = shipped.includes(provider) || keepModels;
  const probe = shipped[0];
  if (probe === undefined) return { ok: false, error: "shipped catalog offers no provider to expand against." };

  const workflows: Record<string, { label?: string; description?: string; roles: Record<string, RoleJson> }> = {};
  for (const choice of base.listWorkflows()) {
    const expanded = base.expandWorkflow({ template: choice.id, provider: probe, readiness: "ready" });
    if (!expanded.ok) return { ok: false, error: `cannot expand ${choice.id}: ${expanded.error}` };
    const roles: Record<string, RoleJson> = {};
    let retargeted = false;
    for (const role of expanded.value.roles) {
      const claudeRoute = role.route === "herdr-claude";
      if (claudeRoute && !allPi) {
        // Legacy mixed route kept as shipped: state it explicitly so the file
        // shows what will actually run rather than implying the new provider.
        roles[role.role] = { provider: role.provider, model: role.model, thinking: role.thinking, route: role.route };
        continue;
      }
      if (claudeRoute) retargeted = true;
      const entry: RoleJson = {
        model: known && (!claudeRoute || keepModels) ? role.model : placeholderModel(role.role),
        thinking: role.thinking,
      };
      if (claudeRoute) { entry.provider = provider; entry.route = "pi"; }
      roles[role.role] = entry;
    }
    workflows[choice.id] = retargeted
      ? {
        description: `${choice.description} Roles that ship on the Claude/Herdr route are retargeted to Pi sessions on ${provider}.`,
        roles,
      }
      : { roles };
  }

  const config = {
    version: 1,
    providers: [provider],
    defaultProvider: provider,
    workflows,
  };
  return { ok: true, text: `${JSON.stringify(config, null, 2)}\n` };
}

export type InitOutcome =
  | { readonly ok: true; readonly path: string; readonly written: boolean; readonly valid: boolean }
  | { readonly ok: false; readonly error: string };

/**
 * Run the initializer. Writes at most one file and prints what it did; it
 * starts nothing. The written file is re-parsed and the result reported, so a
 * placeholder file is announced as "not usable yet" rather than as success.
 */
export function runWorkflowInit(
  argv: readonly string[], env: NodeJS.ProcessEnv, deps: InitDeps, base: WorkflowCatalogPort = catalogPort,
): InitOutcome {
  const parsed = parseInitArgs(argv);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const options = parsed.value;
  if (options.help) {
    deps.log(INIT_HELP);
    return { ok: true, path: "", written: false, valid: true };
  }

  let text: string;
  if (options.example !== undefined) {
    const source = deps.examplePath(options.example);
    const body = source === undefined ? undefined : deps.readFile(source);
    if (body === undefined) return { ok: false, error: `packaged example '${options.example}' could not be read.` };
    text = body.endsWith("\n") ? body : `${body}\n`;
  } else {
    const built = buildInitConfig(base, options.provider as string, options.allPi, options.keepModels);
    if (!built.ok) return { ok: false, error: built.error };
    text = built.text;
  }

  const target = options.file ?? resolveWorkflowsFile(env).path;
  if (!path.isAbsolute(target)) return { ok: false, error: `target path must be absolute; resolved '${target}'.` };
  const check = parseWorkflowConfigText(text);

  if (options.print) {
    deps.log(text.trimEnd());
    deps.log(`# would write ${target}`);
    if (!check.ok) deps.log(`# not usable yet: ${check.error}`);
    return { ok: true, path: target, written: false, valid: check.ok };
  }

  if (deps.exists(target) && !options.force) {
    return {
      ok: false,
      error: `'${target}' already exists. Nothing was written. Pass --force to overwrite it, `
        + "or --print to see the file this command would produce.",
    };
  }

  deps.writeFile(target, text);
  deps.log(`wrote ${target}`);
  deps.log("nothing was launched, authenticated or verified: this command only wrote a file.");
  if (!check.ok) {
    deps.log(`not usable yet: ${check.error}`);
    deps.log("edit the file, then reopen the workflow picker.");
  } else {
    deps.log("reopen the workflow picker to pick it up; runtime availability is still checked at dispatch.");
  }
  return { ok: true, path: target, written: true, valid: check.ok };
}

// ---- node wiring ----

function packagedExamplePath(name: string): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/src/workflow -> package root
  const file = path.resolve(here, "..", "..", "..", "examples", name === "copilot" ? "workflows.copilot.json" : "workflows.example.json");
  return file;
}

export const nodeInitDeps: InitDeps = Object.freeze({
  exists(file: string): boolean {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  },
  readFile(file: string): string | undefined {
    try { return fs.readFileSync(file, "utf8"); } catch { return undefined; }
  },
  writeFile(file: string, text: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${String(process.pid)}.tmp`;
    fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  },
  log(line: string): void {
    process.stdout.write(`${line}\n`);
  },
  examplePath: packagedExamplePath,
});

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const outcome = runWorkflowInit(argv, process.env, nodeInitDeps);
  if (!outcome.ok) {
    process.stderr.write(`promptr-workflows-init: ${outcome.error}\n`);
    return 1;
  }
  return outcome.written && !outcome.valid ? 2 : 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
