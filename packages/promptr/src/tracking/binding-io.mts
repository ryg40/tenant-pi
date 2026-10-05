/**
 * IO for the tracker binding: read the two files, ask git for the
 * origin remote, write a binding atomically. Everything goes through injected
 * deps so tests never touch the real fs or spawn git.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { atomicWrite, stateRoot } from "../state/paths.mts";
import { resolveTrackerBinding, serializeTrackerBinding, trackerBindingFiles, type BindingResolveResult, type TrackerBinding } from "./binding.mts";

export interface BindingIoDeps {
  readFile: (file: string) => string | undefined;
  exists: (file: string) => boolean;
  writeFile: (file: string, text: string) => void;
  /** `git -C <cwd> remote get-url origin`, bounded; undefined on any failure. */
  gitRemote: (cwd: string) => string | undefined;
  stateRoot: () => string;
}

export const nodeBindingIoDeps: BindingIoDeps = Object.freeze({
  readFile(file: string): string | undefined {
    try { return fs.readFileSync(file, "utf8"); } catch { return undefined; }
  },
  exists(file: string): boolean {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  },
  writeFile(file: string, text: string): void {
    atomicWrite(file, text);
  },
  gitRemote(cwd: string): string | undefined {
    try {
      const out = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
        encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out === "" ? undefined : out;
    } catch { return undefined; }
  },
  stateRoot,
});

export interface LoadedTrackerBinding extends BindingResolveResult {
  files: { project: string; global: string };
  present: { project: boolean; global: boolean };
  gitRemote: string | undefined;
}

/** Resolve the binding for `cwd` from files, remote and env. Never throws. */
export function loadTrackerBinding(cwd: string, env: NodeJS.ProcessEnv, deps: BindingIoDeps = nodeBindingIoDeps): LoadedTrackerBinding {
  const files = trackerBindingFiles(cwd, deps.stateRoot());
  const project = deps.readFile(files.project);
  const global = deps.readFile(files.global);
  const gitRemote = deps.gitRemote(cwd);
  const resolved = resolveTrackerBinding(env, { ...(project === undefined ? {} : { project }), ...(global === undefined ? {} : { global }) }, gitRemote, cwd);
  return { ...resolved, files, present: { project: project !== undefined, global: global !== undefined }, gitRemote };
}

export type WriteBindingOutcome =
  | { ok: true; file: string }
  | { ok: false; error: string };

/** Write a binding; refuses an existing file unless `force`. Mode 0600 via atomicWrite. */
export function writeTrackerBinding(
  file: string, binding: TrackerBinding, options: { force: boolean }, deps: BindingIoDeps = nodeBindingIoDeps,
): WriteBindingOutcome {
  if (deps.exists(file) && !options.force) {
    return { ok: false, error: `'${file}' already exists. Nothing was written. Pass --force (or confirm overwrite) to replace it.` };
  }
  try {
    deps.writeFile(file, serializeTrackerBinding(binding));
    return { ok: true, file };
  } catch (error) {
    return { ok: false, error: `could not write '${file}': ${error instanceof Error ? error.message.slice(0, 120) : "write failed"}` };
  }
}
