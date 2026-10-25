# Update

This page is for a user who keeps this repository as the Pi configuration of a profile.

## Get the changes

1. Pull the changes. Git merges them with your own commits and stops at a conflict.

   ```sh
   git pull
   ```

2. In each open Pi session, type `/reload`. Pi loads the changed extensions, skills and prompts of `packages/tenantext` again.

A pull changes no file of the profile directory. The profile keeps its `settings.json` and `models.json`; see [A template of the kit changed](POST_INSTALL.md#a-template-of-the-kit-changed).

When the release notes name a package with `npm ci --ignore-scripts`, run that command in the folder of the package.

## Checks

A clean clone of a release tag needs no test run. For a clone with your own changes, run the checks. Each command must exit with 0.

```sh
python3 scripts/check.py --tier fast
cd packages/tenantext && npm ci && npm test && npm run typecheck
```

The Tenantext tests and the type check need the Pi packages linked into `packages/tenantext/node_modules`; see [package tests](docs/packages.md#tests).

## The Pi version

The tested Pi version has one home: `runtime.piVersion` in `config/manifest.json`. `runtime.piAcceptedRange` beside it is the range of an installed Pi that the checks accept.

To move to a new Pi version, for example `1.4.0`:

1. Move the pin from the repository root. The command changes only `config/manifest.json`.

   ```sh
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py pin --version 1.4.0
   ```

2. Qualify the version in an isolated work directory with a short path. The JSON has `passed: true` when each step passed. See [Pi update checks](docs/pi-update.md) for the range rule and the report.

   ```sh
   Q=$(mktemp -d /tmp/qpin.XXXXXX)
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py qualify --version 1.4.0 --workdir "$Q/run" > "$Q/qualify.json"
   ```

3. Install that Pi version, then run the checks. `git diff --stat` shows the one changed file.
4. Commit the file.

### With Pi-Bolt as the runtime

One Pi-Bolt release carries one Pi version. `pi_update.py pin` does not change `runtime.piBoltVersion`.

1. Find the Pi-Bolt release that carries the new pin. Its `--version` line starts with the pin. The Pi-Bolt releases on GitHub and the npm package `pi-bolt` list the releases.
2. Install that release. The Pi-Bolt installer reads a release tag from `PIBOLT_VERSION`, for example `bolt-v1.0.2`. `pi-bolt update` installs the latest release, which can carry another Pi version.
3. Set `runtime.piBoltVersion` in `config/manifest.json` to that release, in the same commit as the pin.
4. Check the runtime of the profile. The report shows the Pi version and the Pi-Bolt release.

   ```sh
   python3 scripts/check_runtime.py --launcher "$HOME/.local/bin/<name>"
   ```

The qualification of step 2 above runs plain Pi, not Pi-Bolt.

## The computer-use version

The `computer-use` module has an exact version. `pi update --extensions` does not move an exact `npm:` spec (source reading of the Pi package manager: it skips a pinned npm version). A new version needs three moves.

1. The kit: change `source.spec` of `computer-use` in `config/manifest.json` to the new exact version. Change each gap fact and each doc line that names the old version. Then run the qualification of the kit pin, as in step 2 of [the Pi version](#the-pi-version). The `profile-load` step installs the new spec and loads its extension and skill.
2. Each Pi profile: run the `computer-use` line of [the optional modules](INSTALL.md#optional-modules) with the new version, then type `/reload`. Pi replaces the old line of the profile settings, because the package name is the same. The postinstall script downloads the binary of the new version. `install.sh --upgrade <name> --with computer-use` does the same with the spec of the manifest.
3. Claude Code: run `claude plugin marketplace update computer-use-linux`, then `claude plugin update computer-use-linux@computer-use-linux`, and start a new session. The marketplace gives its newest release, which can differ from the kit pin; see [the Claude Code plugin](docs/guides/modules.md#claude-code-plugin).

`/tenantext-doctor` reports the installed version of a profile against the kit pin.
