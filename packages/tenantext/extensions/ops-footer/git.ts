import { execFile, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { safeText, unknown } from "./adapters.ts";
import type { GitSnapshot } from "./types.ts";

export function parseStatus(output: string): Pick<GitSnapshot, "branch" | "staged" | "unstaged" | "untracked" | "ahead" | "behind"> {
  const result = { branch: "unknown", staged: 0, unstaged: 0, untracked: 0, ahead: undefined as number | undefined, behind: undefined as number | undefined };
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (row.startsWith("# branch.head ")) result.branch = safeText(row.slice(14));
    else if (row.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(row);
      if (match) { result.ahead = Number(match[1]); result.behind = Number(match[2]); }
    } else if (row.startsWith("? ")) result.untracked++;
    else if (/^[12u] /.test(row)) {
      const xy = row.split(" ")[1];
      if (xy?.[0] !== ".") result.staged++;
      if (xy?.[1] !== ".") result.unstaged++;
      if (row.startsWith("2 ")) i++; // The next NUL record is the original rename path.
    }
  }
  return result;
}
export function parseWorktrees(output: string): { path: string; locked: boolean }[] {
  // -z disables Git's quoted-path encoding and safely handles newlines in paths.
  const rows = output.includes("\0") ? output.split("\0") : output.split("\n");
  const result: { path: string; locked: boolean }[] = [];
  for (const row of rows) {
    if (row.startsWith("worktree ")) result.push({ path: row.slice(9), locked: false });
    if (row.startsWith("locked") && result.length) result[result.length - 1].locked = true;
  }
  return result;
}
export class GitAdapter {
  snapshot: GitSnapshot = unknown("not checked");
  private processes = new Set<ChildProcess>();
  private inflight?: Promise<GitSnapshot>;
  private disposed = false;
  private lastAttempt = 0;
  private lastFull = 0;
  private lastCwd = "";
  private timeout: number;
  private lifetime: number;
  private poll: number;
  private full: number;
  /** `poll` is the slowest expected refresh interval; `full` is the longest time between root and worktree lookups. */
  constructor(timeout = 2000, lifetime = 1000, poll = lifetime, full = 60_000) { this.timeout = timeout; this.lifetime = lifetime; this.poll = poll; this.full = full; }
  private run(cwd: string, args: string[]): Promise<{ code: number; stdout: string; timeout: boolean }> {
    return new Promise(resolve => {
      const child = execFile("git", ["-C", cwd, ...args], {
        timeout: this.timeout, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
        encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      }, (error, stdout) => {
        this.processes.delete(child);
        resolve({ code: error ? Number(error.code) || 1 : 0, stdout, timeout: !!error?.killed });
      });
      this.processes.add(child);
    });
  }
  refresh(cwd: string, force = false): Promise<GitSnapshot> {
    if (this.disposed) return Promise.resolve(this.snapshot);
    if (this.inflight) return this.inflight;
    if (!force && cwd === this.lastCwd && Date.now() - this.lastAttempt < this.lifetime) return Promise.resolve(this.snapshot);
    // The root and the worktree list change rarely. Between full lookups, a successful repository needs only status: one process, not three.
    const full = force || cwd !== this.lastCwd || this.snapshot.state !== "ok" || !this.snapshot.worktree || Date.now() - this.lastFull >= this.full;
    this.lastAttempt = Date.now(); this.lastCwd = cwd;
    if (full) this.lastFull = this.lastAttempt;
    this.inflight = this.collect(cwd, full).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
  private async collect(cwd: string, full = true): Promise<GitSnapshot> {
    const kept = { code: 0, stdout: "", timeout: false };
    const [status, root, trees] = await Promise.all([
      this.run(cwd, ["status", "--porcelain=v2", "-z", "--branch"]),
      full ? this.run(cwd, ["rev-parse", "--show-toplevel"]) : kept,
      full ? this.run(cwd, ["worktree", "list", "--porcelain", "-z"]) : kept,
    ]);
    if (this.disposed) return this.snapshot;
    if (status.code || root.code || trees.code) {
      const timedOut = status.timeout || root.timeout || trees.timeout;
      // A failed lookup outside the old worktree cannot describe the old repository.
      const previous = this.snapshot.worktree;
      const leftWorktree = previous && cwd !== previous && !cwd.startsWith(`${previous}/`);
      if (leftWorktree && !timedOut) this.snapshot = { ...unknown("not-repo or Git unavailable"), checkedAt: Date.now() };
      else this.snapshot = { ...this.snapshot, state: timedOut || this.snapshot.repo ? "error" : "unknown", summary: timedOut ? "timeout" : "not-repo or Git unavailable" };
    } else {
      const path = root.stdout.replace(/\n$/, "");
      const where = full ? { repo: safeText(basename(path)), worktree: safeText(path), worktrees: parseWorktrees(trees.stdout).length }
        : { repo: this.snapshot.repo, worktree: this.snapshot.worktree, worktrees: this.snapshot.worktrees };
      this.snapshot = {
        ...parseStatus(status.stdout), state: "ok", summary: "local Git", ...where,
        // The slowest poll triggers collection. Freshness allows the next bounded collection to finish.
        checkedAt: Date.now(), staleAfter: Math.max(this.lifetime, this.poll) + this.timeout + 1500,
      };
    }
    return this.snapshot;
  }
  dispose(): void { this.disposed = true; for (const child of this.processes) child.kill("SIGKILL"); this.processes.clear(); }
}
