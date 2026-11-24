# agy

The files of the kit component `agy`. They set up Antigravity CLI (`agy`) with the kit: two always-on rules, the kit skills, the kit command rules, and the OpenViking memory hooks. The installer script is `scripts/kit_agy.py`.

## What the component installs

`agy` reads its user files from `~/.gemini/`. The installer writes only the parts below.

| Place | What |
| --- | --- |
| `~/.gemini/config/rules/style.md` | Link to `rules/style.md`: the plain-English reply style, always on. The result format of a role prompt and the report form of the dummies skill come first; the plain-English rule applies to their content. |
| `~/.gemini/config/rules/tenant-kit.md` | Link to `rules/tenant-kit.md`: the terms line and a pointer to the kit skills, always on. |
| `~/.gemini/config/rules/tenant-kit-artifacts.md` | Link to `rules/tenant-kit-artifacts.md`, only with the module `artifacts`. |
| `~/.gemini/config/skills/<name>` | One link for each kit skill of the chosen modules. |
| `~/.gemini/config/hooks.json`, key `tenant-kit` | A `PreToolUse` handler for `run_command`: `hooks/pre-tool-use.mjs`. |
| `~/.gemini/config/hooks.json`, key `openviking` | `SessionStart`, `PreInvocation` and `Stop` handlers: the three OpenViking hooks. Only with the plugin, see below. |
| `~/.gemini/config/mcp_config.json`, `mcpServers.openviking` | `node <plugin>/servers/mcp-proxy.mjs`. Only with the plugin. |
| `~/.gemini/antigravity-cli/settings.json`, `permissions.allow` | `mcp(openviking/find)`, `mcp(openviking/search)`, `mcp(openviking/read)`. Only with the plugin. |

The installer also runs `herdr integration install antigravity-cli` when the `herdr` command is on `PATH`. It warns when `~/.bashrc`, `~/.bash_profile`, `~/.zshrc` or `~/.zprofile` holds the line `# Added by Antigravity CLI installer`: the `PATH` line below it can put plain `pi` and `claude` before the kit shims. It changes no shell file.

The component never touches `~/.gemini/GEMINI.md`, never writes the key `model`, and never installs the `agy` program.

## Preconditions

- The folder `~/.gemini/config` exists. It exists after `agy` ran one time and the user signed in. Without it, the installer prints one line and creates nothing.
- The OpenViking parts need the OpenViking Claude Code plugin: `~/.claude/plugins/cache/openviking/openviking-memory/<version>/servers/mcp-proxy.mjs`. The installer takes the newest version folder. Without the plugin, it writes no OpenViking part, removes its own older ones, and prints one line. The kit does not install the plugin.

## Remove

`kit_agy.py remove` deletes only the fixed names of the component, and only while they are the kit's: the links in `rules/` and `skills/` that point into the kit clone, the `hooks.json` keys `tenant-kit` and `openviking` when each command runs a file of the kit, `mcpServers.openviking` when it has the shape above, and the three allow rules. Everything else stays: the login, each other file under `~/.gemini/antigravity-cli/`, each other key, the `*.bak-<time>` backups, `~/.gemini/GEMINI.md` and the OpenViking cursors in `~/.local/state/agy-openviking/`.

`remove` leaves the parts that it cannot tell from the user's own: the empty `rules/` and `skills/` folders, and the empty keys and files that `apply` made (for example `hooks.json` as `{}`, `mcpServers` as `{}` and `permissions.allow` as `[]`).

A link in `rules/` or `skills/` is the kit's when its own target path lies in the kit clone. The installer does not follow a chain of links, so a user's link to a second link into the kit stays. A user link straight to a file of the kit clone counts as the kit's, because the kit must replace its own older links after a file moves inside the clone.

## JSON files

- A JSON file gets one backup `<name>.bak-<UTC time>` just before a write, and only when its content changes. When that name exists, the backup gets a counter: `<name>.bak-<UTC time>-2`, `-3`, and so on. A backup never writes over a file.
- A changed file is written again in full, with an indent of two spaces. The data and the key order stay; the spacing can change.
- A link, a file with invalid JSON, or a file that is not a JSON object is skipped with one line. A file whose `mcpServers`, `permissions` or `permissions.allow` has the wrong type (for example a list for `mcpServers`) is skipped the same way.
- `apply` replaces a `hooks.json` key `tenant-kit` or `openviking` whose command is not in the kit, and prints one line `replaced: ...` for it. Older installers wrote these keys with commands outside the kit, so the kit must take the keys over.

## Run apply again

- After an update of the OpenViking plugin: the `mcp_config.json` entry names the version folder of the plugin.
- After the kit clone moves: the `hooks.json` keys name the path of the clone. `remove` leaves keys with the old path, because they no longer point into the kit.

## The hooks

- `hooks/pre-tool-use.mjs` applies the kit command rules (`packages/tenantext/claude-code/scripts/command-rules.mjs`) to `run_command`. It finds the rule table by a path relative to its own real file. A denied command gets `{"decision":"deny","reason":...}` with the reason of the table; each other command gets `{"decision":"allow"}`, and `agy` applies its normal permission policy. A missing rule table allows the command and prints one line to stderr. The hook never blocks a session by its own error.
- `hooks/openviking-session-start.mjs`, `openviking-prompt-recall.mjs` and `openviking-capture.mjs` give `agy` the memory behavior of the OpenViking Claude Code plugin: session recall, prompt recall and capture. `hooks/openviking-lib.mjs` holds their shared code and the commit sweep of idle conversations. They import modules of the installed plugin at run time and never read the OpenViking connection themselves. Each one fails open: valid JSON on stdout, one line on stderr.

Variables of the OpenViking hooks:

| Variable | Effect |
| --- | --- |
| `AGY_OV_PLUGIN_ROOT` | The plugin folder, instead of the newest version folder of the plugin cache. The installer reads it too. |
| `AGY_OV_STATE_DIR` | The state folder, instead of `~/.local/state/agy-openviking/`. |
| `AGY_OV_DRY_RUN=1` | Send and save nothing; report on stderr. |

## Terms of the Antigravity service

The component installs files only. It never reads, copies, moves or prints the Antigravity login. The only file under `~/.gemini/antigravity-cli/` that the installer opens is `settings.json`, and only for the three allow rules. The rule `tenant-kit.md` tells the agent not to copy, print or reuse the login in another program, harness or proxy. No part of the kit runs `agy -p` or `agy acp` behind a model endpoint.

## Tests

```sh
npm test
```

The tests need no OpenViking plugin and no network.

## Not verified

- A live `agy` session with these files: the skills list, a denied command, an OpenViking recall.
- macOS. The setup ran only on Linux with `agy` 1.5.15.
- Classic Herdr with an `agy` pane.
- Whether `agy update` writes the installer `PATH` line again.
