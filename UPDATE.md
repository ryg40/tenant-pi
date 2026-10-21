# Update

This page is for a user who keeps this repository as the agent configuration of Pi.

## Get the changes

1. Pull the changes. Git merges them with your own commits and stops at a conflict.

   ```sh
   git pull
   ```

2. Run the checks below. Each command must exit with 0.
3. In each open Pi session, type `/reload`. Pi loads the changed extensions, skills and prompts again.

## Checks

```sh
python3 scripts/check.py --tier fast
cd packages/tenantext && npm ci && npm test && npm run typecheck
```

The Tenantext tests and the type check need the Pi packages linked into `packages/tenantext/node_modules`; see [package tests](docs/packages.md#tests).

## The Pi version

The tested Pi version has one home: `piVersion` in `config/manifest.json`. `piAcceptedRange` beside it is the range of an installed Pi that the checks accept.

To move to a new Pi version, for example `1.4.0`:

1. Run the pin editor from the repository root. It sets `piVersion`, `piAcceptedRange` (up to the next minor line) and the core `spec` in `config/manifest.json`.

   ```sh
   PYTHONDONTWRITEBYTECODE=1 python3 scripts/pi_update.py pin --version 1.4.0
   ```

2. Install that Pi version, then run the checks. `git diff --stat` shows the one changed file.
3. Commit the file.
