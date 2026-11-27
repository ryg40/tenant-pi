# Commands and skills

Walkr has two modes: [Compare](compare.md) and [Feedback](feedback.md). Compare has the command `walkr-compare` and the agent skill `walkr-compare`; Feedback has the command `walkr-feedback` and the agent skill `walkr-feedback`.
The skill `walkr` is the entry: it leads a request that names Walkr to Compare or Feedback.

Core, Double, Coinflip, Trainer and the shared GUI are retired since 2026-11-23. The release tag `portable/20261122-548259a` is the last release with their code and their guides.

## Commands

Each command shows help with no arguments and with `--help`, `-h` or `help`. Each command accepts `--version`.

- `walkr-compare` runs the Compare commands. `walkr compare ...` is the same.
- `walkr-feedback` runs the Feedback commands. `walkr feedback ...` is the same.
- `walkr setup` installs the skills. It starts no server.

Each `walkr-compare` and `walkr-feedback` command except help and `close` starts the Walkr server in the background when no compatible server runs.
No command opens a chat, loads a Pi extension or requests a model.

### Retired command names

An older install has links for `walkr-core`, `walkr-double`, `walkr-coinflip` and `walkr-trainer`. Each name now prints one line that names `walkr-compare` and the tag, and exits with code 2. `walkr <file>` and the other Core commands of `walkr` do the same.
The installer of the package and `install.sh --upgrade` of the kit remove these links when they point to this clone.

### Retired routes and records

The server has the Compare and Feedback routes, `/theme.css`, `/theme.js` and `/health`. Each other path answers 404 and writes nothing.
A saved record of a retired mode stays on disk untouched: the Core state file `~/.human-review/state.json`, the Double archive `~/.local/.walkr/double` and the Trainer datasets `~/.local/.walkr/trainer`. No Walkr code reads them. Remove them by hand when you do not need them.

## Skills

`walkr setup` installs the three skills: `walkr`, `walkr-compare` and `walkr-feedback`.
The [install guide](../INSTALL.md) runs it for you.

```sh
walkr setup            # this project
walkr setup --global   # your user
```

| Scope | Skills | Pi prompt aliases | Agent guidance |
| --- | --- | --- | --- |
| Project | `.claude/skills`, `.agents/skills` in the current directory | `.pi/prompts` | A short block in `AGENTS.md` |
| Global | `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills` | None | None |

`walkr setup --help` prints help without writing files, even with `--global`.

Setup writes the absolute path of your clone into each skill. Keep the clone in its place.

### Use the skills

- Claude Code: `/walkr`, `/walkr-compare`, `/walkr-feedback`.
  `/walkr compare cfn options` and `/walkr simplify ticket` start the two [Compare workflows](compare.md#two-workflows). `/walkr-feedback` starts a [Feedback](feedback.md) session for a component preview, decision tree, or grill-me walkthrough.
- Pi: the bare commands `/walkr`, `/walkr-compare` and `/walkr-feedback` are prompt aliases from a project setup. `/skill:walkr` is the native Pi skill command.
- Other agents read the installed skills by name.

Each Pi prompt alias tells the agent to read one installed skill file. It passes your text as request data.
Request data gives no tool, chat or extension authority.

### Install for a Pi profile

Global setup writes no Pi prompt aliases. For a Pi profile, call the exported API in `src/setup.js` with an explicit absolute `piAgentDir`:

```sh
node --input-type=module <<'JS'
import os from 'node:os';
import { installSkills } from './src/setup.js';
console.log(installSkills(process.cwd(), {
  global: true,
  home: os.homedir(),
  piAgentDir: '/absolute/path/to/pi-profile',
  dryRun: true,
}).join('\n'));
JS
```

`dryRun: true` runs every check and writes nothing. It prints each planned action.
Run the same call from the clone directory. Put the absolute path of your Pi profile in `piAgentDir`.
Then run it again with `dryRun: false` to install.

### Conflicts and updates

Setup checks every target before it writes anything. A conflict in the last target leaves the earlier targets unchanged.

- Setup records the hash of each generated file in `.walkr-setup.json`. An update replaces only unchanged generated files.
- A generated file that you changed, an unknown file of the same name, or a symbolic link at a target stops setup with the exact path.
- Setup never follows or replaces a symbolic link.
- The skills and the Pi prompts of the retired modes: setup removes a file that its record names and that is unchanged, and then the empty skill folder. A retired file that you changed stays, and setup prints its path. A file that no record names is not touched.
- A known old `human-review` skill moves to `.walkr-setup-backups/human-review-<hash>` in the same agent directory.
  Known old `AGENTS.md` guidance changes to the short Walkr block. Changed guidance stays and setup prints a warning.

The discovery check reads only the selected agent directories and the Pi profile in `piAgentDir`.
It does not scan parent directories, other Pi profiles, other configured resource paths or packages. Check those by hand.
The check reads skill frontmatter with a strict subset of YAML. It can refuse a valid skill with unusual frontmatter, for example a quoted multiline `description`.

There is no force option. Resolve each conflict by hand, then run setup again.
Use one setup at a time. Setup does not roll back a failed write.

## Compatibility names

Walkr comes from Human Review. These names stay for compatibility:

- The `HUMAN_REVIEW_*` environment variables.
- The `x-human-review-token` header of the local HTTP API.
- The default state directory `~/.human-review`.

The old `/human-review` skill is not installed. Setup replaces a known copy of it.
