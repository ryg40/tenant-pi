# After the install

This page is for the time after [the install](INSTALL.md). Each task below is one change to the profile directory `<profile>`, or one command in the clone `<clone>`. Use the `PI_CODING_AGENT_DIR` of the profile for each `pi` command.

## Get a new version of the kit

Run `git pull` in the clone, then type `/reload` in each Pi session. See [UPDATE.md](UPDATE.md).

## Add or remove an optional module

Run `./install.sh --upgrade <name> --shell bash --with wiki --yes` to add Wiki in the same profile and refresh its alias. Choose the shell and modules you use. Other module commands appear in [the optional modules](INSTALL.md#optional-modules). Then run `/reload`. To remove a module, run `pi remove` with the same source:

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi remove npm:pi-hermes-memory
```

## Update the npm modules

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi update --extensions
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" node "$HOME/tenant-pi/scripts/patch_extension_peers.mjs"
```

The first line moves each module without a version, such as a package that you added yourself, to the newest version of the registry. It does not change a module with an exact version: each npm module of the kit has one. After a kit update, `install.sh --upgrade <name> --with <modules>` installs the versions of `config/manifest.json`; see [the module versions](UPDATE.md#the-module-versions). The second line corrects the host-provided peers again; see [host peer overrides](docs/host-peer-overrides.md).

## Change the model or the login

Use `/login`, `/model` and `/scoped-models` inside Pi. Press `Ctrl+S` in `/model` to save a model as the default. Pi writes these choices into `<profile>`; the kit does not read them.

## A template of the kit changed

`install.sh` writes `settings.json` and `models.json` only when they are absent, so a profile keeps the copy of its install. Compare the files by hand, and copy a change that you want:

```sh
diff "$HOME/tenant-pi/config/settings.example.json" "$HOME/.pi/profiles/main/settings.json"
```

## Add a second profile

Run `./install.sh --new <name> --shell bash --with none --yes`, or answer its prompts. Choose `zsh` for Zsh. The name selects both `~/.pi/profiles/<name>` and its managed alias. Existing names are refused. Profiles share the clone, but not login or session files. A memory module can use shared storage.

## Remove the kit

1. Remove the links of the kit in `~/.claude/skills`. Each one points into `<clone>/packages/tenantext/skills`.
2. Remove the profile directory, or remove `<clone>/packages/tenantext` from the `packages` list of its `settings.json`.

Warning: the profile directory holds the login (`auth.json`), the sessions and the memory of its modules. Removing it deletes them.
