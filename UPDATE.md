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
