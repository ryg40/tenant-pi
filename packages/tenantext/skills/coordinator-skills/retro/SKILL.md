---
name: retro
description: "Conduct a retrospective on a coding session."
disable-model-invocation: true
---

The user has asked for a **retrospective**. You are suggesting improvements to the coding agent's **environment** to improve future runs.

## Steps

1. Load the writing-for-agents skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. It is the writing style guide.

2. Read the primary sources for the sessions the user specifies, in the order of [Session source](#session-source). If the user doesn't specify a session, default to the last 10 sessions of the current project.

3. Look for candidates for improvement in these categories.

- **Navigation**: how easy was it for the agent to find the right files? Are there hidden dependencies between files? Would a **navigation pointer** make it easier? _Use when_ the session took a long time to find a piece of information.
- **Automated checks**: are there automated checks that could catch errors the agent made? Linting, typing, tests, filesystem linters? Read the repo's own check command first (its `package.json`/build-tool `lint`/`check` scripts, its CI workflow), so a check that already exists but sits unwired or silently broken is the finding, not a reinvention. A repo with no **guardrail** (no pre-commit hook and no CI job running its lint/typecheck/test command) is itself a finding: an un-linted repo is a standing missed opportunity, not a neutral default. _Use when_ the agent made a mistake an automated check could have caught, or the repo has no guardrail at all.
- **Coding standards**: should the **reviewer** be given a new rule to enforce? Should an existing rule be removed or clarified? Classify the violation first: a **mechanical** one (a fixed syntactic pattern, a banned API, an import shape, a file-location rule) gets a deterministic check, full stop: a rule of the scan hooks (`scripts/scan.sh`, the pre-commit hook), one of the four offline checks, or a custom rule in the repo's own linter, whichever the repo's language and existing guardrail make cheapest. Default to building the check over writing the rule. Reserve the Herdr reviewer role prompt (`roles/reviewer.md` of the `herdr` skill) for genuine **judgement calls** (cross-file consistency, "matches the surrounding style," anything no guardrail could ever substitute for): one line in the role prompt for each. _Use when_ the reviewer failed to catch a mistake.
- **Global steering**: are there any steering instructions that should be moved to the reviewer role prompt (or automated checks) instead? The global steering files are the Claude Code steering file (`~/.claude/CLAUDE.md`), the Pi steering file (`~/.pi/agent/AGENTS.md`) and the role prompts of the `herdr` skill. _Use when_ a steering file is particularly large - in the repo OR the user's global scope.
- **Tool economy**: did the agent make expensive tool calls that could be streamlined? Is there any custom tooling (CLI's, MCP's) that is particularly token-inefficient? The `slopscore` component of the kit gives spend by model, role and tool from the traces of both harnesses: it is a Pi extension with the `slopscore` command, and the `tenantext:slopscore` command in Claude Code. Use its numbers for this category. The kit skill `slopscore-pr` fills the slopscore section of a pull request and is not the source of these numbers. Only when an accepted finding needs that section: load the slopscore-pr skill: the Skill tool in Claude Code, a read of its SKILL.md in Pi. _Use when_ the agent made an expensive tool call.
- **No-ops**: look for instructions in steering files that don't modify the agent's behavior. _Use when_ the steering files are large and unwieldy.
- **Information access**: look for opportunities to increase the agent's access to information. Teeing dev server logs, readonly access to third-party services. _Use when_ a crucial piece of information was not available to the agent.

4. Present these candidates to the user, in order of severity, for acceptance: three per round through the question tool of the harness, the recommended answer first. Name for each candidate the file that enforces it ([Files](#files)). Create no issue before the user accepts the finding.

5. Create one Gitea issue for each accepted finding with the create operation of `docs/agents/issue-tracker.md` (sections "Generic operations" and "Publication safety"). The issue carries the label `ready-for-agent`. When the finding needs the user of the installation, it carries `needs-approval` instead.

6. Append one line to the OpenKnowledge page `projects/<project>/handoffs` through the `okknow` skill: a summary of the retro of at most 80 characters.

## Reference

### Session source

The sessions of both harnesses are in OpenViking. The retro uses the OpenViking identity that the MCP tools of the session already use, and no other identity. The OpenViking user of the session holds the sessions under `viking://user/<user>/sessions/`:

- `cc-<id>` is a Claude Code session, `pi-<id>` is a Pi session.
- `messages.jsonl` holds the raw turns. Each turn carries `peer_id`, a project key ([Project keys](#project-keys)).
- `history/archive_NNN/messages.jsonl` holds an archived chunk of turns.
- `history/archive_NNN/memory_diff.json` holds the memories extracted from that chunk, with a summary.
- `tool-results/` holds the tool outputs of a Claude Code session.

Each Herdr worker, researcher and reviewer pane is its own session. So "the last N sessions" includes the panes of a coordinator run.

Read in this order:

1. Build the set of keys of the current project ([Project keys](#project-keys)).
2. List more sessions than N (default N is 10), for example 3N, with the OpenViking `list` tool: `uri=<sessions directory>, sort_by=mtime, sort_order=desc, limit=3N`. The list holds the sessions of each project, so N entries are not enough.
3. Read the `memory_diff.json` of each archive for the summary, and the first lines of `messages.jsonl` for the `peer_id`. A short session has no `history/` and no `memory_diff.json`: read the first and the last lines of `messages.jsonl` of that session for the summary and the `peer_id`.
4. Keep a session when its `peer_id` is in the set of keys or starts with the main checkout key. Then cut to the N most recent. When fewer than N remain, list more sessions and filter again.
5. Read the raw turns only for the categories that need tool calls: **Tool economy** and **Navigation**.
6. A Pi session captured before tool capture was turned on has no tool outputs in OpenViking. For those, fall back to the local session files of Pi under `~/.pi/agent/sessions/<cwd>/`. For Claude Code, fall back to `~/.claude/projects/<cwd>/`.

### Project keys

The `peer_id` of a session is not one key for each project. The OpenViking plugin of each harness makes the key in its own form:

- A Claude Code session carries a key derived from the Git remote of the checkout. Example shape: `<git-host>-<owner>-<repository>`.
- A Pi session carries a key derived from the working directory: the path with each `/` replaced by `-`. Example shape: `-<parent>-<checkout>` for the path `/<parent>/<checkout>`.
- A pane in a worktree carries the path key of the worktree, not of the main checkout.

The set of keys of the current project holds:

- the remote-derived key,
- the path key of the main checkout,
- the path key of each worktree under the main checkout (`git worktree list` gives the paths).

A worktree under the main checkout has a path key that starts with the main checkout key. So the prefix test also keeps a session of a worktree that is removed.

### Implementation vs Review

Remember that all work goes through two stages: implementation and review. The implementation agent has the most **context pressure**. They are responsible for exploration, writing code, and debugging failures.

The review agent has the least context pressure - it receives a diff, so no exploration needed. It often does not need to write code or debug.

This means that the review agent should be responsible for imposing coding standards, not the implementation agent.

### Files

Map each finding to the file that enforces it:

- The repository `AGENTS.md`: this file is pushed to the context window of any agent working in this repo. It holds **navigation pointers** to other files only.
- The global steering files (`~/.claude/CLAUDE.md` for Claude Code, `~/.pi/agent/AGENTS.md` for Pi) and the role prompts of the `herdr` skill: these are pushed to the context window of each session or pane. They should be used incredibly sparingly.
- The Herdr reviewer role prompt (`roles/reviewer.md` of the `herdr` skill): this file is read during review, not implementation. A judgement rule becomes one line in it. Add **navigation pointers** to docs folders if it gets more than 1,000 lines long.
- The scan hooks (`scripts/scan.sh`, the pre-commit hook) and the four offline checks: a mechanical rule becomes a check or a hook.
- Docs: use docs as references files, pointed to by other files. Look for existing docs before writing new ones.
- Skills: use skills for docs (since their description goes into the agent's context window), or for user-invoked commands. Follow the advice in the `writing-for-agents` skill.
