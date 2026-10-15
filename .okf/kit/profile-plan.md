---
type: Data Contract
title: The profile plan
description: The pure function prepare builds the plan of a profile from in-memory inputs; the plan lists files, display-only commands and readiness gaps, and the writer rebuilds it before any write.
tags: [plan, readiness-gap, generator]
resource: ../../scripts/profile_plan.py
generated: {by: claude-code/claude-opus-5-5, at: 2026-10-15T18:00:00Z}
sources:
  - id: profile-plan
    resource: ../../docs/profile-plan.md
    title: Pure profile preparation (docs/profile-plan.md)
  - id: generator
    resource: ../../docs/generator.md
    title: The offline profile CLI (docs/generator.md)
---
# The profile plan

The profile plan says what `generate` would write and what the user must still do. A pure function builds it, so the same choices give the same plan on every machine. A readiness gap in the plan names a fact that the kit cannot prove offline.

## How the plan is built

- `prepare(manifest_data, overlay_data, ...)` in `scripts/profile_plan.py` accepts only in-memory inputs.
- It reads no file, no environment value and no host catalog.
- It validates the manifest and the overlay before it renders anything.
- `scripts/model_routes.py` owns the model and gateway rules; the plan merges its contribution.

## What the plan holds

| Key | Content |
| --- | --- |
| `files` | The output paths and their modes. |
| `commands.setup` | Display-only install instructions, for example the pinned Pi install line. |
| `commands.launch` | One display-only launch line, for example `env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=<quoted target> pi --no-approve`. |
| `readinessGaps` | Each fact that stays open: runtime, package, provider, model catalog, authentication and missing roles. |

The kit never runs a command of the plan. The launch line never holds a resolved key or an executable `/login` instruction. Core settings keep `defaultProjectTrust: "ask"` and turn telemetry and analytics off.

## Readiness gaps

Every plan starts with three fixed gaps: `target_absence_unverified`, `node_runtime_unverified` and `core_runtime_unverified`. The function opens no file and starts no process, so it cannot know the target or an installed version.

`readiness(plan, ...)` applies two facts that a caller has:

- After `generate`, the target was absent, so `target_absence_unverified` leaves the list.
- A report of `check-runtime`, given with `--runtime-report`, replaces the two runtime gaps with its status: none, mismatch, missing, unparsed or untested in range.

## The private record of a profile

`.tenant-pi/choices.json` holds the validated overlay, the pinned manifest, the optional model registry with its digest, the required role names and the credential names. The writer rebuilds the plan from this record before any write and refuses a plan that differs. The record holds `${NAME}` references, never a resolved secret. Treat it as private, like the overlay.

## Links

- [The command line and the generator](generator.md)
- [The model routes](../modules/model-routes.md)
- Source document: [pure profile preparation](../../docs/profile-plan.md)
