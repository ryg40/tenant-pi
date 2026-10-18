# Secret handling

`scripts/scan.sh` stops a secret or a host value before it goes to a remote. It needs no network. tenant-pi builds no image, so the scan has no image mode.

## What the scan finds

| Finding | Source | Result |
| --- | --- | --- |
| Secret | The rules in `.gitleaks.toml` (the default rules of gitleaks v8.28.0) | Always fails. |
| Host value | One literal pattern for each line of `scripts/host-values.deny` and of the untracked `.local/host-values.deny`, and one regular expression for each line of `scripts/host-values.regex` | Fails at level `fail`. Prints a warning at level `warn`. |
| Policy | A tracked file named `.gitleaksignore`, `.gitleaksbaseline`, `.betterleaksignore` or `.betterleaksbaseline`; a tracked file in `.local/`; a tracked archive, database dump or Git bundle | Always fails. |

A host value is text that identifies a private host: its private network, its host names, its owner names and its state directories. The branch `portable` and a tag `portable/*` must not contain host values.

The output gives the file, the line, the rule and, in history mode, the commit. It does not give the secret value (`--redact`). A finding in a commit message shows as `(commit message):<line>`. A finding in a file name shows as `(file names):<n>`. The number `<n>` is a line of a file list. The list is `git ls-files` in mode `tree` and `git diff --cached --name-only` in mode `staged`. In mode `history`, the list holds the files that the commit changes.

### Deny lists

The literal patterns come from two files with the same format:

| File | Tracked | Content |
| --- | --- | --- |
| `scripts/host-values.deny` | yes | Generic patterns only. It holds no pattern now, only its header. |
| `.local/host-values.deny` | no (`.gitignore` ignores `.local/`) | The values of one host. |

A pattern of a real host in a tracked file puts that host value into the tree that the scan forbids. So the values of a host are only in `.local/host-values.deny` on that host. Do not copy a line of the local list into a tracked file, a report or a commit message.

The scan reads `scripts/host-values.deny` and the local file of the checkout that holds `scripts/scan.sh`. A linked worktree has no `.local/` directory, so the scan then reads the local file of the main checkout. If a linked worktree finds no local file, the scan prints `scan: note: no local deny list found` on standard error and continues. `SCAN_LOCAL_DENY=<path>` names another file. The local file is optional: a clone of a published snapshot has none. Without it, the scan uses the tracked list and `scripts/host-values.regex`. The deny lists and the regex list together must give at least one rule, else the scan stops with exit 2.

`scripts/publish_check.py` reads the same two deny lists, the allow list and the accepted lines for the files of the publish set; see `docs/publishing.md`, section "Public reader rules".

The rule ids are `host-value-<n>` for the tracked list and `host-value-local-<n>` for the local list. For a rule of the tracked list and for a regex rule, the output gives the pattern in parentheses after the rule id. For a rule of the local list, the output gives the rule id only. Thus a scan does not print a value of the local list on the screen, in a hook or in a log. To see the pattern of `host-value-local-<n>`, read pattern `<n>` of `.local/host-values.deny` on that host.

### Allow list

`scripts/host-values.allow` holds exact URLs that can stay in tracked files. It holds no URL now, only its header.

The scan applies the allow list after the deny lists:

- A deny-list finding is dropped when its line contains the pattern only inside an exact URL of the allow list.
- The same pattern in other text of the line is still a finding. A URL that differs in one character is still a finding.
- The allow list hides no secret finding, no policy finding and no finding of `scripts/host-values.regex`.
- The comparison of the URL is case-sensitive. Each line must be an `https` URL with a path, else the scan stops with exit 2.
- A finding inside an archive stays, because the scan cannot read the line.

### Accepted lines

`scripts/host-values.allow-lines` holds lines that the maintainer accepted one by one: `<path><TAB><sha256 of the exact line text without the line end>`. The file carries no host value, only paths and hashes.

- A deny-list finding is dropped when the line of that file has exactly the accepted text, in every copy the scan can read (the index and the working tree in tree mode, the blob in history mode). A changed line is a finding again.
- The entry holds a hash, not a line number: any line of the listed file with exactly this text is accepted. The same text in another file is a finding.
- The hash accepts the whole line for every deny-list rule, now and later. A deny pattern added later that matches an accepted line gives no finding; review the list when the deny lists change.
- The list hides no secret finding, no policy finding and no finding of `scripts/host-values.regex`.
- `scripts/publish_check.py` gives no public reader finding of any rule for an accepted line (`docs/publishing.md`). The scan itself still reports each finding of `scripts/host-values.regex` on that line.
- A path is relative, has no `..` segment, no quote, no backslash and no blank. A hash is 64 lowercase hex digits. Else the scan stops with exit 2.
- Compute a hash on Linux: `sed -n '<line>p' <path> | tr -d '\n' | sha256sum`. On macOS: `sed -n '<line>p' <path> | tr -d '\n' | shasum -a 256`.

