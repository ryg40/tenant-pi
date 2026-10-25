import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Read-only mirrors of two rules of `skills/coordinator-skills/dummies/scripts/state.py`:
 * the state file and the Herdr role. Nothing here changes the state.
 */

const HARNESSES = ["claude", "pi"];
const RECORDS = ["autostart", "created"];
const ROLES = ["coordinator", "researcher", "scout", "worker", "reviewer"];

/** `dummies-skill/state.json` in an absolute `XDG_CONFIG_HOME`, else in `~/.config`. */
export function statePath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const base = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(base, "dummies-skill", "state.json");
}

/** True only when the state file is valid and its `pi` value is `on`. An absent, invalid or linked file counts as off. */
export function dummiesOn(path = statePath()): boolean {
  try {
    if (lstatSync(path).isSymbolicLink()) return false;
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const record = data as Record<string, unknown>;
    // As state.py: an absent key has the default, and a JSON null is not valid.
    if (HARNESSES.some(one => record[one] !== undefined && record[one] !== "on" && record[one] !== "off")) return false;
    for (const key of RECORDS) {
      const files = record[key] === undefined ? {} : record[key];
      if (!files || typeof files !== "object" || Array.isArray(files)) return false;
      if (!Object.values(files).every(value => Array.isArray(value) && value.every(one => typeof one === "string"))) return false;
    }
    return record.pi === "on";
  } catch {
    return false;
  }
}

/** The role in a Herdr agent name of the form `<project>-<role>-<n>`, or undefined. */
export function roleOfName(name: unknown): string | undefined {
  return new RegExp(`-(${ROLES.join("|")})-[0-9]+$`).exec(String(name ?? ""))?.[1];
}

/**
 * The Herdr role of this pane: a role name, "unknown" when the pane has a Herdr record with no role,
 * or undefined outside Herdr or when the lookup fails. It runs the local `herdr agent get` command, as state.py does.
 */
export function herdrRole(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const pane = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !pane) return Promise.resolve(undefined);
  return new Promise(resolve => {
    execFile("herdr", ["agent", "get", pane], { timeout: 10_000 }, (error, stdout) => {
      if (error) { resolve(undefined); return; }
      try {
        const agent = JSON.parse(stdout)?.result?.agent;
        resolve(agent && typeof agent === "object" ? roleOfName(agent.name) ?? "unknown" : undefined);
      } catch { resolve(undefined); }
    });
  });
}
