/**
 * Check the next-move chip against labeled session states.
 * Run: TENANTEXT_NEXT_MOVE_KEY=... node --experimental-strip-types scripts/next-move-check.ts <url> [--timeout 150] [--min 0.3]
 * Use the decision-server URL configured as nextMoveUrl. It must answer a choice question. Not part of the Pi package files.
 * Warning: the states include the user messages. Use a local endpoint.
 */
import { readFileSync } from "node:fs";
import { askNextMove, type SessionState } from "../extensions/context-meter/next-move.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : fallback; };
const url = args.find(a => /^https?:\/\//.test(a));
if (!url) { console.error("Usage: next-move-check.ts <url> [--timeout 150] [--min 0.3]"); process.exit(1); }
const timeoutMs = option("--timeout", 150), minConfidence = option("--min", 0.3);
const key = process.env.TENANTEXT_NEXT_MOVE_KEY;
const { states } = JSON.parse(readFileSync(new URL("./next-move-states.json", import.meta.url), "utf8")) as { states: { id: string; expected: string; state: SessionState }[] };
let right = 0, shown = 0, shownRight = 0;
for (const s of states) {
  const started = performance.now();
  // Ask without the gate and with a long timeout first, so the table shows every answer.
  const raw = await askNextMove({ url, key, timeoutMs: 5000, minConfidence: 0 }, s.state);
  const ms = performance.now() - started;
  const visible = raw !== undefined && ms <= timeoutMs && raw.confidence >= minConfidence;
  if (raw?.choice === s.expected) right++;
  if (visible) { shown++; if (raw.choice === s.expected) shownRight++; }
  console.log([s.id.padEnd(12), s.expected.padEnd(9), (raw?.choice ?? "none").padEnd(9), raw ? raw.probability.toFixed(2) : "  - ",
    raw ? raw.confidence.toFixed(2) : "  - ", `${ms.toFixed(0)} ms`.padStart(7), visible ? "shown" : "hidden", raw?.choice === s.expected ? "" : "X"].join("  "));
}
console.log(`\nright ${right}/${states.length}; shown (<= ${timeoutMs} ms, confidence >= ${minConfidence}) ${shown}/${states.length}, of which right ${shownRight}`);
