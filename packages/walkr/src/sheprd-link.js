import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// The optional Sheprd link (docs/compare.md, "Sheprd link (optional)"). Off by default: only an agent in a
// Herdr pane with WALKR_SHEPRD_CONNECT=1 and `sheprd` on the PATH tells Sheprd the page address of the run.
// The address holds the page secret, so it goes to `sheprd` on standard input, never in the arguments.
const LIMIT_MS = 5000;

export function linkWanted(env = process.env) {
  return env.WALKR_SHEPRD_CONNECT === "1" && env.HERDR_ENV === "1";
}

function findSheprd(env) {
  const names = process.platform === "win32" ? ["sheprd.exe"] : ["sheprd"];
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    // Skip a relative or empty entry: it depends on the current directory, which can be a checkout under review.
    if (!path.isAbsolute(dir)) continue;
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).isFile()) {
          if (process.platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
          return file;
        }
      } catch {}
    }
  }
  return null;
}

/** Runs `sheprd` with the arguments; resolves true on exit 0, false on another exit, an error or the limit. */
function runSheprd(file, args, input) {
  return new Promise((resolve) => {
    let done = false;
    let child;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try { child?.kill("SIGKILL"); } catch {}
      finish(false);
    }, LIMIT_MS);
    try {
      child = spawn(file, args, { shell: false, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    } catch {
      return finish(false);
    }
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
    child.stdin.once("error", () => {});
    child.stdin.end(input);
  });
}

async function link(args, input, success, env) {
  try {
    if (!linkWanted(env)) return null;
    const file = findSheprd(env);
    if (!file) return null;
    return (await runSheprd(file, args, input)) ? success : "failed";
  } catch {
    return "failed";
  }
}

/** Tells Sheprd the page address. Returns "connected", "failed", or null when the link is off or `sheprd` is absent. */
export function connect(url, env = process.env) {
  return link(["walkr", "connect", "-", "--show"], `${url}\n`, "connected", env);
}

/** Tells Sheprd that the run of this pane ended. Sheprd keeps the page open for a rating. */
export function disconnect(env = process.env) {
  return link(["walkr", "disconnect"], "", "disconnected", env);
}
