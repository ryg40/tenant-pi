# Agent Loop Effort Score

The score describes recorded development effort, not software correctness.
It combines trace data, Git history, review records and test evidence.
Missing evidence does not prove that work occurred.

## Seven criteria

| Criterion | Maximum | Scoring rule | Evidence |
| --- | ---: | --- | --- |
| Coordinator model | 20 | Effort share multiplied by 20 | Harness traces |
| Independent review | 15 | Full marks: separate reviewer context at T3 xhigh or better, two model families, findings fixed before merge. Half: one family or self-review. Zero: no review. | Review records and reviewer roles in traces |
| Planning artifacts kept | 15 | Map, specification, tickets and decisions: 3.75 each at or before the first code commit, 1.875 each after it; round the sum | `slopscore --repo` |
| Git history proves the path | 15 | Commit count: up to 3. Ticket-reference share: up to 5. Fix or review commits: up to 4. Active days: up to 3. | `slopscore --repo` |
| Iterations multiplied by model quality | 20 | Three points per code commit after the first ship, multiplied by the trailer model's tier weight; round the sum and cap at 20 | `slopscore --repo` |
| Context bundle kept current | 10 | Conformance: 3. Current log: 2. Maintenance coverage: up to 5. Subtract 1 per stale concept, with a zero floor. | `slopscore --repo` or `slopscore okf` |
| Live verification | 5 | Full marks: real sessions on at least two target models, unit tests and typecheck. Half: unit tests only. Zero: no adequate evidence. | Test evidence |

The CLI computes model, history, planning, iteration and bundle points.
Review and live-verification points require the corresponding evidence.
See [the package README](../README.md#slopscore) for trace sources, model tiers and commands.

Effort share is the sum of spend multiplied by tier weight and thinking factor, divided by total spend.
The tier table lives in `slopscore/src/tiers.ts`.
Override it with `SLOPSCORE_CONFIG` or `~/.pi/agent/slopscore/tiers.json`.

Planning paths are `docs/plan/map.md`, `docs/plan/spec.md`, `docs/plan/tickets/` and `docs/plan/decisions.md` in the scored repository.
These are inputs to the score, not required files in this package.

History points sum four parts, then round the total:

- Commit count: 0.6 per commit, capped at 3.
- Ticket references: the share of commits with references, multiplied by 5.
- Fix or review commits: 1 per matching commit, capped at 4.
- Active days: 3 for at least three days, 2 for two days, otherwise zero.

## Context bundle points

The checker reads committed Git objects only.
A bundle root has an `index.md` that declares `okf_version`; the shortest matching path wins.

| Part | Points | Rule |
| --- | ---: | --- |
| Present and conformant | 3 | Every other Markdown file under the bundle has frontmatter with a non-empty `type`. Non-conformant bundles earn zero here. |
| Log current | 2 | The root `log.md` has an entry on or after the last code-commit day, with a one-day grace period. |
| Kept current | 0 to 5 | The share of code-commit days with a bundle change that day or the next, starting at the bundle's first commit. |
| Stale concepts | Minus 1 each | `stale_after` has passed, or `verified` predates the last commit that changed a local `sources` path. Date-only values mean midnight UTC. |

Version 0.1 and 0.2 bundles score the same.
Bundle-only commits earn no code iteration points.
A one-shot repository earns zero bundle points.

## Grades and one-shot limits

| Total | Grade | Suggested reading |
| ---: | --- | --- |
| 90 to 100 | A | Strong recorded effort; verify suitability before adoption. |
| 75 to 89 | B | Read the review records before adoption or a fork. |
| 60 to 74 | C | Review a fork before use. |
| 40 to 59 | D | Limited evidence; compare rebuild and review costs. |
| 0 to 39 | F | Little evidence of review or continued maintenance. |

No history, one commit, or all commits within 12 hours on one day triggers the one-shot flag.
The flag overrides the normal points.

| One-shot evidence | Provenance cap, out of 50 | Overall cap |
| --- | ---: | --- |
| No specification and no T1 or T2 model trailer | 8 | 39, F |
| Specification or decisions kept | 14 | 39, F |
| T1 or T2 model signed the commits | 14 | 39, F |
| Both specification and T1 or T2 model evidence | 20 | 59, D |

## Pull request evidence

### Reading a PR block

The `## slopscore` block reports the branch scope, trace effort and commit evidence.
It does not assert that a reviewer found every defect.

- The scope row gives the session, call and day counts.
- Effort share and model points describe the weighted model spend.
- The role table shows recorded reviewer work. Missing reviewer rows mean the traces do not show it.
- The provenance line gives model trailers, ticket references and fix or review commits.
- Flags identify missing traces, missing trailers or a changed tier configuration.
- The bundle line reports concept count and maintenance coverage for the branch.

See [the rendered block example](../README.md#the-pr-block) for the exact output format.
