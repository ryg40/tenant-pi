/**
 * Handoff builder (pure): staged continuation prompt for successor sessions.
 * Takes current git facts + recent progress + pending queue and renders one
 * self-contained markdown prompt. No I/O, no execution, no secrets.
 */
import type { ProgressEntry } from "../progress/tracker.mts";

export type HandoffInput = {
  slug: string;
  cwd: string;
  ref: string;
  head: string;
  dirty: boolean;
  changed: string[];
  focus?: string;
  progress: ProgressEntry[];
  queueTexts: string[];
  provider?: string;
  model?: string;
};

export function buildHandoffPrompt(input: HandoffInput): string {
  const stamp = new Date().toISOString();
  const recent = input.progress.slice(-8);
  const lines: string[] = [];
  lines.push(`# Promptr continuation — ${input.slug}`);
  lines.push(``);
  lines.push(`Staged ${stamp}. Paste this whole prompt into a fresh Pi session in the same project to continue.`);
  lines.push(``);
  lines.push(`## Project`);
  lines.push(`- cwd: \`${input.cwd}\``);
  lines.push(`- ref: \`${input.ref || "unknown"}\` head: \`${input.head}\`${input.dirty ? " (dirty — inspect before trusting)" : " (clean)"}`);
  if (input.changed.length > 0) lines.push(`- changed paths: ${input.changed.slice(0, 20).map((c) => `\`${c}\``).join(", ")}`);
  if (input.provider || input.model) lines.push(`- previous runtime: ${input.provider ?? "?"} / ${input.model ?? "?"}`);
  lines.push(``);
  lines.push(`## Where things stand`);
  if (recent.length === 0) {
    lines.push(`No checkpoints recorded. Start by running \`git status --short --branch\` and \`git log --oneline -8\`, then tell me what you see.`);
  } else {
    for (const e of recent) {
      lines.push(`### ${e.at} (${e.id}) — ${e.ref || "?"} @ ${e.head}${e.dirty ? " dirty" : ""}`);
      lines.push(e.text);
      lines.push(``);
    }
  }
  if (input.focus?.trim()) {
    lines.push(`## Current focus`);
    lines.push(input.focus.trim().slice(0, 2000));
    lines.push(``);
  }
  if (input.queueTexts.length > 0) {
    lines.push(`## Queued prompts carried over (${input.queueTexts.length})`);
    input.queueTexts.slice(0, 10).forEach((q, i) => {
      lines.push(`### Queued ${i + 1}`);
      lines.push(q.slice(0, 3000));
      lines.push(``);
    });
  }
  lines.push(`## How to continue`);
  lines.push(`1. Verify: \`git status --short --branch\` and \`git log --oneline -5\`. If HEAD moved, say so before doing anything else.`);
  lines.push(`2. Pick the smallest next runnable step from "Where things stand"${input.focus?.trim() ? " and Current focus" : ""}.`);
  lines.push(`3. Do that step, run the relevant check (build/test/lint), and report files changed + command output.`);
  lines.push(`4. Record progress with \`/promptr-save "did X, next Y"\` so the next handoff stays fresh.`);
  lines.push(`5. Stop before unrelated refactors, commits, or pushes unless asked.`);
  lines.push(``);
  lines.push(`Begin by confirming the git state matches (or differs from) the snapshot above, then propose the next step.`);
  return lines.join("\n").slice(0, 12000);
}

/** Filename for a staged handoff: sortable, unique enough for one-shot use. */
export function handoffFilename(now = new Date(), rand = ""): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const suffix = (rand || Math.random().toString(36).slice(2, 6)).replace(/[^a-z0-9]+/gi, "").slice(0, 4) || "x";
  return `${stamp}-${suffix}.md`;
}
