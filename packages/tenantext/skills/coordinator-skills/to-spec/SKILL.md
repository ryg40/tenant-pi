---
name: to-spec
description: "Turn the current conversation into a spec and publish it to the project issue tracker: no interview, just synthesis of what you've already discussed."
disable-model-invocation: true
---

This skill takes the current conversation context and codebase understanding and produces a spec. Do NOT interview the user; just synthesize what you already know.

The issue tracker is Gitea. `docs/agents/issue-tracker.md` is the contract for each tracker operation and for the label vocabulary (section "Labels"). Read it before you publish. If the checkout has no issue tracker, stop and report it.

## Before you write

Read the knowledge sources in this order:

1. The `<openviking-context>` block that the session injects.
2. OpenViking `search` with `mode=context`.
3. OpenKnowledge through the `okknow` skill: `okknow search` and the pages under `projects/<project>/`.
4. In Pi only: the LLM-WIKI tools `wiki_search` and `wiki_recall`.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Read `GLOSSARY.md` first. Use the project's domain glossary vocabulary throughout the spec, and respect any ADRs in the area you're touching. Read the knowledge sources of the section "Before you write" in this step.

2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better - the ideal number is one.

Check with the user that these seams match their expectations. Use the question tool: `AskUserQuestion` in Claude Code, `ask_user_question` in Pi. Ask at most three questions per round, with the recommended option first. With no question tool, ask in plain text with no emoji. The forms are in the section "How to ask, by harness" of `grilling`. Load the grilling skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi.

3. Write the spec using the template below, then publish it as one Gitea issue with the create operation of `docs/agents/issue-tracker.md` (section "Generic operations"; follow its section "Publication safety"). Apply the `ready-for-agent` triage label - no need for additional triage. On a spec, `ready-for-agent` means that the spec is ready for `to-tickets`, not for a worker. `to-tickets` removes the label from the spec after it publishes the tickets, so the spec does not stay in a worker frontier. When a map exists for this work, also apply the parent label `wayfinder:parent:<map>`, where `<map>` is the number of the map, and refer to the map with a named link. Do not write the spec to a local file.

The spec can enter the public docs. Then its body follows the public-text rule: no owner or account name, no private domain or URL, no machine path (`~/...` is acceptable), no dated host observation and no private issue number.

<spec-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

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

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this spec.

## Further Notes

Any further notes about the feature.

</spec-template>