### Development-only paths

At level `warn`, the scan skips host-value findings in paths listed in the optional `scripts/dev-only-files.txt`.
An entry names an exact repository-relative file or a directory prefix ending in `/`.
The generated `[[allowlists]]` entry of the scan configuration uses `paths` and `targetRules` limited to the generated `host-value-*` rules.
Secret rules and policy checks still cover those paths. Commit messages and file-name lists remain scanned.
At level `fail`, this path allowlist does not exist. A portable snapshot already excludes these development-only paths.
A missing or empty list adds no path exception.

### Private addresses

`scripts/host-values.regex` finds addresses of the private ranges 10/8, 172.16/12 and 192.168/16 and of the shared range 100.64/10. It also finds IPv6 unique local addresses (prefix fc00 with length 7). Loopback and documentation addresses give no finding. This document writes the ranges in this short form, because the scan reports a range in address form.

A version number can look like an address. Thus an IPv4 address gives a finding only when two conditions are true. First, the character before it is not a letter, a digit or one of `_ . - + : = < > ~ ^ !`. A single `=`, as in `host=`, is permitted. Second, the character after it is not a letter, a digit, `_` or `-`. It is also not a `.` followed by a letter or a digit. So a version pin after `==`, `>=`, `:` or `v` gives no finding. An address in a URL, after a blank, a quote, `@` or `=` gives one.

### Policy findings

The scan refuses what it cannot read or what switches it off:

| Policy | Why |
| --- | --- |
| A tracked file named `.gitleaksignore`, `.gitleaksbaseline`, `.betterleaksignore` or `.betterleaksbaseline` (any directory, any case) | A `.betterleaksignore` or `.gitleaksignore` with `<commit>:<file>:<rule>:<line>` hides a finding. |
| A tracked file in `.local/` at the root | `.local/` holds values of one host. The scan does not report host values in `.local/host-values.deny`, so a tracked copy of it must not pass. |
| A tracked archive, database dump or Git bundle | The content is compressed or binary. |

An archive, a dump or a bundle is known by its extension or by its first bytes:

- Extensions: `zip jar war ear whl egg apk aab ipa nupkg tar tgz taz tbz tbz2 tb2 txz tlz tzst gz bz2 xz zst lz lz4 lzma lzo z 7z rar cab cpio ar deb rpm iso dmg sql dump pgdump backup db sqlite sqlite3 db3 mdb accdb rdb bundle pack` (any case).
- Content: gzip, compress, zip, bzip2, xz, zstd, 7z, rar, ar and deb, lz4, lzip, rpm, cab, tar (`ustar` at byte 257), PostgreSQL custom dump (`PGDMP`), SQLite, Git bundle v2 and v3, Git pack, Redis dump, and a text dump with the header of `pg_dump`, `mysqldump` or `mariadb-dump` in the first 264 bytes.

Content does not switch the scan off. A "gitleaks:allow" or "betterleaks:allow" comment does not hide a finding (`--ignore-gitleaks-allow`), also not a host value. Betterleaks reads a `.betterleaksignore` or `.gitleaksignore` from the scanned directory. The scan gives it the Git directory in the modes `staged` and `history`. In the mode `tree`, the scan gives it a directory of its own. So a `.betterleaksignore` or `.gitleaksignore` in the working tree does not apply, also when it is not tracked.

## Modes

```sh
scripts/scan.sh tree                   # tracked files (working tree) and the staged content
scripts/scan.sh staged                 # the staged changes only (pre-commit, pre-merge-commit)
scripts/scan.sh history [<range>]      # commits in <range>, git log syntax, default HEAD
scripts/scan.sh all                    # tree and history
scripts/scan.sh selftest               # negative control
```

Exit code: `0` clean, `1` finding, `2` usage or tool error.

Untracked and ignored files (`.env`, `.local/`) are not in the scan of `tree`. They cannot go to a remote. The `.gitignore` rules keep them out of the index.

What each mode reads:

