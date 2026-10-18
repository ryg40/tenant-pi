# Planning levels

This document is the contract for the level, horizon and evidence of an effort.
The [issue tracker document](issue-tracker.md) defines tracker operations and the tracker frontier.

## Level

Before detailed planning, the agent recommends a level and the owner confirms it.
Record the confirmed value as `Level: <value>` under the map Notes.

| Value | Deliverable | Evidence | Documents |
| --- | --- | --- | --- |
| `quick and dirty` | A disposable experiment or prototype that answers one question. | One check or hands-on trial answers the question at the safety floor. | A short story list, reversible decisions and one testing line. |
| `brownfield` | A usable change integrated with the surrounding system. | Focused checks prove the changed behavior, integration and rollback path. | Focused stories and decisions, integration and rollback notes, and focused Testing Decisions. |
| `enterprise` | A production candidate with the agreed operational guarantees. | Tests cover the promised behavior, failure paths and operational guarantees. | An extensive story list, detailed implementation decisions and full Testing Decisions. |

Brownfield is the middle integration profile, whatever the age of the project.
A component override occupies one line in the map Notes: `Level override: <component> = <value>; <reason>`.
The owner confirms the override before detailed planning for that component.
A map without a `Level:` line keeps today's behavior: the existing planning flow and full spec template.

## Horizon

Every level plans the next usable deliverable.
Rigor sets the evidence required for it.
Decision tickets and build tickets belong to that same horizon.
A sharp later question waits in the map's "Not yet specified" section.
Later slices of a spec belong under Further Notes.

## Safety floor

Every level keeps one safety floor:

- Scoped credentials.
- Isolated production data.
- A cost cap.
- Cleanup steps.
- Owner approval for destructive or live actions.

Quick and dirty stops at the safety floor.

## Deferred and retired tickets

A deferred ticket is closed with its intent kept as a roadmap line.
A retired ticket is closed with its intent kept only in history.
The roadmap of a map is its "Not yet specified" section.
The roadmap of a spec is its Further Notes.
Keep the reason and a named link with each closed ticket's record.

## Drift

Drift records a changed assumption under the map Notes.
Use `Drift (YYYY-MM-DD): <one line>`.
A retired ticket gets one line there with a named link and the reason for retirement.
The linked ticket keeps the detailed history.
