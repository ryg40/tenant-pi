# okknow

The optional kit module `okknow`: a skill and a CLI for one OpenKnowledge (OK) server of the user. The kit skills `dummies`, `research`, `to-spec`, `to-tickets`, `wayfinder`, `retro` and `get-status` use it when it is present.

| Path | What |
|---|---|
| `skills/okknow/SKILL.md` | The skill: the path order (MCP first, then the CLI) and the write rules. |
| `skills/okknow/references/details.md` | Configuration, the setup wizard, tool names, the install, a server host, troubleshooting. |
| `skills/okknow/scripts/okknow` | The CLI (Python 3.11+, standard library only). |
| `skills/okknow/scripts/okknow-guard` | A write guard for a server host only. |

The package is separate from `packages/tenantext`, because Pi loads every skill of a package entry: a skill in `packages/tenantext/skills` would be in every profile. `install.sh --with okknow` adds this package to the profile, links the CLI to `~/.local/bin/okknow` and runs `okknow setup`. See the module guide `docs/guides/modules.md` of the kit.

The origin comes from the user config file or `OKKNOW_ORIGIN`, never from the code. The credentials stay in the environment of the user: `OPENKNOWLEDGE_USERNAME` and `OPENKNOWLEDGE_PASSWORD`. Nothing of the module writes them to a file.
