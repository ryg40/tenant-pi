# Release checklist

A portable release is a snapshot of the reviewed publish set on the branch `portable`. This checklist lists the gates before a snapshot and the steps that publish it. A passed gate is a fact for this release only. It is not a claim about a later release.

Record each gate as passed, failed, blocked or not run. Never write "passed" for a gate that did not run.

## Gates

| Gate | Command or evidence | Required |
| --- | --- | --- |
| 1. Offline unit tests | `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q` prints `OK` | Yes |
| 2. Examples | `PYTHONDONTWRITEBYTECODE=1 python3 scripts/examples.py` prints `examples valid` | Yes |
| 3. Sample overlay | `PYTHONDONTWRITEBYTECODE=1 python3 scripts/validate.py --overlay config/config.example.json` prints `valid: ...` | Yes |
| 4. Publish set | `PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py` prints `publish set valid: ...` | Yes |
| 5. Scanner | `scripts/scan.sh all` exits with 0. On `portable` the level is `fail`. Record the result line. | Yes |
| 6. Clean Linux core trial | A core-only profile on a clean Linux user: setup Stages 1 to 9, with Stage 9 checks 1, 2 and 4 recorded. | Yes |
| 7. Optional live services | Each optional module, the gateway and each MCP server: passed, failed, blocked or not run. | Report only |

