---
name: to-tickets
description: Break a plan, spec, or the current conversation into a set of tracer-bullet tickets, each declaring its blocking edges, published to the Gitea issue tracker (edges as native dependencies, never a local ticket file).
disable-model-invocation: true
---

# To Tickets

Break a plan, spec, or conversation into a set of **tickets**: tracer-bullet vertical slices, each declaring the tickets that **block** it.

The issue tracker is Gitea. `docs/agents/issue-tracker.md` is the contract for each tracker operation and for the label vocabulary (section "Labels"). Read it before you publish. If the checkout has no issue tracker, stop and report it.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a reference (a spec issue (its number or named link), an issue number or URL) as an argument, fetch it and read its full body and comments.

Before the breakdown, read the knowledge sources in this order:

1. The `<openviking-context>` block that the session injects.
2. OpenViking `search` with `mode=context`.
3. OpenKnowledge through the `okknow` skill: `okknow search` and the pages under `projects/<project>/`.
4. In Pi only: the LLM-WIKI tools `wiki_search` and `wiki_recall`.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Read `GLOSSARY.md` first. Ticket titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the work into **tracer bullet** tickets.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests): vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first

</vertical-slice-rules>

Give each ticket its **blocking edges**: the other tickets that must complete before it can start. A ticket with no blockers can start immediately.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change (rename a column, retype a shared symbol) whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand-contract**. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a ticket blocked by every migrate batch. When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify ticket; green is promised only there.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each ticket, show:

- **Title**: short descriptive name
- **Blocked by**: which other tickets (if any) must complete first
- **What it delivers**: the end-to-end behaviour this ticket makes work

Ask the user. Use the question tool: `AskUserQuestion` in Claude Code, `ask_user_question` in Pi. Ask at most three questions per round, with the recommended option first. With no question tool, ask in plain text with no emoji. The forms are in the section "How to ask, by harness" of `grilling`. Load the grilling skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi.

- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct: does each ticket only depend on tickets that genuinely gate it?
- Should any tickets be merged or split further?

Iterate until the user approves the breakdown.

### 5. Publish the tickets to Gitea

Publish the approved tickets as Gitea issues. Use the tracker's native blocking relationship: Gitea dependencies in pass 2. `docs/agents/issue-tracker.md` is the contract: use its sections "Generic operations", "Labels", "Wayfinding operations" and "Publication safety" for each operation. Never use a local file as the ticket. If the user requests snapshot exports, create the default directory `docs/wayfinder/issues/` when absent. It is not shipped with the kit. Snapshots are optional exports, not the tracker.

Each ticket carries the parent label `wayfinder:parent:<map>`, where `<map>` is the number of the parent issue: the spec, or the map when the tickets come from a map. If the label does not exist, create it first (section "Labels"). When there is no parent issue, ask the user which spec or map is the parent before you publish. Each ticket carries the `ready-for-agent` triage label unless instructed otherwise; the tickets are agent-grabbable by construction. Do not apply a size label. Do not apply `wayfinder:task` to a new ticket.

Publish in two passes (section "Native dependencies"):

1. Pass 1: create one issue per ticket in dependency order (blockers first) so each ticket's blocking edges can reference real identifiers. Use the issue template below. "Parent" holds a named link. For Gitea, omit "Blocked by" from the body; pass 2 records the blockers as native dependencies.
2. Pass 2: wire each blocking edge as a native Gitea dependency. Then read the blockers of each ticket back and compare each list with the approved graph. Report each difference to the user. Do not continue with a graph that differs.

When the parent is a spec issue that carries `ready-for-agent`, remove `ready-for-agent` from the spec issue after the read-back matches the approved graph (operation "Remove a label" of section "Generic operations"). On a spec, the label means "ready for to-tickets". A spec with `ready-for-agent` and `wayfinder:parent:<map>` is in the frontier of the map, and a spec is not work for a worker.

After the read-back, report the **frontier** to the user: the tickets with no open blocker. Publication does not start a worker. The coordinator claims a ticket and starts a worker pane only on the user's word. The frontier rule is the section "Frontier" of `docs/agents/issue-tracker.md`.

Do NOT close a parent issue. Do NOT modify a parent issue, except for the removal of `ready-for-agent` from the spec.

<issue-template>

## Parent

A named link to the parent issue on the tracker: the spec or the map.

## What to build

The end-to-end behaviour this ticket makes work, from the user's perspective, not layer-by-layer implementation.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Blocked by

Omit this section when blockers were set as native edges in pass 2. Keep this list only where the tracker has no native blocking relationship:

- A named link to each blocking ticket, or "None (can start immediately)".

</issue-template>

Avoid specific file paths or code snippets: they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.
