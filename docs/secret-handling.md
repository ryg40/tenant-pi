# Secret handling

`scripts/scan.sh` stops a secret or a host value before it goes to a remote. It needs no network. tenant-pi builds no image, so the scan has no image mode.

The comment at the top of `scripts/scan.sh` is the reference of the scan: its modes, what each mode reads, the levels, the environment variables, the exit codes and the host needs. Each list file of the scan explains its format in its own header: `scripts/host-values.deny`, `scripts/host-values.regex`, `scripts/host-values.allow`, `scripts/host-values.allow-lines` and `.gitleaks.toml`. This page gives the facts that the files do not give.

## What the scan finds

The scan has three classes of finding:

- A secret: a rule of `.gitleaks.toml`. It always fails.
- A host value: text that identifies a private host, such as its private network, its host names, its owner names and its state directories. It fails at level `fail` and prints a warning at level `warn`. The branch `portable` and a tag `portable/*` must not contain host values, so the level there is `fail`.
- A policy finding: a tracked file that can hide content from the scan. It always fails.

A finding names the file, the line and the rule. It never shows the secret value.

Use the modes like this:

- `staged`: the hooks `pre-commit` and `pre-merge-commit` run it.
- `history <range>`: the commits of a branch before you merge or push it.
- `all`: before a full release; see [the release checklist](guides/release-checklist.md#gate-5-the-scan-record).
- `selftest`: after a change of a deny list. It proves that each rule still finds its sample.

### Deny lists

`scripts/host-values.deny` is tracked and holds generic patterns only. The values of one host go into the untracked `.local/host-values.deny` on that host. A pattern of a real host in a tracked file puts that host value into the tree that the scan forbids. Do not copy a line of the local list into a tracked file, a report or a commit message.

The local list is optional: a clone of a published snapshot has none. A linked worktree uses the local list of the main checkout.

The rule ids are `host-value-<n>` for the tracked list and `host-value-local-<n>` for the local list. For a rule of the local list, the output gives the rule id only. Thus a scan does not print a value of the local list on the screen, in a hook or in a log. To see the pattern of `host-value-local-<n>`, read pattern `<n>` of `.local/host-values.deny` on that host.

`scripts/publish_check.py` reads the same deny lists, the allow list and the accepted lines for the files of the publish set; see [the public reader rules](publishing.md#public-reader-rules).

### Exceptions

- `scripts/host-values.allow` holds exact URLs that can stay in tracked files.
- `scripts/host-values.allow-lines` holds single lines that the maintainer accepted, by path and hash of the exact text. The hash accepts the line for every deny-list rule, now and later. Review the list when the deny lists change.
- At level `warn`, the scan skips host-value findings in the paths of `scripts/dev-only-files.txt`. At level `fail`, this exception does not exist, and a portable snapshot excludes these paths.

No exception hides a secret finding, a policy finding or a finding of `scripts/host-values.regex`.

### Policy findings

| Policy | Why |
| --- | --- |
| A tracked file named `.gitleaksignore`, `.gitleaksbaseline`, `.betterleaksignore` or `.betterleaksbaseline` | Such a file can hide a finding. |
| A tracked file in `.local/` at the root | `.local/` holds values of one host, and the scan does not report the patterns of its deny list. |
| A tracked archive, database dump or Git bundle | The scan cannot read the content line by line. |

A "gitleaks:allow" or "betterleaks:allow" comment does not hide a finding, also not a host value.

### Blind spots

- `staged` and `history` do not read into an archive. An archive of a format that the policy check does not know is not found.
- A secret that is split over lines, encrypted, or encoded in more levels than the scan decodes is not found.
- The author and committer names and e-mail addresses, tag messages and notes are not scanned.
- The hooks run only where `scripts/install-hooks.sh` ran, and `--no-verify` skips them (section "Hooks").

## Rules for changes

1. Allowlist secrets by content only: `regexes` or `stopwords` in `.gitleaks.toml`. Do not add `paths` for secret rules. A path allowlist hides each future secret in that path.
2. Keep each allowlist entry narrow. Write the reason in a comment above it.
3. An allowlist must not name a host-value rule in `targetRules`. The scan stops with exit 2 when it does.
4. After each change of `.gitleaks.toml`, `scripts/host-values.deny`, `scripts/host-values.allow`, `scripts/host-values.regex` or `scripts/scan.sh`, run `sh tests/test_scan.sh`. After a change of `.local/host-values.deny`, run `scripts/scan.sh selftest`. The pre-commit hook runs `scripts/scan.sh selftest` when one of the tracked files is staged.
5. Do not add a value of a real host to `scripts/host-values.deny`; add it to `.local/host-values.deny`.
6. Add a line to `scripts/host-values.allow` or `scripts/host-values.allow-lines` only after a decision of the maintainer. For an accepted line with a new value class or reason, record it in the section "Accepted host values in the publish set" below.
7. `scripts/host-values.regex` must not contain an address. Its header gives the format of a rule and its sample.
8. Do not write a token or a host value into a tracked file, also not into a test. Build it at run time from parts, as `tests/test_scan.sh` does.
9. Do not use `gitleaks:allow`, `betterleaks:allow`, `.gitleaksignore`, `.betterleaksignore` or a baseline to accept a finding. Correct the content, or add a narrow content allowlist (rules 1 and 2).

`.gitleaks.toml` keeps the rule set of gitleaks v8.30.1 under Betterleaks. Its header lists the differences from the default configuration. A change of the rule set is a separate decision. For that change, take the default configuration of the new rule set, apply the differences of the header again, and run `sh tests/test_scan.sh`.

## Scanner

The scanner is the Betterleaks binary at the version that `BETTERLEAKS_VERSION` in `scripts/scan.sh` pins. A missing binary or another version stops the scan with exit code 2. `BETTERLEAKS_BIN` names another binary.

### Pinned checksums

The [Betterleaks v1.9.0 release](https://github.com/betterleaks/betterleaks/releases/tag/v1.9.0) has one archive for each platform. The lines below come from its `checksums.txt`.

| File | SHA-256 |
| --- | --- |
| `betterleaks_1.9.0_linux_x64.tar.gz` | `f8b185a39ffcece2a1ca82bf3a4e7435cd81963ffd16b7a9128daf75f35f6de7` |
| `betterleaks_1.9.0_linux_arm64.tar.gz` | `1d39116e0a58dc94574715e2aa12a2dbd5062f193eee3fec011fef6ba06bd13b` |
| `betterleaks_1.9.0_darwin_arm64.tar.gz` | `83dd7eaab13d44a1e8e347a17064cdef153a1478db473276d41b38d55613d3f2` |
| `betterleaks`, extracted from the linux x64 archive | `0ace40b41652344608f89967fe93c6caf4faae9a4df20423632c7efb02a4d4e1` |

The extracted binary has a pinned checksum for linux x64 only. On the other platforms, the checksum of the archive covers the binary.

### Install Betterleaks

The steps use linux x64. On linux arm64, use the file name and the checksum of `betterleaks_1.9.0_linux_arm64.tar.gz` and leave out step 5. On macOS, use `betterleaks_1.9.0_darwin_arm64.tar.gz`, use `shasum -a 256 -c` in place of `sha256sum -c`, and leave out step 5; [the macOS guide](guides/macos.md#scanner-the-betterleaks-binary) gives the other differences.

1. Make an empty directory and go into it.

   ```sh
   cd "$(mktemp -d)"
   ```

   `pwd` must print the new directory.

2. Download the archive.

   ```sh
   curl -fsSLO https://github.com/betterleaks/betterleaks/releases/download/v1.9.0/betterleaks_1.9.0_linux_x64.tar.gz
   ```

   The command must end with exit code 0.

3. Check the archive against the pinned line.

   ```sh
   echo 'f8b185a39ffcece2a1ca82bf3a4e7435cd81963ffd16b7a9128daf75f35f6de7  betterleaks_1.9.0_linux_x64.tar.gz' | sha256sum -c
   ```

   The command must print `betterleaks_1.9.0_linux_x64.tar.gz: OK`. Stop at any other output.

4. Extract the binary.

   ```sh
   tar -xzf betterleaks_1.9.0_linux_x64.tar.gz betterleaks
   ```

   The command extracts only the binary.

5. Check the extracted binary (linux x64 only).

   ```sh
   echo '0ace40b41652344608f89967fe93c6caf4faae9a4df20423632c7efb02a4d4e1  betterleaks' | sha256sum -c
   ```

   The command must print `betterleaks: OK`.

6. Install the binary into a directory on `PATH`.

   ```sh
   install -m 755 betterleaks /usr/local/bin/betterleaks
   ```

   `/usr/local/bin` needs root. Without root, use a directory of your own on `PATH`, for example `~/.local/bin`.

7. Check the version.

   ```sh
   betterleaks version
   ```

   The command must print `1.9.0`. Observed on linux x64: the output is `1.9.0`.

Optional: when `cosign` exists, check the signature of `checksums.txt`. Download `checksums.txt` and `checksums.txt.sigstore.json` from the release into the same directory, then run:

```sh
cosign verify-blob --bundle checksums.txt.sigstore.json \
  --certificate-identity https://github.com/betterleaks/betterleaks/.github/workflows/release.yml@refs/tags/v1.9.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  checksums.txt
```

The command must print `Verified OK`. Then compare the line of your archive in `checksums.txt` with the pinned line. Not verified: this signature check. The kit was not tested with `cosign`.

### Update Betterleaks

1. Choose the new version. Change `BETTERLEAKS_VERSION` in `scripts/scan.sh`.
2. Replace the pinned checksums above with the lines of the new `checksums.txt`. Replace the checksum of the extracted binary.
3. Install the new binary with the steps above.
4. Requalify: run `sh tests/test_scan.sh`. Each test must pass.

## Hooks

```sh
scripts/install-hooks.sh           # install the dispatcher, set core.hooksPath
scripts/install-hooks.sh --check   # exit 0 if installed and current
scripts/install-hooks.sh --uninstall
```

Warning: `core.hooksPath` is shared configuration. One run of `scripts/install-hooks.sh` changes the main checkout and each worktree.

| Hook | Scan |
| --- | --- |
| `pre-commit` | `scripts/scan.sh staged`. The level follows the current branch. |
| `pre-merge-commit` | The same as `pre-commit`. `git merge` runs this hook, not `pre-commit`, when it records a merge commit without a conflict. |
| `pre-push` | One `scripts/scan.sh history` for the commits that the push sends. The strictest local or remote ref sets the level for the whole push, so a push of `portable` or of a `portable/*` tag has the level `fail`. |

Each worktree runs the hooks and `scripts/scan.sh` of its own branch; the comment at the top of `scripts/install-hooks.sh` explains how. A hook fails closed: if the hook script, `scripts/scan.sh` or the right Betterleaks binary is missing, the commit or the push stops. After the repository moves to another path, run `scripts/install-hooks.sh` again. `--check` reports it.

### The range of a push

The pre-push hook scans the commits that the remote does not have. It knows the remote only through the remote-tracking refs `refs/remotes/<remote>/*`. Its result line has the form `pre-push: result <pass|fail>; range <revisions>; level <level>`. The release notes use that line as the snapshot-range record.

Limits of the range:

- The range is only as current as the last `git fetch <remote>` or `git push` to that remote. An old remote-tracking ref makes the range larger, so the hook can refuse a commit that the remote already has. Run `git fetch <remote>` and push again.
- After a forced push from another clone or a change of the remote URL, run `git fetch --prune <remote>` before the push.
- A first publication to a new remote has no remote-tracking ref, so the hook scans all of the history. An old finding refuses that push.
- The hook does not scan a commit that the remote has under another ref. To scan all of the history of a ref, run `scripts/scan.sh --level fail history <ref>`.
- The hook trusts each ref under `refs/remotes/<remote>/`. A ref that a person writes with `git update-ref` makes the range smaller, with the same effect as `--no-verify`.
- Do not use two remote names where one is the start of the other, such as `a` and `a/b`.
- The hook does not scan the message of an annotated tag.

Warning: `git commit --no-verify` and `git push --no-verify` skip the hooks.

Follow gate 5 of the [release checklist](guides/release-checklist.md). Only the full release class requires `scripts/scan.sh all`.

## Test

```sh
sh tests/test_scan.sh
```

The test runs offline in temporary repositories under `/tmp`. It installs the hooks only in a temporary clone and does not change the configuration of this repository. It needs the Betterleaks binary of the pin.

## Accepted host values in the publish set

The lines of `scripts/host-values.allow-lines` stay in the portable publication, accepted one by one by path and hash. The file is the list. No line holds a host value. Each line is sample data of a tracker feature, for example a synthetic fixture of the tracker tests: the rule `tracker-reference` of the public reader check finds the form "issue" or "ticket" with a number, and it cannot tell sample data from a reference. The list accepts the text, not a line number.

A scan at level `fail` on the tree of `portable` passes with this list. A change of an accepted line needs a new decision. When a maintainer accepts a new line, add its path and hash to the file. If its rule, value class or reason is new, add it to this section. Delete an entry that matches no file. Do not write a host value here.

## Identities that leave with a portable snapshot

The scan does not read commit metadata (section "Blind spots"). A commit and an annotated tag carry the Git identity of the host that writes them.

So `scripts/publish_portable.py` writes the snapshot commit and the tag with a neutral identity and no signature. `--help` names the default identity and the variables and options that change it. A signature is left out also when the Git configuration of the host asks for one, because a signature holds the key identity of the host.
