/** Best-effort git snapshot. Never throws; unknown fields stay "unknown". */
import { execFileSync } from "node:child_process";

export type GitSnapshot = {
  head: string;
  ref: string;
  dirty: boolean;
  changed: string[];
};

function run(args: string[], cwd: string, timeoutMs = 3000): string | undefined {
  try {
    const out = execFileSync("git", args, { cwd, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return typeof out === "string" ? out : undefined;
  } catch {
    return undefined;
  }
}

export function gitSnapshot(cwd: string): GitSnapshot {
  const head = run(["rev-parse", "--short=12", "HEAD"], cwd)?.trim() || "unknown";
  const ref = run(["rev-parse", "--abbrev-ref", "HEAD"], cwd)?.trim() || "";
  const porcelain = run(["status", "--porcelain=v1", "--untracked-files=normal"], cwd) ?? "";
  const changed = porcelain.split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => l.slice(2).trim().split(" -> ").pop() ?? l)
    .filter(Boolean).slice(0, 50);
  return { head, ref: ref === "HEAD" ? "" : ref, dirty: changed.length > 0, changed };
}

/** `git remote get-url origin`, or undefined when there is no remote/git. Never throws. */
export function gitRemoteUrl(cwd: string, remote = "origin"): string | undefined {
  const out = run(["remote", "get-url", remote], cwd)?.trim();
  return out && out.length > 0 ? out.slice(0, 300) : undefined;
}
