---
type: Project
title: The guided configuration kit
description: tenant-pi checks the private choices of a client offline and generates a new, separate Pi profile; it installs nothing and stores no credential.
tags: [kit, overview, pi-profile, lifecycle]
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:00:00Z}
sources:
  - id: readme
    resource: ../../README.md
    title: The kit overview (README.md)
  - id: glossary
    resource: ../../GLOSSARY.md
    title: The project glossary (GLOSSARY.md)
  - id: lifecycle
    resource: ../../docs/profile-lifecycle.md
    title: The profile lifecycle (docs/profile-lifecycle.md)
  - id: explainer
    resource: ../../EXPLAINER.md
    title: The installation explainer (EXPLAINER.md)
---
# The guided configuration kit

tenant-pi is a guided kit for a Pi profile. A Pi profile is the configuration directory of one Pi agent setup. The user writes the choices into a private JSON overlay, and the kit checks them offline and generates a new, separate profile directory.

## What the kit does

- It validates the overlay offline.
- It prints a plan: the files, the readiness gaps and the commands that the user runs by hand.
- It writes a new profile into a target directory that does not exist yet.
- It compares two profiles and prints overlay patches for wanted drift.

## What the kit never does

- It never edits an existing profile. The live `~/.pi/agent` stays a fallback, not a target.
- It installs no package and starts no service.
- It stores no credential and prints no secret value.
- It makes no network request and no model call.

## The nine stages

The kit runs stages 1 to 5. Stages 6 to 9 belong to the user, and the kit runs none of their commands.

1. Obtain the sources: clone the kit and run its offline checks.
2. Edit the local choices: create the private directory and edit the overlay.
3. Validate the overlay.
4. Plan the profile.
5. Generate the profile into a new, absent target.
6. Install the dependencies by hand: Node 24, Pi and the packages of the enabled modules.
7. Authenticate: Pi `/login`, or a key in the launching shell.
8. Launch Pi with the launcher file or the launch line of the plan.
9. Test, and record each check as passed, failed, blocked or not run.

## The three tiers of a profile

| Tier | Examples | Home | How Pi gets it |
| --- | --- | --- | --- |
| Kit-managed | Core settings, model routes, components | The kit and the private overlay | `generate` writes it |
| Repo-owned | A skills or extension repository of the user | That repository | A package path in `settings.json` |
| Host-only | `auth.json`, sessions, memory stores | The profile directory | Pi writes it at run time |

A change goes through the overlay or the kit. The user generates a new profile into a new target, compares the old and the new profile, and switches the launch line. Never hand-edit a generated `settings.json`.

## Status

The kit is a portable release candidate. Linux is the first target. The offline stages are tested. Not verified: a complete live run on a clean client, with authentication and a model reply. macOS, Windows, browser-hosted Pi and Pi inside Herdr are not qualified.

## Terms

| Term | Meaning |
| --- | --- |
| Guided configuration kit | Reviewed defaults, templates, validation and setup instructions for a fresh Pi setup. |
| Local overlay | The private choices that adapt the portable defaults to one client. |
| Hands-on trial | A clean-client trial in which a person does the interactive checks that an agent cannot prove. |
| Compose seat | A container that holds one generated profile for one user and is reached over SSH. |

## Links

- [The command line and the generator](generator.md)
- [The private overlay](private-overlay.md)
- [The publishing flow and the snapshot](../process/publishing.md)
- Source documents: [README.md](../../README.md), [GLOSSARY.md](../../GLOSSARY.md), [the profile lifecycle](../../docs/profile-lifecycle.md)
