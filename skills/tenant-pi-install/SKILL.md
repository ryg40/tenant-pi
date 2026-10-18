---
name: tenant-pi-install
description: Guide an agent through installing a separate Pi profile with the tenant-pi kit. Use when a user asks to set up, install, migrate, or rebuild a Pi profile, add an optional module, or add Codex, llama-swap or vLLM. Ask questions and follow INSTALL.md; use POST_INSTALL.md after a base install.
---

# Install a Pi profile with the tenant-pi kit

Read [INSTALL.md](../../INSTALL.md) first. It holds the stage order, commands, approval rules and checks. This is a question list, not a second install flow.

Use your question tool, or plain text during bootstrap. Offer two to four concrete options, with the recommended option first. Ask before each change. Name credentials by environment variable, never by value.

## Questions

- "Do you already run Pi here?" Follow [inventory](../../INSTALL.md#stage-0-inventory); keep the existing profile unchanged.
- "Which Node do you want Pi to use?" Follow [requirements](../../INSTALL.md#stage-1-requirements) when several installs exist.
- "Which remote do you want to clone from?" Ask only when unclear; follow [clone and check](../../INSTALL.md#stage-2-clone-and-check-the-kit).
- "Install Pi globally with this Node, or do you manage global npm packages another way?" Follow [the Pi decision](../../INSTALL.md#stage-3-install-pi).
- "Install on this machine, on a remote Linux host over SSH, or in a container on this machine?" Confirm before changes. Follow [destination, account and paths](../../INSTALL.md#stage-4a-herdr-and-the-question-tool).
- "Where do you want the Herdr skill?" "Structured questions in Pi?" Follow [Herdr and the question tool](../../INSTALL.md#stage-4a-herdr-and-the-question-tool).
- For a container, ask [the eight seat questions](../../INSTALL.md#stage-4c-the-compose-seat).
- "Where should the new profile live?" Follow [the private overlay](../../INSTALL.md#stage-5-the-private-overlay).
- "Which components do you want?" Use [the checklist](../../INSTALL.md#the-checklist). Review the full plan before changes.
- Ask explicitly about memory storage and recall consent. With wiki, follow [the vault check](../../INSTALL.md#the-llm-wiki-vault).
- "MCP servers through the adapter?" Follow [the overlay choices](../../INSTALL.md#stage-5-the-private-overlay).
- "Generate now into `<target>`?" Follow [plan and generate](../../INSTALL.md#stage-6-plan-and-generate).
- Ask before the selected [package dependencies](../../INSTALL.md#stage-4-package-dependencies) and [declared npm packages](../../INSTALL.md#stage-7-declared-npm-packages).
- "Native provider or the Tenantext gateway?" "How will the key reach the Pi process?" Follow [authentication](../../INSTALL.md#stage-8-authentication).
- "Which providers do you want in this profile?" Follow [direct providers](../../INSTALL.md#direct-providers-codex-llama-swap-and-vllm).
- "Does a Pi run in your live profile now?" Follow [first launch and checks](../../INSTALL.md#stage-9-first-launch-and-checks).

At completion or an earlier stop, follow [the results file](../../INSTALL.md#the-results-file). Record checks that did not run as "not run". End with the full path of the results file, or the next step when the clone does not exist.

For later changes, follow [updates](../../INSTALL.md#stage-10-updates) and [POST_INSTALL.md](../../POST_INSTALL.md). The kit changes no profile in place.
