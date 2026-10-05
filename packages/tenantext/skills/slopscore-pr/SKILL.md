---
name: slopscore-pr
description: Put the slopscore block into a pull request. Runs `slopscore pr`, shows the block, offers Co-Authored-By trailers for branch commits that lack one, and fills the `## slopscore` section of the open PR through gh or the Gitea API. Use when the user wants the effort score, the slopscore block or the model trailers on a PR or a branch.
---

# slopscore-pr

The block reports which models did the work on this branch, at what thinking level, how many sessions and commits it took, and whether a reviewer ran. Traces stay on this machine. Only the block leaves it.

All commands run from the repository root. Print command output as it is. Do not summarise the block.

## 1. Print the block

```sh
node --experimental-strip-types --no-warnings slopscore/src/cli.ts pr
```

Pass the user's flags through: `--base REF` when the branch point is wrong, `--no-spend` to hide the dollar figure. Exit code 1 prints one line with the reason; show it and stop.

## 2. Offer the trailers

When the flag line says `N commits without a model trailer`, run the dry run:

```sh
node --experimental-strip-types --no-warnings slopscore/src/cli.ts pr --add-trailers
```

Show the table. Then ask once: "Rebase the branch and add these trailers? The branch history is rewritten." Stop here unless the user says yes.

On yes, rerun with `--yes`. When the command refuses because the branch is on a remote, show the refusal and ask once more before adding `--force`. After a rewrite the command prints the force-with-lease line for the user to run. Never run that line yourself. Then print the block again, so the trailer count is current.

## 3. Put the block into the PR

Run the helper `scripts/pr-body.mjs` from the directory that holds this SKILL.md, with the block on stdin. Use the absolute path of that directory, wherever the skill is installed. The helper finds the open PR for the current branch, on `upstream` first and then `origin`, on GitHub through `gh` and on any other host through the Gitea API with `GITEA_TOKEN`, and prints the new PR body:

```sh
node --experimental-strip-types --no-warnings slopscore/src/cli.ts pr | node <skill directory>/scripts/pr-body.mjs
```

The helper replaces only the `## slopscore` section of the body. When the body has no such section, it appends one. Nothing else in the body changes.

Show the user the section that would change. Ask once: "Update the PR body?" On yes, rerun with `--apply`.

When the helper reports no open PR, no `gh` login or no `GITEA_TOKEN`, it prints the block and the paste instruction. Show both and stop. The user pastes the block under `## slopscore` in the PR body.

## Rules

- Never push, never merge, never open a PR. The user does those.
- Never edit commit messages by hand. `--add-trailers --yes` is the only rewrite.
- Ask once before the rebase and once before the PR body edit. Do not ask about anything else.
- Never write the raw traces, session ids, paths or token counts anywhere. The block is the only output that leaves the machine.
