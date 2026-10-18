---
name: to-spec
description: "Synthesize the current conversation into a spec at the confirmed planning level and publish it to the project issue tracker."
disable-model-invocation: true
---

Synthesize the current conversation and codebase understanding into a spec at the confirmed level.
Read `docs/agents/planning-levels.md` for the level, horizon, evidence and safety floor.

The issue tracker is Gitea. `docs/agents/issue-tracker.md` is the contract for each tracker operation and for the label vocabulary (section "Labels"). Read it before you publish. If the checkout has no issue tracker, stop and report it.

## Before you write

Read the knowledge sources in this order:

1. The `<openviking-context>` block that the session injects.
2. OpenViking `search` with `mode=context`.
3. OpenKnowledge through the `okknow` skill: `okknow search` and the pages under `projects/<project>/`.
4. In Pi only: the LLM-WIKI tools `wiki_search` and `wiki_recall`.

## Process

1. Read the confirmed level from the map first. For a new effort, recommend a level and ask the owner to confirm it before detailed planning. For a legacy map, use the contract's existing-behavior rule.

2. Explore the repo to understand the current state of the codebase, if you haven't already. Read `GLOSSARY.md` first. Use the project's domain glossary vocabulary throughout the spec, and respect any ADRs in the area you're touching. Read the knowledge sources of the section "Before you write" in this step.

3. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better - the ideal number is one.

Check with the user that these seams match their expectations. Use the question tool: `AskUserQuestion` in Claude Code, `ask_user_question` in Pi. Ask at most three questions per round, with the recommended option first. With no question tool, ask in plain text with no emoji. The forms are in the section "How to ask, by harness" of `grilling`. Load the grilling skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi.

4. Write the spec with the level-scaled template below. Record later slices under Further Notes. Start the title with `Spec:`. Publish it as one Gitea issue through `docs/agents/issue-tracker.md`, sections "Generic operations", "Labels" and "Publication safety". Apply `ready-for-agent` to mark the spec ready for `to-tickets`. `to-tickets` removes that label from the spec after it publishes the tickets. The tracker frontier excludes `Spec:` titles. When a map exists, apply `wayfinder:parent:<map>` and refer to the map with a named link. Keep the spec on the tracker.

The spec can enter the public docs. Then its body follows the public-text rule: no owner or account name, no private domain or URL, no machine path (`~/...` is acceptable), no dated host observation and no private issue number.

<spec-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

Scale the numbered story list to the level and name its evidence:

| Level | Stories and evidence |
| --- | --- |
| `quick and dirty` | A short list for the experiment, with the check or hands-on trial that answers its question. |
| `brownfield` | Focused stories for the usable change, with integration and rollback evidence. |
| `enterprise` | An extensive list covering all aspects of the feature, with evidence for its behavior and operational guarantees. |

Use this form for each story:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

Keep the active stories within the next usable deliverable.

## Implementation Decisions

For quick and dirty, keep decisions short and mark them reversible.
For brownfield, focus on the change and include integration and rollback notes.
For enterprise, give the full list of decisions, including the applicable items below:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.

## Testing Decisions

For quick and dirty, write one testing line naming the evidence that answers the experiment's question.
For brownfield, name focused checks and the integration and rollback evidence.
For enterprise, give the full testing decisions below and the evidence for the promised operational guarantees:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this spec.

## Further Notes

Record the confirmed level and any further notes about the feature.
Keep later slices here as roadmap lines for a later usable deliverable.

</spec-template>
