# Tenant-pi guided configuration kit

Tenant-pi describes a portable Pi setup that an owner can adapt to a client.
This file is the project glossary that the `domain-modeling` skill reads.

## Language

**Guided configuration kit**:
Reviewed defaults, local-choice templates, validation, and setup instructions for preparing a fresh Pi setup.
It does not own an installed environment's ongoing configuration changes.
_Avoid_: Managed installer, configuration manager

**Local overlay**:
The client's private choices that adapt portable defaults to its paths, models, and services.
_Avoid_: Portable baseline, exported agent home

**Hybrid recall**:
Keyword search combined with embedding similarity to find relevant wiki pages.
An embedding is a numeric representation of text meaning.

**Hands-on trial**:
A clean-client trial in which a person performs the interactive checks that an agent cannot prove: a terminal workspace, a Pi session, a structured question, a model reply.
_Avoid_: Manual test, smoke test

**Trial account**:
A temporary Linux user created for one trial and removed after it; it holds no credential beyond the scoped key of that trial.
_Avoid_: Test user, service account

**Compose seat**:
A container, started by Compose, that holds one generated Pi profile for one user and is reached over SSH.
_Avoid_: Pi seat, container profile, sandbox
