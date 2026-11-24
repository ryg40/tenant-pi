# Walkr

Walkr Compare shows 2 or 3 prepared options of one change in your browser, side by side.
The options are versions of a code change or of a short text. Your coding agent prepares them.
You pick one option, comment, and rate the session with stars. The agent reads your result and goes on.
Everything runs on your computer. Walkr needs no account, cloud service or database.

Compare is the one mode of Walkr. The other modes are retired since 2026-11-23: Core (the page editor), Double, Coinflip, Trainer and the shared GUI. The release tag `portable/20261122-548259a` is the last release with their code. See the [changelog](CHANGELOG.md).

## Install

You need Node.js 20.19.0 or newer and Git. The package has no runtime dependency.

Walkr is the package `packages/walkr` of the tenant-pi kit. `install.sh --with walkr` of the kit installs it for Claude Code and for a Pi profile. To install Walkr by itself, with its command links:

```sh
cd <kit clone>/packages/walkr && ./install.sh
```

The script links the two commands `walkr` and `walkr-compare` into `~/.local/bin` and installs the agent skills.
The [install guide](INSTALL.md) explains each option, the manual steps and the uninstall.

## Quick start

1. Ask your agent for a comparison, for example `/walkr compare cfn options` or `/walkr simplify ticket`.
2. The agent prepares the options and runs `walkr-compare create`. It gives you the private URL of the page.
3. Read the options in the page, pick one, and select Submit (done) or Next round.
4. The agent gets your result from `walkr-compare wait`, and the page shows that the agent received it.

You seldom type these commands yourself. The agent skills tell the agent to run them.
`walkr setup` installs two skills: `walkr` and `walkr-compare`. `walkr setup --global` installs them for your user. The installer runs setup for you.

## Commands, page and data

| Part | Where |
| --- | --- |
| The page, the request format, the commands and the HTTP interface | [Compare](docs/compare.md) |
| The commands and the skills, and what setup writes | [Commands and skills](docs/modes.md) |
| A read-only page for the sessions of several computers | [Mirror](mirror/README.md) |
| The words | [Glossary](GLOSSARY.md) |

The artifacts server of the kit shows the Compare page in its section Walkr, on its own port. See `packages/artifacts/README.md` of the kit.

## Credits

Walkr is a fork of [Human Review](https://github.com/petergyang/human-review) 0.8.2 by Peter Yang, from upstream commit `f9a5581`, under the MIT license.

## License

MIT. See [LICENSE](LICENSE).