Gates 1 to 4 are the four offline checks that `scripts/publish_portable.py` runs itself. Gate 1 includes [the documentation check](#documentation-check). The test `DocCheckRepoTests` of `tests/test_doc_check.py` runs it on the publish set. A finding fails the unit tests. Run the tests with `unittest`, not `pytest`: see [troubleshooting](troubleshooting.md#the-publish-check-fails-after-pytest).

Gate 1 also includes the skill text check of the component `coordinator-skills`. The test `tests/test_skill_invariants.py` reads each shipped skill of `packages/tenantext/skills/coordinator-skills/` and the label table of [the issue tracker document](../agents/issue-tracker.md). A finding fails the unit tests.

A pin move changes two tracked files: `config/manifest.json` and the reviewed core anchor in `scripts/validate.py`.
Use `scripts/pi_update.py` function `pin_contents` for both edits; the CI request calls the same function.
`runtime.piVersion` is the tested version. `runtime.piAcceptedRange` is the accepted range.
A changed stable pin automatically sets `>=<new version> <next minor>` in the same manifest edit.
The range therefore moves with the pin, including a move to another minor or major line.
A same-pin call preserves a separately reviewed range. The validator requires the tested version inside the range.
Replace `<new version>` with the approved version. Run this block from the kit root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 - <<'EOF'
from pathlib import Path
from scripts.pi_update import pin_contents

contents = pin_contents(Path("config/manifest.json").read_text(encoding="utf-8"),
                        Path("scripts/validate.py").read_text(encoding="utf-8"), "<new version>")
for name, content in contents.items():
    Path(name).write_text(content, encoding="utf-8")
EOF
```

Warning: this block replaces both tracked files. Keep a copy of any uncommitted edits before you run it.

To use a separate reviewed range, pass `accepted_range="<reviewed range>"` to `pin_contents`.
This still changes only those two files. Review the range before accepting the candidate.
Bounds use stable versions. A prerelease pin needs an explicit range with a lower stable bound before its numeric version.
Otherwise the automatic lower bound excludes that prerelease and the editor refuses the move.
See [the prerelease rule](../check-runtime.md#comparison).

Tests read the current pin from the manifest. Guides point to `runtime.piVersion` instead of copying its value.
Historical observations and package-specific dependency pins stay fixed; review them before qualifying a new release.
Run the offline gates on the candidate copy before accepting the move.

### Gate 6: the clean Linux core trial

- Use a Linux user with no Pi profile of its own, no kit credentials and no optional services.
- Follow [the setup guide](setup.md) with a core-only overlay.
- Record the Pi version, the Node version and the Python version from `check-runtime`.
- Record the `check-baseline` result for `~/.pi/agent` of that user (setup Stage 9 check 4). For a user with no Pi profile the result is `unchanged`, with `was` and `now` both `absent`.
- A model reply (Stage 9 check 3) needs a credential. Report it separately as passed, failed, blocked or not run.

Not verified: this gate with the kit pin in `config/manifest.json`, key `runtime.piVersion`.

### Gate 7: optional live services are never implied

A release note names each optional module, route and service with its result. These are examples of honest lines:

- `wiki`: not run.
- Gateway route: blocked, no key on the test client.
- `mcp`, server `example`: not run.

Do not write "all modules work" when only the core trial ran. Do not describe a documentation review or an offline `generate` as a live installation.

## Platforms that are not qualified

These platforms are not qualified in this release. A guide may give an adaptation for them, but marks it unqualified.

| Platform | Status | Evidence that would change the status |
| --- | --- | --- |
| macOS | Not qualified | Gate 6 on a clean macOS user with Homebrew or nvm Node, plus the tests and the publish check on that host. |
| Windows, also WSL | Not qualified | Gate 6 under WSL or native Windows; the kit uses POSIX paths and modes, so a native Windows run also needs a code review. |
| Browser-hosted Pi | Not qualified | Gate 6 with Pi started from a browser terminal, with the launch environment checks of [the setup guide](setup.md#shells-that-do-not-inherit-your-variables). |
| Pi inside Herdr | Not qualified | Gate 6 with Pi started in a Herdr pane, plus the `herdr` component loaded and used once. |

Each run needs a record with the exact commands, the versions, and each check as passed, failed, blocked or not run. The maintainer of the release accepts the record before the status changes.

## Publish steps

These steps come from [publishing](../publishing.md).

1. Commit every change on your source branch. The publish command refuses a dirty working tree.
2. Run gates 1 to 5. Record the last line of each.
3. Build the snapshot without a push:

   ```sh
   python3 scripts/publish_portable.py --no-push
   ```

4. Inspect the snapshot: `git show portable --stat`. Check that each new file is in `PUBLISH` of `scripts/publish_check.py`.
5. Push only after the maintainer approves the release:

   ```sh
   python3 scripts/publish_portable.py
   ```

   The command pushes two refs by name: the branch `portable` to the destination named by `--remote` and `--remote-branch`, and the tag `portable/<yyyymmdd>-<source sha>` of this snapshot. It pushes no other tag and no other branch. When the snapshot did not change, for example after a build with `--no-push`, it pushes the snapshot tag that already points at the snapshot commit. The commit and the tag carry the neutral identity `tenant-pi portable`.

6. Record the tag, the gate results and the open gaps in the release notes.
7. Update the documentation site of the kit, if you maintain one: set the new tag in its version file, run its capture script, and update the pages that changed. (The maintainers' site is tenant-docs; its `README.md` section `New release of a project` has the steps.)

Never publish with `--skip-checks`.

Warning: `--force` can replace an existing remote snapshot chain, but it does not remove earlier tags.

Use a new, empty repository for a new-root publication; see [publishing](../publishing.md#a-new-history).

## Add a file to the publish set

A new tracked file must be in `PUBLISH` of `scripts/publish_check.py`, or under a `PUBLISH_DIRS` rule. For a private copy, create the optional `scripts/dev-only-files.txt` and list reviewed files or directory prefixes that must not publish. A portable copy needs no list. Otherwise the publish check fails with `unreviewed_file: repository inventory`. Review the file for secrets and host values before you add it.

The publish check also applies [the public reader rules](../publishing.md#public-reader-rules): no reference to a private tracker, no machine path, no dated record of one host and no value of a deny list. `python3 scripts/publish_check.py --public` lists each finding.

## Documentation check

`scripts/doc_check.py` checks the Markdown files of `PUBLISH`. It uses the Python 3.11 standard library, runs offline, starts no process and writes nothing.

The unit tests of gate 1 run the same check, so a release needs no separate command. Run the script directly to see the list of findings:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/doc_check.py
```

It prints `doc check valid: <n> files, <n> links, <n> json blocks, <n> actions (offline text checks only)` and exits with 0. Else it prints one line for each finding, sorted, then `doc check failed: <n> findings`, and exits with 1. A finding is `rule: path:line`. It never holds text of the file.

| Rule | Meaning |
| --- | --- |
| `link_missing` | A relative link names a file that does not exist. |
| `link_outside` | A relative link leaves the repository. |
| `link_unpublished` | A link names a file outside the publish set. A portable snapshot does not hold it. `DEV_ONLY_TARGETS` in `scripts/doc_check.py` can name an optional private-copy target that is permitted; the list is empty. |
| `anchor_missing` | A `#anchor` matches no heading of the target file. The anchor form is the GitHub heading form. |
| `json_example` | A fenced `json` block is not one JSON document and not JSON Lines. |
| `cli_action` | `tenant_pi.py <action>` names an action that the parser does not have. |
| `cli_flag` | A flag after `tenant_pi.py <action>` is not an option of that action. In the guides and in `README.md`, a code span that holds only a flag must be a kit option or a reviewed flag of another program. |
| `env_name` | In the guides and in `README.md`, a `TENANTEXT_*`, `PI_*` or `WIKI_*` name is not in the manifest and not a launch-line name. |
| `action_unguided` | An action of the parser is not named in any guide under `docs/guides/`. |
| `doc_missing`, `doc_text` | A file of `PUBLISH` is absent, is a link, or is not UTF-8. |

The check reads the parser of `scripts/tenant_pi.py` in the same process: it imports the module and stops `main` at `parse_args`. So the check follows each change of the CLI.

Limits:

- The package documents under `packages/` are not checked. They have their own test suites.
- A flag in prose outside a code span is not checked.
- The check proves that a link resolves and that a command has a valid shape. It does not prove that a command works.
