# Host-provided peer overrides for Pi extension packages

Status: reviewed script and offline test. The kit does not install it, run it, or configure a service.
The observations below use Pi 0.99.1. Not verified: the same runtime behaviour with Pi 1.0.3, the kit pin.

## Why it is needed

Observed with Pi 0.99.1: Pi supplies some modules to extensions at runtime, for example `@earendil-works/pi-tui` and `typebox`. It warns at each start when an installed extension package lists one of them under `dependencies`:

```
Warning: Extension package ".../package.json": Host-provided extension packages must be declared in
peerDependencies with a "*" range, not dependencies: typebox.
```

An installed copy can bypass the extension loader and create a duplicate runtime module. These published packages have the defect at the versions of the table:

| Package | Version checked | Module to move to `peerDependencies` |
| --- | --- | --- |
| `pi-hermes-memory` | 0.9.9 | `@earendil-works/pi-tui` |
| `@juicesharp/rpiv-ask-user-question` | 2.11.0 | `typebox` |
| `@zosmaai/pi-llm-wiki` | 0.12.4 | `@earendil-works/pi-tui`, `typebox` |

`pi-hermes-memory` and `@zosmaai/pi-llm-wiki` are the sources of the optional `hermes` and `wiki` modules of this kit. `@juicesharp/rpiv-ask-user-question` is not a kit module; the script skips a package that is not installed.

## What the script does

`scripts/patch_extension_peers.mjs` edits only the installed `package.json` of each listed package. It removes the named module from `dependencies` and sets it to `"*"` in `peerDependencies`. It changes no package code, no lockfile, and no other package. It is offline and safe to run again. When a package author publishes a fix, the script makes no change for that package.

```sh
node scripts/patch_extension_peers.mjs                 # <agent-dir>/npm; honours PI_CODING_AGENT_DIR
node scripts/patch_extension_peers.mjs /path/to/npm    # an explicit npm root
```

Restart Pi after a change. The script needs Node 18 or later.

## Cause

This is not a defect of one host. Two facts cause it together:

- Pi 0.99.0 added the check. `dist/core/resource-loader.js` reads the manifest of each extension package and warns when `dependencies` names a module from a fixed host-provided list. Earlier Pi versions did not check.
- The package versions in the table list the modules under `dependencies`. The warning depends on that declaration, not on the host.

The risk behind the warning is real but small. Observed with Pi 0.99.1: npm installed `@earendil-works/pi-tui` 0.85.1 for `@zosmaai/pi-llm-wiki`. Pi's extension loader points extension imports to its own copy, so the old copy is used only if a dependency loads it directly. The override removes the declaration and the warning. It does not remove the installed copy. The permanent correction is a new release from each package author.

## Reapply it automatically after each extension update

An npm install or update of a package writes the upstream manifest again, so the warning comes back.

A `postinstall` script in `<agent-dir>/npm/package.json` is not sufficient. npm runs the root `postinstall` script only for a bare `npm install`. Observed with Pi 0.99.1: Pi installs and updates a package with `npm install <spec> --prefix <agent-dir>/npm --legacy-peer-deps` (`dist/core/package-manager.js`, `getNpmInstallArgs`). npm 10.9 does not run the root script for that form.

### Recommended: the Pi `npmCommand` setting

Pi runs each package command through the documented `npmCommand` setting. `scripts/pi_npm_wrapper.sh` runs the real command, then runs the override script on the same npm root after an install, update, or uninstall. It keeps the exit status and writes nothing to stdout, because Pi reads the stdout of lookup commands. It needs no root access and no service.

```sh
mkdir -p ~/.pi/agent/local-overrides
install -m 0644 scripts/patch_extension_peers.mjs ~/.pi/agent/local-overrides/patch-extension-peers.mjs
install -m 0755 scripts/pi_npm_wrapper.sh ~/.pi/agent/local-overrides/pi-npm-wrapper.sh
```

Then add this key to the top-level object of `settings.json` in the agent directory, with the absolute path of the wrapper:

```json
{
  "npmCommand": ["/ABSOLUTE/AGENT/DIR/local-overrides/pi-npm-wrapper.sh", "--", "npm"]
}
```

The `"--", "npm"` entries tell Pi that the package manager is npm. The wrapper finds the override script beside itself under either file name.

Limit: this covers only package commands that Pi runs. An npm command that a person or another tool runs directly in the npm root does not pass through the wrapper.

### Alternative: a systemd path unit

On a Linux host with systemd, a path unit that watches the two npm lockfiles also covers manual npm commands and plugin managers. It needs root access. The user of the host installs it; the kit only prints it.

`/etc/systemd/system/pi-extension-peers.service`:

```ini
[Unit]
Description=Reapply host-provided peer declarations to Pi extension manifests

[Service]
Type=oneshot
# Let npm finish writing the tree before the manifests are edited.
ExecStartPre=/bin/sleep 5
ExecStart=/usr/bin/node /ABSOLUTE/PATH/TO/patch-extension-peers.mjs /ABSOLUTE/AGENT/DIR/npm
```

`/etc/systemd/system/pi-extension-peers.path`:

```ini
[Unit]
Description=Watch the Pi extension npm tree for installs and updates

[Path]
PathChanged=/ABSOLUTE/AGENT/DIR/npm/package-lock.json
PathChanged=/ABSOLUTE/AGENT/DIR/npm/node_modules/.package-lock.json
Unit=pi-extension-peers.service

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload
systemctl enable --now pi-extension-peers.path
```

Observed with Pi 0.99.1: the wrapper reapplies the override after package updates and removes the warning. Not verified: the systemd path unit.

## Startup reminder

`extensions/peer-override-reminder.ts` is a Pi extension. At the first session start with a user interface it reads `settings.json` and the manifests of the npm packages that `settings.json` loads. It shows one warning alert when one of these conditions is true:

- A loaded package lists a host-provided module under `dependencies`. The alert gives the command to run. It also names each package that is not in the override list of the script.
- The override script is missing from `<agent-dir>/local-overrides/`.
- `npmCommand` in `settings.json` does not point to the wrapper, or the wrapper file is missing.

It shows nothing when no action is necessary. It changes no file and runs no command. Install it with:

```sh
install -m 0644 extensions/peer-override-reminder.ts ~/.pi/agent/extensions/peer-override-reminder.ts
```

Observed with Pi 0.99.1: the reminder extension loads without an error. Not verified: the alert in the interactive interface.

## Limits

- The list of packages is fixed in the script. A new package with the same defect needs a reviewed edit.
- The script does not remove a duplicate module copy that npm already installed under the package. It removes only the declaration that causes the warning.
- This is a local runtime override. Report the defect to each package author; remove the entry when a fixed version is pinned.
