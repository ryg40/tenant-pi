# Install Walkr

Walkr Compare is a local tool. It shows 2 or 3 prepared options of one change in your browser on `localhost`. You pick one option, and your agent reads the result.

Compare is the one mode of Walkr. Core, Double, Coinflip, Trainer, the shared GUI and hosted mode are retired since 2026-11-23; the release tag `portable/20261122-548259a` is the last release with their code.

This page installs Walkr from a clone of this repository. The [question list](skills/walkr-install/SKILL.md) is for an agent that installs Walkr for a user.

Words used below:

- `<clone>`: the directory of this repository, for example `~/walkr`.
- `<bin>`: the directory for the command links. The default is `~/.local/bin`.

## Prerequisites

- Node.js 20.19.0 or newer. The `engines` field of `package.json` holds the minimum.
- Git, any current version.
- A browser on the same computer.
- Linux or macOS. Windows is not supported.

Check the version:

```sh
node --version
```

Run `install.sh`, or follow [the manual steps](#manual-install).

## Clone

Walkr is the package `packages/walkr` of the tenant-pi kit. Clone the kit, then go to the package. `<kit clone>` is the directory of your kit clone:

```sh
cd <kit clone>/packages/walkr
```

`install.sh --with walkr` of the kit links the commands and installs the skills for you; see the module guide of the kit, `docs/guides/modules.md`, section walkr. The steps below are the install of Walkr by itself.

Keep the clone in its place. The command links point into it.

## Run install.sh

```sh
./install.sh
```

The script does these steps, in this order:

1. It checks Node.js. It stops when Node.js is too old. The package has no runtime dependency, so no npm step runs.
2. It links two commands into `<bin>`: `walkr` and `walkr-compare`.
3. It removes a link of this clone for a retired command (`walkr-core`, `walkr-double`, `walkr-coinflip`, `walkr-trainer`). A file or a link of another owner with such a name stays.
4. It installs the Walkr agent skills with `walkr setup`.

The script asks where the skills go, then asks for approval. It never uses `sudo`. It writes only into your home directory, `<bin>` and the clone. It stops before the first write when a link name is occupied by another target.

### Options

| Option | Effect |
| --- | --- |
| `--bin-dir <dir>` | Link the commands into `<dir>` in place of `~/.local/bin`. |
| `--project <dir>` | Install the skills into the project `<dir>`. The directory must be inside your home directory or inside the clone. |
| `--global` | Install the skills for your user, in `~/.claude`, `~/.codex` and `~/.agents`. |
| `--skip-setup` | Link the commands only. Install no skills. |
| `--dry-run` | Print each action. Change nothing. |
| `--uninstall` | Remove the command links that the script made. See [Uninstall](#uninstall). |
| `--yes` | Do not ask. Without `--project` or `--global`, the skills go into the current directory. |
| `--help` | Show the options. |

Without a terminal, give `--yes` and one of `--project`, `--global` or `--skip-setup`.

The script refuses a home, clone, bin or project path that contains a newline or another control character. This includes a path that gets such a character through a symbolic link.

Examples:

```sh
./install.sh --dry-run --global
./install.sh --global --yes
./install.sh --project ~/code/my-site --bin-dir ~/bin
```

### Where the skills go

`walkr setup` installs two skills: `walkr` and `walkr-compare`. It removes the skills and the Pi prompts of the retired modes that an earlier setup wrote and that are unchanged; see [Commands and skills](docs/modes.md#conflicts-and-updates).

- Project: `<project>/.claude/skills`, `<project>/.agents/skills`, Pi prompt aliases in `<project>/.pi/prompts`, and a short block in `<project>/AGENTS.md`.
- Global: `~/.claude/skills`, `~/.codex/skills` and `~/.agents/skills`. Global setup installs no Pi prompt aliases.

Setup stops with a conflict message when a target file is a link or was changed by hand. It changes no file in that case.

## First comparison

Make sure that `<bin>` is on `PATH`. In an agent with the skills, ask for a comparison, or type `/walkr compare cfn options`.
The agent prepares the options and gives you the private URL of the page. `walkr-compare --help` lists the commands; [Compare](docs/compare.md) explains the page and the request format.

## Uninstall

```sh
./install.sh --uninstall
```

Give the same `--bin-dir` as for the install. The script removes each link in `<bin>` that points into this clone. It keeps every other file in `<bin>`.

The script does not remove the skills. To remove them, delete these files from the directories in [Where the skills go](#where-the-skills-go):

- the two folders `walkr` and `walkr-compare` in each `skills` directory,
- the `.walkr-setup.json` file in each of `.claude`, `.codex`, `.agents` and `.pi`,
- the files `walkr.md` and `walkr-compare.md` in `.pi/prompts` of a project,
- the block between `<!-- walkr:start -->` and `<!-- walkr:end -->` in `AGENTS.md` of a project.

Then delete the clone.

## Manual install

Use these steps when `install.sh` cannot run.

```sh
cd ~/walkr
ln -s "$PWD/src/cli.js" ~/.local/bin/walkr
ln -s "$PWD/src/walkr-compare.js" ~/.local/bin/walkr-compare
node src/cli.js setup --global
```

## Troubleshooting

### Node.js is too old

`install.sh` prints `Node.js 20.19.0 or newer is required`. Install a newer Node.js, for example with your version manager. Then run `install.sh` again.

### `walkr: command not found`

`<bin>` is not on `PATH`. The installer prints a warning in that case. Add the line to your shell startup file, for example `~/.bashrc` or `~/.zshrc`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Open a new shell, then run `walkr --help`.

### A link name is already in use

The installer stops with `exists and is not a link to this clone`. Another program uses the name, or an old clone has the link. Move the file away, or choose another directory with `--bin-dir`.

### The port is in use

Walkr chooses a free port by default. You can set a fixed port with `HUMAN_REVIEW_PORT`. When another program uses that port, the server prints `could not listen on port` and stops. Choose another port:

```sh
HUMAN_REVIEW_PORT=4802 walkr-compare open
```

### Setup reports a conflict

A skill file exists and differs from the Walkr copy, or it is a link. Setup changes nothing in that case. Move the named file away, then run `install.sh` again.
