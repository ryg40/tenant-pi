---
name: tenant-pi-install
description: Guide an agent through installing the tenant-pi kit into a Pi profile directory of the user. Use when a user asks to set up or install a Pi profile with the kit, update the kit to a new release, add an optional module, or add Codex, llama-swap or vLLM. Ask questions and follow INSTALL.md; use POST_INSTALL.md after the install.
---

# Install the tenant-pi kit into a Pi profile

Read [INSTALL.md](../../INSTALL.md) first. It holds the order, the commands and the checks. This is a question list, not a second install flow.

Use your question tool, or plain text during bootstrap. Offer two to four concrete options, with the recommended option first. Ask before each change to the machine: an install, a new directory, a link. Name credentials by environment variable, never by value. Never write into `~/.pi/agent`.

## Questions

- "Which Node do you want Pi to use?" Ask when several installs exist. Follow [the prerequisites](../../INSTALL.md#prerequisites).
- "Install Pi globally with this Node, or under your own npm prefix?" Follow [the prerequisites](../../INSTALL.md#prerequisites).
- "Which remote do you want to clone from?" Ask only when unclear. Follow [the clone](../../INSTALL.md#clone).
- "Upgrade an existing profile, or create a new alternate profile?" List the directories in `~/.pi/profiles` for an upgrade.
- "Which existing name?" or "What new name?" The name selects `~/.pi/profiles/<name>` and its alias. An inherited directory is only a suggestion. Follow [install.sh](../../INSTALL.md#run-installsh).
- "Configure Bash, Zsh, or neither?" Show the alias, launcher and startup file before approval. Zsh respects `ZDOTDIR`. Ask separately before replacing a conflicting alias, function or command; `--yes` alone does not approve it.
- "Link the skills of the kit into Claude Code?" `install.sh` links them when `~/.claude` exists.
- "Which optional modules do you want?" Ask about memory storage and recall before a memory module. Follow [the optional modules](../../INSTALL.md#optional-modules).
- "Native provider, the Tenantext gateway, or a direct provider?" "How will the key reach the Pi process?" Follow [the first start](../../INSTALL.md#first-start).

Use `--upgrade` or `--new`, `--shell`, `--with` and `--yes` for non-interactive runs. Review proposed settings changes; preserve legacy package filters. An upgrade keeps the directory and adds missing files. Shell setup follows profile success and backs up the startup file before replacing its managed block.

Record each check that did not run as "not run". End with the profile name, path, alias, startup file and command to load the alias.

For a new kit release, follow [UPDATE.md](../../UPDATE.md). For later changes, follow [POST_INSTALL.md](../../POST_INSTALL.md).