| Content | `tree` | `staged` | `history` |
| --- | --- | --- | --- |
| File content | working tree and index | staged changes | each commit |
| Content of an archive | yes, 3 levels deep (`--max-archive-depth 3`) | no | no |
| Target text of a symlink | yes | yes | yes |
| File names | tracked files | staged files | changed files of each commit |
| Commit messages | no | no | yes |
| Policy checks | tracked files | new or changed staged blobs | new files of each commit |

`all` is `tree` and `history HEAD`.

`staged` classifies only added or changed blobs, including rename destinations and changed symlinks.
Deleted files have no new blob. An empty staged diff runs no content scan. The script still checks the binary and its version.
Unchanged files remain covered by `tree` and `history`, not by the staged policy check.

### Merge commits in history mode

Betterleaks reads `git log -p`. That command prints no diff for a merge commit, so Betterleaks alone skips each merge commit. `scripts/scan.sh history` passes `--log-opts="--diff-merges=first-parent <range>"` to Betterleaks. Git then prints the diff of each merge commit against its first parent. The result:

- Content that a merge brings from its second parent gives a finding with the id of the merge commit.
- Content that only the merge commit adds gives a finding.
- The commits of the other parents stay in the range, so the scan also reads each of them. A secret that a side branch adds and then removes gives a finding.

The script does not use `-m --first-parent`. That form leaves the commits of the side branches out of the range. `--diff-merges=first-parent` needs Git 2.31 or later. Betterleaks runs the Git of the host, so the mode `history` needs Git 2.31 or later on the host.

The policy checks, the file names and the commit messages use `git diff-tree -m` for each commit of the range. So they also cover each merge commit.

### Negative control

`scripts/scan.sh selftest` proves that the rules work:

- It builds a synthetic token at run time from parts. The token has letters and digits, because a token of one repeated letter does not pass the entropy filter of the rule. The scan must find it on three lines, also with a "gitleaks:allow" comment.
- It writes one line for each pattern of both deny lists and for each sample of `scripts/host-values.regex`. The scan must find each one. So it also proves each pattern of the local deny list when that file exists.
- A file with version pins, loopback addresses and documentation addresses must give no finding.

### Blind spots

- `staged` and `history` do not read into an archive. The policy check stops a tracked archive by its extension or its content in each mode. An archive of a format that is not on the list, with a name that is not on the list, is not found.
- The scan decodes encoded text (for example base64) up to 5 levels deep (`--max-decode-depth 5`). A secret that is split over lines or encrypted is not found. A secret under more than 5 levels of encoding is not found.
- The author and committer names and e-mail addresses, tag messages and notes are not scanned.
- A pin with a blank after the operator (`pkg >= <version>`) of a version that is also a private address gives a false finding. An IPv4 address directly after `:`, `-` or a letter gives no finding.
- The hooks run only where `scripts/install-hooks.sh` ran, and `--no-verify` skips them (section "Hooks").

## Levels for host values

| Where | Default level |
| --- | --- |
| Branch `portable` | `fail` |
| A tag `portable/*` at `HEAD` | `fail` |
| Other branches | `warn` |

`--level warn` or `--level fail` sets the level. `SCAN_REF=<ref>` sets the refs that give the default level, for example `SCAN_REF=refs/tags/portable/20261001-abc1234` with a detached `HEAD`. The value can hold more than one ref, separated by blanks.

## Rules for changes

1. Allowlist secrets by content only: `regexes` or `stopwords` in `.gitleaks.toml`. Do not add `paths` for secret rules. A path allowlist hides each future secret in that path. The generated development-only path allowlist targets host-value rules only.
2. Keep each allowlist entry narrow. Write the reason in a comment above it.
3. `scripts/scan.sh` adds `targetRules` with all secret rules to each allowlist that has none, so that no allowlist hides a host value. An allowlist can set `targetRules` to fewer secret rules. A `targetRules` line that names a host-value rule stops the scan with exit 2.
4. After each change of `.gitleaks.toml`, `scripts/host-values.deny`, `scripts/host-values.allow`, `scripts/host-values.regex` or `scripts/scan.sh`, run `sh tests/test_scan.sh`. The test uses a copy of the scan with a local deny list and an allow list of its own. After a change of `.local/host-values.deny`, run `scripts/scan.sh selftest`. The pre-commit hook runs `scripts/scan.sh selftest` when one of the tracked files is staged.
5. A deny pattern is a literal string, case-insensitive. Quotes and backslashes are not allowed. Do not add a value of a real host to `scripts/host-values.deny`; add it to `.local/host-values.deny`.
6. Add a line to `scripts/host-values.allow` only after a decision of the maintainer. Each line is one exact URL. Add a line to `scripts/host-values.allow-lines` only after a decision of the maintainer, and record the file, the line, the value class and the reason in the section "Accepted host values in the publish set" below.
7. A regex rule in `scripts/host-values.regex` has a name, a sample and a regular expression (format in the file). The file must not contain an address.
8. Do not write a token or a host value into a tracked file, also not into a test. Build it at run time from parts, as `tests/test_scan.sh` does.
9. Do not use `gitleaks:allow`, `betterleaks:allow`, `.gitleaksignore`, `.betterleaksignore` or a baseline to accept a finding. The scan ignores the comment and refuses the files. Correct the content, or add a narrow content allowlist (rules 1 and 2).

