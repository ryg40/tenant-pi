// The Pi side of the memory chain. It starts one shadow run for each user prompt and returns nothing,
// so the prompt, the system prompt and the messages stay as they are. It does not wait for the run.
// It loads `shadow.mjs` only after the switch says `shadow`, so the extension loads in `off` even
// when a vendored helper is missing or renamed.
import { readMode } from "./src/switch.mjs";

/** Register the `before_agent_start` handler. `run` replaces the shadow run in tests. */
export function registerMemoryChain(pi, { run, env = process.env, cwd = () => process.cwd() } = {}) {
  pi.on("before_agent_start", (event) => {
    if (event?.messageType !== "user") return undefined;
    // Prompt arrival: the clock of the chain starts here.
    const startedAt = Date.now();
    void Promise.resolve()
      .then(async () => {
        if (readMode(env) !== "shadow") return;
        const runner = run ?? (await import("./src/shadow.mjs")).runShadow;
        await runner({ harness: "pi", prompt: event.prompt, cwd: cwd(), env, startedAt });
      })
      .catch(() => {});
    return undefined;
  });
}
