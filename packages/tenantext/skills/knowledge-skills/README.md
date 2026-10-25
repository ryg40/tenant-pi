# knowledge-skills

`knowledge-skills` is an optional skill component of the kit.
It ships MIT skills from `inkeep/open-knowledge-skills` for Claude Code and Pi.
Each skill has a `SKILL.md`, an `agents/openai.yaml` and a `CREDITS.md`.
One shipped copy serves both harnesses.

Each folder of this directory is one skill. `resources.skills` of `knowledge-skills` in `config/manifest.json` names the shipped ones. The `description` of each `SKILL.md` says when to use the skill.

## Install

The core install of the kit loads each skill in the profile, and `install.sh` of the kit links each skill into `~/.claude/skills/`.

For user-level links, run:

```sh
packages/tenantext/skills/knowledge-skills/install.sh
```

- The script accepts no flags. It has the same behavior as the coordinator-skills install script.
- It links each skill into `~/.claude/skills/` when `~/.claude` exists.
- It links each skill into `~/.pi/agent/skills/` when `~/.pi/agent` exists.
- It replaces existing links, including broken links. It reports and preserves targets that are not links.
- It is safe to run again. If the kit moves, run the script again to update the links.
- `KNOWLEDGE_SKILLS_HOME` replaces the home directory for a test.

Start a new session, or run `/reload` in Pi, to load the skills.

## Gaps and project runtime skill

The component stays `unverified`.
Offline tests check text and install links.
They do not load the component with the kit Pi pin or run a model through the skills.

The OpenKnowledge MCP server and the `ok` CLI are external tools.
The kit does not install or configure them.
The optional `okf` plugin supplies conformance feedback in an OpenKnowledge project.
The shipped `plugin.json` describes the upstream starter pack; the kit does not activate that plugin.
The OKF skill retains its `type: Document` frontmatter.

The kit ships the MIT `open-knowledge` skill from `inkeep/open-knowledge-skills`.
`ok init` also writes a project-local copy into each detected agent's skills directory.
The project copy takes precedence in an OpenKnowledge project.
The kit excludes the GPL copy from `inkeep/open-knowledge`.
Installing the kit skill alone does not initialize an OpenKnowledge project.
The discovery skill only covers setup and discovery.

## Credits and checks

All its skills use upstream commit `66571d24bdfd08faae2a5e91849b01f9686a2a9c`.
Each `CREDITS.md` records the source paths, source comparison and adaptations.
The MIT licence text is in `../../licenses/open-knowledge-skills-MIT.txt`.
The kit additions use the package MIT licence.

The kit tests `tests/test_skill_invariants.py` and `tests/test_knowledge_skills.py` check this component.
The install test uses a temporary home and changes no user skill directory.
See [coordinator-skills](../coordinator-skills/README.md) for the separate planning and coordination component.
