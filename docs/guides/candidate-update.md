# Candidate update guide

The kit never updates a profile in place. Each change makes a new candidate directory. You compare it with the old one and then switch by hand. This guide follows the lifecycle of [the profile lifecycle](../profile-lifecycle.md).

## The loop

1. Edit the overlay, or pull a new kit version.
2. Regenerate into a new, absent target.
3. Compare the old and the new candidate.
4. Reconcile your local choices: carry wanted changes into the overlay, or accept them as drift.
5. Switch the launch line.

The old candidate stays as it is. It is the fallback.

## Step 1: get the new inputs

To take a new kit version:

```sh
cd "$HOME/tenant-pi" && git pull
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q
PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py
python3 scripts/tenant_pi.py check-runtime
```

The pull changes no profile. A profile reads `packages/` of the clone by path, so a pull can change what an existing profile loads at its next start. Not verified: the effect of a pull on a running Pi session.

Then edit `target.agentDir` in the overlay to a new name, for example `"/home/EXAMPLE_USER/.pi/profiles/main-2"`. Change nothing else when your choices stay the same.

## Step 2: regenerate

```sh
python3 scripts/tenant_pi.py validate --overlay "$HOME/.config/tenant-pi/overlay.json"
python3 scripts/tenant_pi.py generate --overlay "$HOME/.config/tenant-pi/overlay.json" \
  --target "$HOME/.pi/profiles/main-2" \
  --launcher "$HOME/.config/tenant-pi/launch-main-2.sh"
```

Use the same `--registry`, `--local-dir` and `--require-role` options as before. `generate` refuses an existing target, so the old candidate cannot change.

To see every candidate under one parent, with the kit commit and the generation time of each:

```sh
python3 scripts/tenant_pi.py list --parent "$HOME/.pi/profiles"
```

`list` reads only `<child>/.tenant-pi/state.json` of each direct child. It marks no candidate as current and deletes nothing. See [the candidate list](../candidate-list.md).

## Step 3: compare

```sh
python3 scripts/tenant_pi.py compare --left "$HOME/.pi/profiles/main" \
  --right "$HOME/.pi/profiles/main-2" > "$HOME/.config/tenant-pi/report-main.json"
```

`compare` reads at most the declared files of the two sides and writes nothing. Read these keys of the report:

| Key | Meaning |
| --- | --- |
| `changes` | Declared fields that differ. A private field shows as a marker, without a value. |
| `unsupported` | Fields that the comparison does not interpret, for example a key that Pi wrote. |
| `accepted` | Differences that the `unmanaged` list of the overlay accepts, with the reason. |
| `markers` | `generatedAt` and `kitCommit`. They differ between any two generations. |
| `left.drift`, `right.drift` | `status: "owner_edits"` lists the `settings.json` keys that changed after generation. |

Two candidates of the same overlay and kit differ only in `/overlay/target/agentDir` and in the markers. The live profile can be a side too: it compares as `settings_only`. See [candidate comparison](../candidate-compare.md).

To list the packages, extensions, skills and prompts of one directory by name:

```sh
python3 scripts/tenant_pi.py inventory --dir "$HOME/.pi/profiles/main"
```

## Step 4: reconcile local choices

A candidate comes from the overlay, not from the previous candidate. A change that you made inside Pi does not reach the next candidate by itself. For each difference, choose one of three actions.

### Carry it into the overlay

When the right side records an overlay change in a user-owned key, `carry` prints the overlay patches:

```sh
python3 scripts/tenant_pi.py carry --report "$HOME/.config/tenant-pi/report-main.json" \
  --overlay "$HOME/.config/tenant-pi/overlay.json" --right "$HOME/.pi/profiles/main-2"
```

- `carry` prints only. It writes no file. Apply each patch to the overlay by hand after review.
- The user-owned keys are `roles`, `modelRoutes`, `selection`, `endpoints`, `env`, `ownerPackages`, `unmanaged`, `memory` and `ownerResources`.
- `consent` is never carried. A consent change is under `notCarried` with the reason `consent_decision`. Set `consent` in the overlay by hand after your own decision.
- A hand edit of `settings.json` inside Pi, for example `/model`, is `rendered_field` under `notCarried`. Carry it by hand with the table of [candidate comparison](../candidate-compare.md#drift-owner-edits-inside-a-candidate).
- `--right` must be the exact `right.path` of the report.

See [carry](../carry.md).

### Accept it as drift

Some keys have no overlay field, for example `npmCommand` of the peer-override wrapper. List the pointer in `unmanaged` with a reason:

```json
{"unmanaged": [{"key": "/npmCommand", "reason": "Host wrapper for npm; reviewed."}]}
```

The next `compare` reports that key under `accepted`. The kit writes no accepted value into a new candidate. Apply the value by hand after review, or let Pi write it again. See [accepted drift](../accepted-drift.md).

### Drop it

Do nothing. The next candidate does not have the change.

## After a native Pi operation

Pi can write `settings.json` of a profile on its own. Examples: `pi update --extensions`, `pi install`, `/model`, a settings change in the interface, a `/resources` toggle, and the `npmCommand` wrapper setup.

After each such operation:

1. Run `compare` again. Put the previous candidate on the left and the changed candidate on the right. The drift section of a side compares its `settings.json` with its own recorded choices, so the other side can be any candidate.
2. Read `right.drift.fields`. Each listed key changed after generation. Example: `/npmCommand` and `/defaultThinkingLevel` show there after such an edit.
3. Carry, accept or drop each change as in Step 4.

The drift stays visible on purpose. The kit does not hide or revert it. An accepted key still shows in `drift.fields`.

## Step 5: switch profiles

Switching is a launch choice. Run the launcher file of the candidate you want:

```sh
"$HOME/.config/tenant-pi/launch-main-2.sh"
```

To go back, run the launcher of the old candidate. Without launcher files, use the `commands.launchDisplayOnly` line of each plan. The line sets `PI_CODING_AGENT_DIR` and removes `PI_CODING_AGENT_SESSION_DIR` for one process.

Limits of a switch:

- Each candidate authenticates and installs its declared packages on its own. Run setup Stages 6 and 7 for the new candidate. The kit copies no auth, sessions, memory or packages.
- Going back is not a data rollback. Data that a session wrote into a candidate stays there.
- The live `~/.pi/agent` stays untouched. Replacing it is your manual decision and is out of scope of the kit.
- Old candidates stay on disk. The kit deletes nothing. Remove an old candidate by hand only after you checked that no launcher points at it.

Warning: `rm -rf` of the wrong directory deletes `auth.json`, sessions and memory. Run `list --parent` and read the path twice before a removal.