A deny list contains the patterns that it forbids. The scan does not report host values in `scripts/host-values.deny` and in `.local/host-values.deny`. This exception is for host-value rules and these two paths only: the secret rules scan the files, and a copy at another path is reported.

`.gitleaks.toml` is the default configuration of gitleaks v8.28.0 with the five differences that its header lists:

1. Each path allowlist is removed.
2. The global allowlist entry `(?i)^true|false|null$` is replaced with `^(?i:true|false|null)$`. The default entry has no group, so it hides each secret that contains `false` or `null`.
3. The title is changed.
4. The section "Local allowlists" is added. It has three content allowlists: placeholder values, the test fixture of the in-tree Promptr package, and the test fixture of the vendored OpenViking Pi package.
5. The global table `[allowlist]` is changed to `[[allowlists]]`. The file holds more than one global allowlist, and only the array form permits that.

The fixture allowlist permits one exact value for the rule `generic-api-key`: the project key `promptr-abc123`. Three Promptr test files use it (`packages/promptr/test/project/workstreams.test.mjs`, `packages/promptr/test/project/browse.test.mjs`, `packages/promptr/test/tracker-binding/binding.test.mjs`). It is the only value that the scan reports in these files.

The OpenViking fixture allowlist permits one exact value for the rule `curl-auth-header`: the placeholder `bearer-value`. One test file uses it (`packages/openviking-pi/tests/capture-adapter.test.mjs`), in a command that the capture adapter must redact. The allowlist keeps the file equal to its upstream commit.

`.gitleaks.toml` keeps the rule set of gitleaks v8.28.0 under Betterleaks. A change of the rule set is a separate decision. For that change, take the default configuration of the new rule set, apply the five differences again, and run `sh tests/test_scan.sh`.

## Scanner

The scanner is the Betterleaks binary, version 1.9.0. `scripts/scan.sh` pins the version in `BETTERLEAKS_VERSION`.
Before each scan, the script runs `betterleaks version` and compares the output with the pin. The output `1.9.0` or `v1.9.0` passes.
A missing binary or another version stops the scan with exit code 2.

Each run uses `--redact`, `--max-decode-depth 5`, `--max-archive-depth 3` and `--ignore-gitleaks-allow`. The scan uses no network and starts no container.

| Variable | Use |
| --- | --- |
| `BETTERLEAKS_BIN` | The name or the path of the Betterleaks binary. Default `betterleaks`, found on `PATH`. |
| `SCAN_LOCAL_DENY` | Path of the local deny list. |
| `SCAN_REF` | The refs that give the default level. |

Host needs: a POSIX shell with `od` and `readlink`, Git 2.5 or later (tested with Git 2.39.5), and the Betterleaks 1.9.0 binary. The mode `history` needs Git 2.31 or later. A path with a blank, a comma or a colon works for the repository and for `$TMPDIR` (tested).

### Pinned checksums

