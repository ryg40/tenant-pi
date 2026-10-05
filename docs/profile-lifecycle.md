# Profile lifecycle

The kit supports each step of the profile lifecycle. See [profile inventory](profile-inventory.md), [owner package paths](owner-packages.md), [accepted drift](accepted-drift.md), [carrying drift into the overlay](carry.md), [the launcher file](launcher.md), [the candidate list](candidate-list.md), [the runtime version check](check-runtime.md), [the private directory](private-directory.md) and [owner skill and prompt directories](owner-resources.md).

## The model in one page

The kit does not manage a live Pi directory. It builds a new one. Four facts follow from that:

1. **Three tiers, one home each.** A Pi profile is made of three kinds of thing. Each kind has exactly one place where it is edited.

   | Tier | Examples | Home | How Pi gets it |
   | --- | --- | --- | --- |
   | Kit-managed | core settings, model routes, Tenantext components, MCP, Hermes, wiki | the kit (generic values) plus the private overlay (host values) | `generate` writes it into the profile |
   | Repo-owned | a skills or extension repo the user maintains | that repo | a `packages` path in `settings.json`, or a project `.agents/skills` directory; `git pull` is the install |
   | Host-only | `auth.json`, sessions, memory stores, caches, `npm/` | the profile directory | Pi writes it at run time |

2. **Change path.** Edit the overlay or the kit. Regenerate into a new dated target. Run `compare` between the old and the new candidate. Switch the launch line. Never hand-edit a generated `settings.json`.

3. **Drift is visible, not prevented.** Pi itself may write to a profile. The next `compare` shows the difference. The user carries wanted drift into the overlay and records the rest as accepted drift.

4. **The live `~/.pi/agent` is a fallback, not a target.** It stays untouched until a candidate is good enough to replace it.

A profile adopted this way is reproducible from two clones: the kit and the private directory that holds the overlay, the registry, the install log and the accepted-drift list.

## Out of scope

An ownership manager, in-place updates, automatic deletes of old candidates, migration of sessions or memory, and automatic package installation stay excluded.
