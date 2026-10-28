# Tenant-pi guided configuration kit

Tenant-pi describes a portable Pi setup that an owner can adapt to a client.
This file is the project glossary that the `domain-modeling` skill reads.

## Language

**Guided configuration kit**:
Reviewed defaults, templates, checks, and setup instructions for preparing a fresh Pi setup.
It does not own an installed environment's ongoing configuration changes.
_Avoid_: Managed installer, configuration manager

**Profile directory**:
The Pi agent directory of `PI_CODING_AGENT_DIR` that `install.sh` writes the templates into, only when each file is absent.
After the install, the user owns its files.
_Avoid_: Generated profile, candidate

**Hybrid recall**:
Keyword search combined with embedding similarity to find relevant wiki pages.
An embedding is a numeric representation of text meaning.

**AgentCore Memory**:
An AWS service that stores memory records and finds relevant records through semantic search.
It is separate from the local memory stores.

**Hands-on trial**:
A clean-client trial in which a person performs the interactive checks that an agent cannot prove: a terminal workspace, a Pi session, a structured question, a model reply.
_Avoid_: Manual test, smoke test

**Trial account**:
A temporary Linux user created for one trial and removed after it; it holds no credential beyond the scoped key of that trial.
_Avoid_: Test user, service account

**Pi-Bolt**:
The Pi coding agent compiled ahead of time to one native executable, with the commands, settings and extensions of Pi.
`install.sh --runtime pi-bolt` makes it the runtime of a profile. `pi-bolt --version` prints the Pi version first.
_Avoid_: Bolt

**Refusal rules**:
The location checks of `install.sh` that protect the live profile `~/.pi/agent` and the clone.
The comment at the top of `install.sh` states them. See [install.sh](INSTALL.md#run-installsh).


**Computer-use module**:
The optional module `computer-use`: the npm package `@agent-sh/computer-use-linux` at the exact version of `config/manifest.json`, for Linux only.
Its tools read the screen and send input to the desktop of the user, so `install.sh` installs it only after a yes to desktop control. The module for macOS is `computer-use-macos`: the npm package `@amaster.ai/pi-computer-use` with Cua Driver, for macOS only.
See [computer use](docs/guides/modules.md#computer-use) and [computer use on macOS](docs/guides/modules.md#computer-use-on-macos).
_Avoid_: Desktop module, cua

**Desktop tools**:
The tools of the computer-use modules: `computer_use_linux_*` (Linux) and `computer_use_*` (macOS) in Pi, and the MCP server of the Claude Code plugin `computer-use-linux@computer-use-linux`.
The Herdr read roles start without them.
