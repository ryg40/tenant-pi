---
name: wayfinder
description: Plan a huge chunk of work (more than one agent session can hold) as a shared map of decision tickets on your issue tracker, and resolve them one at a time until the way to the destination is clear.
disable-model-invocation: true
---

A loose idea has arrived, too big for one agent session, and wrapped in fog: the way from here to the **destination** isn't visible yet. Wayfinding is about finding that way, not charging at the destination. This skill charts the way as a **shared map** on the repo's issue tracker, then works its **decision tickets** (questions whose resolution is a decision, not slices of a build to execute) one at a time until the route is clear.

The destination varies per effort, and naming it is the first act of charting: it shapes every ticket. It might be a spec to hand off and iterate on, a decision to lock before planning starts, or a change made in place like a data-structure migration. The map is domain-agnostic: engineering work, course content, whatever fits the shape.

## Plan, don't do

Wayfinder is **planning** by default: each ticket resolves a decision, and the map is done when the way is clear, with nothing left to decide before someone goes and does the thing. The pull to just do the work is usually the signal you've reached the edge of the map and it's time to hand off. An effort can override this in its **Notes**, carrying execution into the map itself, but absent that, produce decisions, not deliverables.

## Refer by name

Every map and ticket is an issue, so it has a **name**: its title. In everything the human reads (narration, the map's Decisions-so-far), refer to it by that name, never by a bare id, number, or slug. A wall of `#42, #43, #44` is illegible; names read at a glance. The id and URL don't vanish; a name wraps its link, but they ride _inside_ the name, never stand in for it.

## The Map

The map is a single issue on this repo's issue tracker, labelled `wayfinder:map`, the canonical artifact. Its tickets are child issues of the map: each child ticket carries the label `wayfinder:parent:<map>`, where `<map>` is the number of the map.

The map is an **index**, not a store. It lists the decisions made and points at the tickets that hold their detail; a decision lives in exactly one place, its ticket, so the map never restates it, only gists it and links.

**Where the map, its child tickets, blocking, and frontier queries physically live is tracker-specific.** Read `docs/agents/issue-tracker.md`, the tracker document, and its "Wayfinding operations" section for how _this_ repo expresses them. If the file is absent, stop and tell the user. Do not write a local ticket file.

### The map body

The whole map at low resolution, loaded once per session. Open tickets are **not** listed: they are open child issues, found by query.

```markdown
## Destination

<what reaching the end of this map looks like: the spec, decision, or change this effort is finding its way to. One or two lines; every session orients to it before choosing a ticket.>

## Notes

<domain; skills every session should consult; standing preferences for this effort>

## Decisions so far

<!-- the index: one line per closed ticket, enough to judge relevance, then zoom the link for the detail the ticket holds -->

- [<closed ticket title>](link): <one-line gist of the answer>

## Not yet specified

<!-- see "Fog of war": in-scope fog you can't ticket yet; graduates as the frontier advances -->

## Out of scope

<!-- see "Out of scope": work ruled beyond the destination; closed, never graduates -->
```

### Tickets

Each ticket is a **child issue** of the map, with the label `wayfinder:parent:<map>`; the tracker's issue id is its identity. Its body is the question, sized to one 100K token agent session:

```markdown
## Question

<the decision or investigation this ticket resolves>
```

A ticket of a type carries its label: `wayfinder:research`, `wayfinder:prototype` or `wayfinder:grilling` (see [Ticket Types](#ticket-types)). A task ticket carries no type label. The "Labels" section of the tracker document is the complete list of labels.

A session **claims** a ticket by assigning it to the dev driving the map, **first**, before any work, so concurrent sessions skip it. That assignee _is_ the claim: an open, unassigned ticket is unclaimed. The "Claim" section of the tracker document gives the operation.

Blocking uses the tracker's **native** dependency relationship: essential because it renders the frontier _visually_ in the tracker's own UI, so the human sees what's takeable without opening the map. Wire each dependency in a second pass, then read it back, as the "Native dependencies" section of the tracker document says. A ticket is **unblocked** when every ticket blocking it is closed; the **frontier** is the open, unblocked, unclaimed children, the edge of the known. Compute it as the "Frontier" section of the tracker document says.

The answer isn't part of the body; it's recorded on resolution (see [Work through the map](#work-through-the-map)). Assets created while resolving a ticket are linked from the issue, not pasted in.

## Ticket Types

Every ticket is either **HITL** (human in the loop, worked _with_ a human who speaks for themselves) or **AFK**, driven by the agent alone. A HITL ticket only resolves through that live exchange; the agent never stands in for the human's side of it (a grilling agent that answers its own questions has broken this).

- **Research** (AFK): Reading documentation, third-party APIs, or local resources like knowledge bases to surface a fact a decision waits on. Resolved by one new researcher pane per ticket (see [Panes](#panes) for model selection). Load the research skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. The findings go to a comment on the ticket. Use when knowledge outside the current working directory is required.
- **Prototype** (HITL): Raise the fidelity of the discussion by making a cheap, rough, concrete artifact to react to (an outline, a rough take, a stub, or UI/logic code). Resolved by a new worker pane in its own worktree and branch (see [Panes](#panes) for model selection). Load the prototype skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. Links the prototype as an asset. Use when "how should it look" or "how should it behave" is the key question.
- **Grilling** (HITL): Conversation. The default case. Resolved by the coordinator with the user, never by a pane. Always load both skills. Load the grilling skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. Load the domain-modeling skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. A round holds three questions, each with the recommended answer first, as the `grilling` text says.
- **Task** (HITL or AFK): Manual work that must happen before a _decision_ can be made: nothing to decide, prototype, or research, but the discussion is blocked until it's done. Signing up for a service so its API can be judged, provisioning access, moving data so its shape can be seen. This is the one type that _does_ rather than decides, and it earns its place by unblocking a decision, not by delivering the destination. The agent drives it alone where it can (AFK); otherwise it hands the human a precise checklist (HITL). Resolved when the work is done; the answer records what was done and any resulting facts (credentials location, new URLs, row counts) later tickets depend on.

## Panes

A research ticket and a prototype ticket run in a **Herdr pane**. A grilling ticket never does.

Select the model and thinking level from the request or the Herdr local defaults file, `~/.config/herdr-skill/models.json`. Follow `SPAWN.md` of the loaded `herdr` skill for precedence and harness defaults. A researcher needs a model with a web search tool.

| Role | Use |
| --- | --- |
| worker | One worktree and one branch per worker. |
| researcher, scout | Reading and search. |
| reviewer | A review of a result. |

Load the herdr skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. For each pane:

1. Write a **task file**. It names the ticket, the question and the result form. For a Pi pane it names `PI_CODING_AGENT_DIR` for any `pi` command, and the model or the cleared provider keys.
2. Start a new pane of the matching role (`spawn.py`).
3. Send the task with one blocking `ask.py`.
4. Read the reply (`FINAL_COMPRESSED_CONTEXT`).
5. Close the pane (`close.py`).

A pane is never reused: each ticket, each fix round after a review and each review starts a new pane with its own task file. The coordinator records the result; a pane never writes a report file as its result channel.

## Knowledge read order

Before a decision, read the facts in this order:

1. The injected `<openviking-context>` block of the session.
2. OpenViking `search` with `mode=context`.
3. OpenKnowledge through the `okknow` skill: `okknow search` and the pages under `projects/<project>/`.
4. In Pi only, the LLM-WIKI tools `wiki_search` and `wiki_recall`.

Write targets: the resolution comment on the ticket is canonical. After a decision, append one line (a summary of at most 80 characters) to the OpenKnowledge page `projects/<project>/handoffs` through `okknow`. Use OpenViking `remember` only for a standing preference of the user.

## Fog of war

The map is _deliberately_ incomplete: don't chart what you can't yet see. Beyond the live tickets lies the **fog of war**: the dim view of decisions and investigations you can tell are coming but can't yet pin down, because they hang on questions still open. Resolving a ticket clears the fog ahead of it, graduating whatever's now specifiable into fresh tickets, one at a time, until the way to the destination is clear and no tickets remain.

The map's **Not yet specified** section is where that dim view is written down: the suspected question, the area to revisit later. It's the undiscovered frontier _toward_ the destination: everything here is in scope, just not sharp enough to ticket. Write as loosely or as fully as the view allows; it doubles as a signpost for collaborators reading where the effort is headed.

**Fog or ticket?** The test is whether you can state the question precisely now, _not_ whether you can answer it now.

- **Ticket when** the question is already sharp, even if it's blocked and you can't act on it yet.
- **Not yet specified when** you can't yet phrase it that sharply. Don't pre-slice the fog into ticket-sized pieces: it's coarser than a ticket, and one patch may graduate into several tickets, or none, once the frontier reaches it.

**Not yet specified** excludes what's already decided (Decisions so far), what's already a live ticket, and what's out of scope (the next section).

## Out of scope

Fog only ever gathers _toward_ the destination. The destination fixes the scope, so work beyond it is **out of scope**: it isn't fog, and it doesn't belong in **Not yet specified**. It gets its own **Out of scope** section on the map: work you've consciously ruled out of _this_ effort. Scope, not sharpness, lands it here.

Out-of-scope work never graduates (the frontier stops at the destination), so it returns only if the destination is redrawn, and then as a fresh effort, not a resumption.

Ruling something out of scope is a scoping act, not a step on the route. When a ticket that already exists turns out to sit past the destination (mis-scoped in while charting, or exposed by a resolution), **close it** (a closed ticket is unambiguously off the frontier) and leave one line in the **Out of scope** section: the gist plus why it's out of scope, linking the closed ticket. It stays out of **Decisions so far**, which records the route actually walked; a scope boundary isn't a step on it.

## Invocation

Two modes. Either way, **one ticket per worker pane**: the coordinator may run several panes on several tickets in parallel, and a pane is never reused across tickets or fix rounds. A session that resolves a ticket itself, as the coordinator does with a grilling ticket, never resolves more than one ticket. A research ticket is resolved by its own researcher pane, one pane per ticket, like any other ticket.

### Chart the map

User invokes with a loose idea.

1. **Name the destination.** Read the facts first, in the [knowledge read order](#knowledge-read-order). Then load two skills. Load the grilling skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. Load the domain-modeling skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. Use them to pin down what this map is finding its way to: the spec, decision, or change. The destination fixes the scope, so it's settled first.
2. **Map the frontier.** Grill again, **breadth-first** this time: fan out across the whole space rather than deep on any one thread, surfacing the open decisions and the first steps takeable now. **If this surfaces no fog** (the way to the destination is already clear, the whole journey small enough for one session), you don't need a map. Stop and ask the user how they'd like to proceed.
3. **Create the map** (label `wayfinder:map`): Destination and Notes filled in, Decisions-so-far empty, the fog sketched into **Not yet specified**. Then create the label `wayfinder:parent:<map>`. Follow the "Publication safety" section of the tracker document before each create.
4. **Create the tickets you can specify now** as child issues of the map, each with the label `wayfinder:parent:<map>` and the label of its type, then wire blocking edges in a **second pass** (issues need ids before they can reference each other). Read each edge back and compare it with the graph you planned. Wiring sorts them into the frontier and the blocked; everything you can't yet specify stays in the fog: the **Not yet specified** section.
5. **Start the researcher panes.** For each `research` ticket you just created, write a task file that names the ticket, the question and the result form. Load the herdr skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. Start one new researcher pane per research ticket and run the panes in parallel (see [Panes](#panes)). A pane is never reused: each ticket, each fix round and each review starts a new pane. Post the findings of each pane as a comment on its ticket. When the findings are long, put them on an OpenKnowledge page under `projects/<project>/` and link the page from the comment. The findings never go to a file on `main`.
6. Stop: charting is one session's work; it hand-resolves nothing.

### Work through the map

User invokes with a map (URL or number). A ticket is **optional**: without one, you pick the next decision, not the user.

1. Load the **map**: the low-res view, not every ticket body.
2. Choose the ticket. If the user named one, use it. Otherwise take the first frontier ticket in order. **Claim it**: assign it to yourself before any work. To run several frontier tickets in parallel, claim each ticket and start one new pane for each: a researcher pane for a research ticket, a worker pane for a prototype ticket. Load the herdr skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. Follow [Panes](#panes): a pane is never reused, so each ticket, each fix round and each review starts a new pane.
3. Resolve it, the way its type says (see [Ticket Types](#ticket-types)). Read the facts first, in the [knowledge read order](#knowledge-read-order). **Zoom as needed**: fetch the full body of any related or closed ticket on demand; load each skill that the `## Notes` block names. If in doubt, load two skills. Load the grilling skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. Load the domain-modeling skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi.
4. Record the resolution: post the answer as a **resolution comment**, **close** the issue, and **append a context pointer** to the map's Decisions-so-far, as the "Resolve" section of the tracker document says. Then append one line to the OpenKnowledge page `projects/<project>/handoffs`.
5. Add newly-surfaced tickets (create-then-wire); graduate any fog the answer has made specifiable, clearing each graduated patch from **Not yet specified** so it lives only as its new ticket. If the answer reveals that a ticket (this one or another) sits beyond the destination, **rule it out of scope** rather than resolving it on the route. If the decision invalidates other parts of the map, update or delete those tickets.

The coordinator may run unblocked tickets in parallel panes, and the user may run other sessions, so expect concurrent edits to the tracker.

### Merge

Each ticket that changes files runs on its own branch in its own worktree. The coordinator merges a reviewed ticket branch into the main branch with a merge commit (`--no-ff`), runs the project checks on the main branch, and pushes.

Parallel tickets often edit the same list lines: a manifest list, a registry tuple, a table in a README, an expected list in a test. The coordinator does not resolve a merge conflict on the main checkout. When the merge conflicts:

1. Abort the merge.
2. Write a **merge-forward task** file. It asks for a merge of the main branch into the ticket branch. Each conflict resolves as the union of both sides in a stable order. The pane runs the project checks and commits the merge.
3. Load the herdr skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. Start a new worker pane in the worktree of the ticket and send it the task (see [Panes](#panes)).
4. Merge the ticket branch into the main branch. The merge is clean now. Run the project checks and push.

One ticket merges at a time: the next ticket merges forward after the previous ticket is on the main branch.

The review comes before the merge-forward. The merge-forward changes only the shared lines, so it needs no second review unless the checks fail.

A pane is never reused: the merge-forward pane is a new pane with its own task file, like each ticket, each fix round and each review.
