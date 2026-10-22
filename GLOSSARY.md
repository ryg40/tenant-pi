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

**Refusal rules**:
The location checks of `install.sh` that protect the live profile `~/.pi/agent` and the clone.
The comment at the top of `install.sh` states them. See [install.sh](INSTALL.md#run-installsh).