The [Betterleaks v1.9.0 release](https://github.com/betterleaks/betterleaks/releases/tag/v1.9.0) has one archive for each platform. The lines below come from its `checksums.txt`.

| File | SHA-256 |
| --- | --- |
| `betterleaks_1.9.0_linux_x64.tar.gz` | `f8b185a39ffcece2a1ca82bf3a4e7435cd81963ffd16b7a9128daf75f35f6de7` |
| `betterleaks_1.9.0_linux_arm64.tar.gz` | `1d39116e0a58dc94574715e2aa12a2dbd5062f193eee3fec011fef6ba06bd13b` |
| `betterleaks_1.9.0_darwin_arm64.tar.gz` | `83dd7eaab13d44a1e8e347a17064cdef153a1478db473276d41b38d55613d3f2` |
| `betterleaks`, extracted from the linux x64 archive | `0ace40b41652344608f89967fe93c6caf4faae9a4df20423632c7efb02a4d4e1` |

The extracted binary has a pinned checksum for linux x64 only. On the other platforms, the checksum of the archive covers the binary.

### Install Betterleaks on Linux

The steps use linux x64. On linux arm64, use the file name and the checksum of `betterleaks_1.9.0_linux_arm64.tar.gz` and leave out step 5. For macOS, see [the macOS guide](guides/macos.md#scanner-the-betterleaks-binary).

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

   The archive holds `betterleaks`, `LICENSE` and `README.md`. The command extracts only the binary.

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

To update Betterleaks, take these steps:

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
| `pre-push` | One `scripts/scan.sh history` for the union of the pushed commit sets. The strictest local or remote ref sets the level for the whole push. `scripts/publish_portable.py` pushes the local branch `portable` to the remote branch `main`, so that push has the level `fail`. A new ref, also a new `portable` branch or `portable/*` tag, is scanned in the commits that the remote does not have: see [the range of a push](#the-range-of-a-push). |

### The range of a push

The pre-push hook scans the commits that the push sends. The table gives the range for each pushed ref.

| Pushed ref | Scanned commits |
| --- | --- |
| The remote ref exists and its commit is in the local repository | The commits from the remote commit to the local commit. |
| The remote ref is new, or its commit is not in the local repository | The commits of the local ref that no remote-tracking ref of the pushed remote contains (`refs/remotes/<remote>/*`). |
| The pushed remote has no remote-tracking ref, or the push names a URL and not a remote | All of the history of the local ref. |

The hook resolves each ref's range separately, then scans their union once with `--no-walk=unsorted` and explicit commit ids.
It does not combine exclusions across refs, because one ref's exclusion could hide a commit sent by another ref.
A branch and tag that share commits therefore scan those commits once.
If any local or remote ref requires `fail`, the whole union uses `fail`.
The hook prints one `pre-push: result <pass|fail>; range <revisions>; level <level>` line for the release record.
An empty union prints `range empty (no new commit)` and starts no scan.

The rule is the same for each ref. The level `fail` of a portable ref does not change the range. A new `portable/*` tag is scanned only in the commits that the remote does not have. Reason: each snapshot has each earlier snapshot as an ancestor. A scan of all of the history would refuse each new snapshot tag for one finding in an old snapshot commit. A new branch `portable` follows the same rule as the tag, for the same reason: the remote already holds the old commits, and a second scan cannot remove them.

Limits of the range:

- Follow-up: the union is one argument; a 128 KiB argument limit permits about 3,100 commits, and the result line lists every commit.
- Git gives the hook no list of the remote commits. The hook reads the remote-tracking refs, so the range is only as current as the last `git fetch <remote>` or `git push` to that remote.
- A remote-tracking ref that is older than the remote makes the range larger. The hook can then refuse a push for a commit that the remote already has. Run `git fetch <remote>` and push again.
- A remote-tracking ref can name a commit that the remote lost, for example after a forced push from another clone. The hook does not scan that commit. Run `git fetch --prune <remote>` before the push when the remote history can have changed.
- A first publication to a new remote has no remote-tracking ref, so the hook scans all of the history. For a portable ref the hook prints `pre-push: no remote-tracking ref of <remote>; scan all of the history of <ref>`. An old finding refuses that push.
- The hook does not scan a commit that the remote has under another ref. If another branch of the remote contains a commit with a host value, a new portable ref at that commit passes the hook. The hook controls the content that leaves, not the name of the ref. To scan all of the history of a ref, run `scripts/scan.sh --level fail history <ref>`.
- `git push` writes a tag to the remote, but it writes no remote-tracking ref for a tag. A commit that the remote has only under a tag is scanned again.
- The hook trusts each ref under `refs/remotes/<remote>/`. It does not check who wrote the ref. A ref that a person writes with `git update-ref` makes the range smaller, with the same effect as `--no-verify`.
- The refs belong to the name of the remote, not to its URL. After `git remote set-url`, the refs of the old URL still count. Run `git fetch --prune <remote>` after a change of the URL.
- A remote name can hold a `/`. A push to a remote `a` also counts the refs of a remote with the name `a/b`. Do not use two remote names where one is the start of the other.
- The hook scans commits. It does not scan the message of an annotated tag.

The install script copies `scripts/git-hooks/dispatch` to `<git-common-dir>/scan-hooks/`, once for each hook, and sets `core.hooksPath` to that absolute directory. The copy is outside the working tree. The dispatcher runs `scripts/git-hooks/<hook>` of the working tree where the hook runs. Thus each worktree uses the hooks and `scripts/scan.sh` of its own branch.

| State of the branch | Result |
| --- | --- |
| The hook and `scripts/scan.sh` are in the working tree | The scan runs. |
| The hook or `scripts/scan.sh` is missing from the working tree, but is in the index or in `HEAD` | The commit, merge or push stops (fail closed). This includes the commit that deletes `scripts/scan.sh`. |
| The branch never had them | No scan. The hook prints `this branch has no scripts/git-hooks/<hook> and no scripts/scan.sh; no scan`. |

A hook fails closed: if the Betterleaks binary is missing or has another version, the commit or the push stops.

After a change of `scripts/git-hooks/dispatch`, or after the repository moves to another path, run `scripts/install-hooks.sh` again. `--check` reports both cases. If the path in `core.hooksPath` does not exist, Git runs no hook and prints nothing.

Warning: `git commit --no-verify` and `git push --no-verify` skip the hooks.
Follow gate 5 of the [release checklist](guides/release-checklist.md). Only the full release class requires `scripts/scan.sh all`.
Development pushes and the publication push each print one `pre-push: result` line.
The publisher writes the publication line into the notes; do not repeat the range scan.

## Test

```sh
sh tests/test_scan.sh
```

The test runs offline. It uses temporary repositories and temporary bare remotes in a temporary directory under `/tmp`, and removes the directory at the end. It installs the hooks only in a temporary clone. It does not change the configuration of this repository. It needs the Betterleaks 1.9.0 binary (`BETTERLEAKS_BIN`). It needs no container and no image.

The test covers the negative control, a clean tree, a synthetic secret and a host value at both levels. It covers the allow list, the policy findings and the history with merge commits. It also covers the hooks (install, refusal, fail closed, uninstall) and the private address ranges.

## Accepted host values in the publish set

The lines below stay in the portable publication, accepted one by one by hash in `scripts/host-values.allow-lines`. No line holds a host value. Each line is sample data of a tracker feature: the rule `tracker-reference` of the public reader check finds the form "issue" or "ticket" with a number, and it cannot tell sample data from a reference. The line numbers can be out of date; the list accepts the text, not the number.

| File and lines | Rule | Reason |
| --- | --- | --- |
| `packages/promptr/test/workboard/prompt-draft.test.mjs` (4 lines), `packages/promptr/test/workboard/selection-board.test.mjs` (1 line) | `tracker-reference` | Sample issue titles of the workboard tests. |
| `packages/tenantext/README.md` (1 line), `packages/tenantext/slopscore/test/pr.test.ts` (2 lines) | `tracker-reference` | Sample output of the slopscore block, which counts tickets. |
| `packages/tenantext/tracker/tests/fixtures/pipeline-previous-brief.md` (4 lines), `packages/tenantext/tracker/tests/fixtures/pipeline-synthesis-long.md` (1 line) | `tracker-reference` | Synthetic fixtures of the tracker tests. |

A scan at level `fail` on the tree of `portable` passes with this list. A change of any of these lines needs a new decision. When a maintainer accepts a new line, list it by hash and add it to this table with the rule or the value class and the reason. Do not write a host value here.

## Identities that leave with a portable snapshot

The scan does not read commit metadata (section "Blind spots"). A commit and an annotated tag carry the Git identity of the host that writes them: the user name and the e-mail address of its Git configuration.

A snapshot carries a neutral identity. `scripts/publish_portable.py` sets the author, the committer and the tagger to the name `tenant-pi portable` and the e-mail `portable@tenant-pi.invalid`. The variables `TENANT_PI_PUBLISH_NAME` and `TENANT_PI_PUBLISH_EMAIL` replace the default; the options `--identity-name` and `--identity-email` replace the variables. An empty name or e-mail stops the command. The script applies the identity to `git commit-tree` and obtains the tagger identity with `git var GIT_COMMITTER_IDENT`. It writes the annotated tag object with `git mktag` before updating either ref. The snapshot commit and the tag carry no signature, also when the Git configuration of the host asks for one, because a signature holds the key identity of the host. The script sets `TZ=UTC` when creating the commit and reading the tagger identity, so both dates use `+0000`.
