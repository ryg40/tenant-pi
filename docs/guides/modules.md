# Module guide

`<pin>` is `runtime.piVersion` in `config/manifest.json`. Read that field for the current value.

Each component of `config/manifest.json` is one row below. Core Pi is always on. Every other component is optional and independent: enable it, or leave it in `selection.disable`.

The table is the state of this release. It is not a claim that a module works on a clean client.

## Status labels

The manifest has three statuses. This guide maps them to four labels. The same labels are in [the setup guide](setup.md#labels-for-a-prerequisite).

| Label | Meaning | From |
| --- | --- | --- |
| `blocked` | The kit refuses to enable the module. `validate` stops with `blocked_component: overlay.selection.enable`. | Manifest status `blocked`. Also a refused choice, for example the gateway with `auth: "login"` (`pi_login_blocked`). |
| `skipped` | The user did not enable the module. Nothing is generated for it. | The module is in `selection.disable`. This is the state of every module except `core` in the sample overlay. |
| `unverified` | The kit validates, plans and generates the module offline. No accepted live trial proves that Pi loads it and that it works. | Manifest status `tested` or `unverified`, when the module is enabled. |
| `ready` | The module passed an accepted live trial on the qualified platform. | No module has this label in this release. |

The manifest status `tested` means: the pin and the structure passed an offline review. It does not mean a clean-client trial. The manifest status `unverified` means: the module is in the tree and selectable, and the plan lists its `gaps` as readiness gaps. So both map to `unverified`.

Not verified: loading all selectable Tenantext components with the kit pin. The labels stay `unverified`.

## Components

Columns:

- **Required inputs**: the overlay fields and files the module needs, beyond `selection.enable`.
- **Maintained source (pin)**: the `source` of the manifest. `tree` is a package directory in this kit.
- **Credential method**: how a credential reaches the module. The kit never stores one.
- **State scope**: where the module or Pi keeps data at run time. "Profile" is the target directory. "HOME" is shared by every profile of the user.
- **Consent**: an explicit overlay switch that the module needs.
- **Status**: manifest status, then the label when enabled.

| Component | Required inputs | Maintained source (pin) | Credential method | State scope | Consent | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `core` | `target.agentDir` | npm `@earendil-works/pi-coding-agent@<pin>` | Pi native `/login` after launch; Pi writes `auth.json` | Profile: `auth.json`, `models-store.json`, `sessions/`, `bin/` (only for a tool download); `npm/` with a declared npm package. | none | `tested`, `unverified` |
| `model-routing` | `roles`, optional `modelRoutes`; `--registry` file when `modelRoutes` names a model | builtin Pi settings | Native provider `/login` | Profile: `settings.json` keys | none | `tested`, `unverified` |
| `tenantext` | none | tree `packages/tenantext` | none | Profile. Not verified: other paths. | none | `unverified`, `unverified` |
| `codex-accounts` | `modelRoutes.gateway` `{"auth": "env"}`, `endpoints.codex-accounts` (HTTPS URL that ends in `/v1`), `env.codex-accounts` `${TENANTEXT_LITELLM_API_KEY}` | tree `packages/tenantext` | `TENANTEXT_LITELLM_API_KEY` in the launching shell; `TENANTEXT_LITELLM_BASE_URL` on the launch line. `auth: "login"` is `blocked`. | Profile | none | `unverified`, `unverified` |
| `slopscore` | none | tree `packages/tenantext` | none | Not verified | none | `unverified`, `unverified` |
| `context-meter` | none | tree `packages/tenantext` | Reads the variable named by `nextMoveKeyEnv` for a Bearer header; [the credential reference](../packages.md#decision-server-credential) names the default key. With `nextMoveUrl` set, sends at most one POST after each agent run. The body holds session counters and the last 300 characters of the last user message, after whitespace normalization. An empty URL, disabled decisions, unknown context usage, an active request or failure cooldown prevents the request (source reading). | Reads and writes `<target>/context-meter/settings.json` (source reading). | none | `unverified`, `unverified` |
| `ops-footer` | `context-meter` enabled | tree `packages/tenantext` | No health credential. Sends GET requests to health URLs from `OPS_FOOTER_OK_HEALTH_URL`, `OPS_FOOTER_OV_HEALTH_URL` or its settings. Empty health URLs disable these requests (source reading). | Writes `<target>/ops-footer/settings.json` and `settings.example.jsonc`. Receives usage readings from the usage components; it does not read their login files itself (source reading). | none | `unverified`, `unverified` |
| `copilot-usage` | none | tree `packages/tenantext` | Reads the Pi `github-copilot` login, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, editor `github-copilot/apps.json` and `hosts.json`, Copilot CLI `config.json`, and `gh auth token`. Reads `GH_HOST` for the environment-token domain. Each poll sends candidate tokens in GET headers to `https://api.<domain>/copilot_internal/user` until one succeeds. Only an HTTP 401, 403 or 404 answer tries the next token. Mode `auto` needs a Copilot provider in Pi. Mode `on` probes regardless. Mode `off` sends nothing (source reading). | Reads profile settings and login state. Reads shared HOME files: `~/.copilot/config.json` or `COPILOT_HOME/config.json`, and editor files under `XDG_CONFIG_HOME`, `~/.config` or Windows `LOCALAPPDATA`. Refreshes and writes no credential (source reading). | none | `unverified`, `unverified` |
| `anthropic-usage` | none | tree `packages/tenantext` | Reads `~/.claude/.credentials.json` or `CLAUDE_CONFIG_DIR/.credentials.json`, then the Pi `anthropic` OAuth login. Each poll sends an active login token as Bearer authentication to `https://api.anthropic.com/api/oauth/usage` in a GET request. An authentication refusal tries the other active login, when available. Mode `off` sends nothing. Refreshes and writes no credential (source reading). | Profile login and settings; shared HOME login files (source reading). | none | `unverified`, `unverified` |
| `doctor` | none | tree `packages/tenantext` | Reads profile `auth.json` and configured Codex token files. Uses the credential sources, GET endpoints, authentication fallback and mode rules of the two usage rows above. Sends a token only when a login exists. Reads `TENANTEXT_LITELLM_BASE_URL` for a status line (source reading). | Reads profile and project settings, and OpenViking configuration when wiki embeddings are configured. `fix` writes extension settings and copies existing files to `.bak`. The shell form `npm run doctor -- --fix` can add the package to profile `settings.json`. It can remove package entries under `node_modules/@earendil-works` and replace them with symbolic links. Without `PI_CODING_AGENT_DIR`, the shell form uses the live `~/.pi/agent` (source reading). | none | `unverified`, `unverified` |
| `resources` | none | tree `packages/tenantext` | none | Profile: `settings.json` toggles | none | `unverified`, `unverified` |
| `herdr` | the `herdr` tool on `PATH`; the kit does not install it, and `check-herdr` reports it | tree `packages/tenantext`, `skills/herdr` | none | Herdr state, outside the profile | none | `unverified`, `unverified` |
| `herdr-relay` | `herdr` enabled, the `herdr` tool on `PATH`, Python 3 and the installed `herdr` skill | tree `packages/tenantext`, `skills/herdr-relay` | none | Herdr state and relay job files, outside the profile | none | `unverified`, `unverified` |
| `coordinator-skills` | On Pi: the `ask_user_question` tool of the `questions` component; without it the skill asks in plain text. For a search, a research ticket and a prototype ticket: the `herdr` skill. `wayfinder` needs `docs/agents/issue-tracker.md` and a Gitea tracker. The knowledge sources and the review tools that the skills name are host tools that the kit does not install. `dummies` needs the `okknow` command of OpenKnowledge for its log page; without it the skill writes no log | tree `packages/tenantext`, each skill directory below `skills/coordinator-skills/`; [the component README](../../packages/tenantext/skills/coordinator-skills/README.md) lists them | `GITEA_TOKEN` in the shell that starts the harness, for `to-spec`, `to-tickets` and `wayfinder`; the skills read it for the Gitea API and do not write it | The Gitea issue tracker, outside the profile. For `dummies`: the log page in OpenKnowledge, its state file in the configuration directory of the user, and, only with its autostart option, one marked block in the user instruction file of the harness (for Pi, the context file of the agent directory) | none | `unverified`, `unverified` |
| `knowledge-skills` | OpenKnowledge MCP server and `ok` CLI for tool-backed workflows; the kit installs neither | tree `packages/tenantext`, each skill directory below `skills/knowledge-skills/`; [the component README](../../packages/tenantext/skills/knowledge-skills/README.md) lists them | Configure external tools separately; no credential in the component | OpenKnowledge project and editor skill directories, outside the profile | none | `unverified`, `unverified` |
| `slopscore-pr` | host tools of the skill | tree `packages/tenantext`, `skills/slopscore-pr` | Not verified | Not verified | none | `unverified`, `unverified` |
| `tracker-site` | Python 3.11 or later and Git on `PATH`; `PYTHONPATH` set to `packages/tenantext`; no third-party Python package. `check-runtime` checks Python, not Git | tree `packages/tenantext` | Reads `GITEA_TOKEN`, the variable named by `issues.token_env`, or `issues.token_file`/`TRACKER_ISSUES_TOKEN_FILE`. Sends the token in GET headers to `issues.api` or `TRACKER_ISSUES_API`. Publication reads `publish.credential_file` and sends Bearer authentication with HTML in POST or PUT requests to `publish.endpoint`. Updates also send the receipt edit token; publication checks the share URL with GET (source reading). See [configuration](../../packages/tenantext/skills/tracker-site/references/configuration.md). | Writes the repository brief to `docs/tracker-brief.md`, or to `tracker-brief.md` when the repository has no `docs/`. Writes state under `~/.pi/agent/tracker-state/<repo-slug>/` by default. Writes receipts with edit tokens under `~/.pi/agent/tracker-publications/` by default. Both defaults are inside the live profile. The OpenKnowledge store reads `~/.claude.json` and `~/.pi/agent/mcp.json` for detection only; it keeps pending writes locally (source reading). | none | `unverified` |
| `promptr` | `npm ci --ignore-scripts` and `npm run build` in `packages/promptr` | tree `packages/promptr` | Reads `GITEA_TOKEN` or `GITHUB_TOKEN` for tracker GET headers. Tracker variables, a binding file or Git `origin` select the host; `GITHUB_API` can override the GitHub API origin. Reads `OPENKNOWLEDGE_USERNAME` and `OPENKNOWLEDGE_PASSWORD` for Basic authentication. Sends GET and POST requests to `OPENKNOWLEDGE_ORIGIN` or the package default; a connected briefing can name its own origin (source reading). | Writes profile `promptr/` and project `.promptr/` state. Writes shared OpenKnowledge project pages through the API (source reading). | none | `unverified`, `unverified` |
| `promptr-generate-task-prompt` | `promptr` | tree `packages/promptr` | The skill itself reads no credential. The extension uses the credentials and requests of `promptr` to prepare the flow (source reading). | As `promptr`; the skill reads a packet and writes the requested prompt file (source reading). | none | `unverified`, `unverified` |
| `promptr-handoff` | `promptr` | tree `packages/promptr` | The skill itself reads no credential. The extension uses the credentials and requests of `promptr`, including OpenKnowledge history sync (source reading). | As `promptr`; the skill reads evidence and writes the requested handoff file (source reading). | none | `unverified`, `unverified` |
| `promptr-openknowledge-project-pages` | `promptr`, an OpenKnowledge service | tree `packages/promptr` | Reads `OPENKNOWLEDGE_USERNAME` and `OPENKNOWLEDGE_PASSWORD` for Basic authentication in GET and POST requests to `OPENKNOWLEDGE_ORIGIN` or the package default (source reading). | As `promptr`; reads and writes shared project pages through the OpenKnowledge API (source reading). | none | `unverified`, `unverified` |
| `promptr-watch-herdr-agents` | `promptr`, the `herdr` tool | tree `packages/promptr` | none | as `promptr` | none | `unverified`, `unverified` |
| `mcp` | `inputs.mcpFile` `"inputs/mcp-adapter.json"` and that file under `--local-dir` | npm `pi-mcp-adapter`, no version; reviewed at 3.2.0 | `${NAME}` references in headers and env, exported by the user. OAuth and bearer stores use the OS keyring. | Profile: `mcp-adapter.json`, caches. HOME: OS keyring. `$TMPDIR`: spilled output. | none | `tested`, `unverified` |
| `questions` | none | npm `@juicesharp/rpiv-ask-user-question@2.13.8` | none | HOME: the guidance file of the extension, shared. Profile: `npm/` | none | `unverified`, `unverified` |
| `hermes` | `memory.hermes` block; `roles.memory` when `backgroundReview` is `true` | npm `pi-hermes-memory`, no version; reviewed at 0.9.9 | The parent session auth, or a child `pi -p` process | Profile: `pi-hermes-memory/`, memory files | `consent.memoryCapture: true` | `tested`, `unverified` |
| `wiki` | `memory.wiki` block | npm `@zosmaai/pi-llm-wiki`, no version; reviewed at 0.12.4 | none; the kit writes no key field | HOME: `~/.llm-wiki/`, or `<wikiHome>/.llm-wiki/` | `consent.memoryCapture: true` | `tested`, `unverified` |
| `openviking` | `memory.openviking` block; `npm ci --ignore-scripts` in `packages/openviking-pi`; an OpenViking server | tree `packages/openviking-pi`, a vendored copy; `settings.json` declares its `index.ts` as a local-file package source | `OPENVIKING_*` variables, `~/.openviking/ovcli.conf` or `~/.openviking/ov.conf`, set up by the user; the kit writes no endpoint and no key | HOME: `~/.openviking/`. Server: the sessions and the memories | `consent.memoryCapture: true` and `consent.remoteMemoryWrites: true` | `unverified`, `unverified` |

Observed with Pi 1.1.0: the first launch downloaded `fd` and `ripgrep` into `<target>/bin/`.

Rule from the Pi 1.1.0 source: Pi checks each tool in `<target>/bin/` first, then on the `PATH`. It checks `fd` locally and `fd` or `fdfind` on the `PATH`. For `ripgrep`, it checks `rg` in both places. At the start of an interactive session, Pi downloads only a missing tool. If both tools are available, Pi downloads neither. With both on the `PATH`, Pi creates no `bin/` in a new profile. The download needs network access. Without network access, Pi warns that the download failed and continues. With offline mode enabled, Pi warns and skips the download.

"Source reading" means a fact read in the source code of the package, not seen at run time.

Facts that hold for every row:

- `validate` and `plan` show each gap of an enabled module under `readinessGaps`. Read them before `generate`.
- An in-tree (`tree`) module points at the package directory of the clone by its absolute path. Keep the clone in place.
- `requires` IDs must be enabled too. `ops-footer` needs `context-meter`. Each Promptr skill needs `promptr`.
- `herdr-relay` is optional and disabled by default. No component requires it. Selecting it requires `herdr`; otherwise validation reports `missing_dependency`.
- The relay directory can be absent while the relay stays disabled. Enabling an absent relay reports `tree_resource_missing`.
- A module that the user leaves disabled contributes no file, no key and no launch-line assignment.

Use [the wizard](wizard.md) for scan-driven selection. To print the legacy numbered reference, run:

```sh
python3 scripts/tenant_pi.py components --format text
```

The action reads the manifest and writes nothing. With `--select` it prints the `selection` object for the IDs or the numbers that you choose. See [the CLI contract](../generator.md#components-the-checklist-of-the-components).

The legacy recommended set is not the fresh wizard selection. The wizard selects only core and retains loaded overlay choices. The marks are a proposal: the action enables nothing. The marked `copilot-usage`, `anthropic-usage` and `doctor` read login files, environment tokens and the `gh` login of the account. When a login exists, they send its token to the usage endpoint of the provider (source reading). The install flow of [INSTALL.md](../../INSTALL.md#stage-5-the-private-overlay) prints this list and waits for the answer of the user.

Source documents: [in-tree packages](../packages.md), [memory modules](../memory-modules.md), [workflow modules](../workflow-modules.md), [model routes](../model-routes.md).

## The Tenantext path

The Tenantext path is the in-tree components of `packages/tenantext`, with or without the gateway route.

Requirements:

| Item | Requirement | Source |
| --- | --- | --- |
| Pi | `<pin>`. No test starts a Pi session with the component on the kit pin. Each component keeps the gap `pi_line_unqualified`. | `config/manifest.json`, `packages/tenantext/README.md` |
| Node | `>=24.0.0 <25` | `packages/tenantext/package.json` `engines` |
| Source | `packages/tenantext` in the kit clone | [in-tree packages](../packages.md) |
| Dependencies | `npm ci --ignore-scripts` in `packages/tenantext`, by hand (setup Stage 6) | [setup guide](setup.md#in-tree-packages) |
| Gateway | `codex-accounts` enabled, `modelRoutes.gateway` `{"auth": "env"}`, the `/v1` URL and the `${TENANTEXT_LITELLM_API_KEY}` reference | [model routes](../model-routes.md) |

The native terminal interface stays. Pi loads each Tenantext component as a normal extension or skill through one `settings.packages` entry with a filter. The launch line is `pi --no-approve` with assignments in front. The kit installs no wrapper program, no other interface and no copy of the extensions.

An overlay fragment for the gateway route:

```json
{
  "selection": {"enable": ["core", "model-routing", "codex-accounts"]},
  "roles": {"interactive": {"provider": "litellm-codex", "model": "codex-auto/luna", "thinking": "high", "route": "gateway"}},
  "modelRoutes": {
    "schemaVersion": 1,
    "cycle": [{"provider": "litellm-codex", "model": "codex-auto/luna", "thinking": "high", "route": "gateway"}],
    "gateway": {"auth": "env"}
  },
  "endpoints": {"codex-accounts": "https://gateway.example.invalid/v1"},
  "env": {"codex-accounts": "${TENANTEXT_LITELLM_API_KEY}"}
}
```

This is a fragment, not a whole overlay. Move each enabled ID out of `selection.disable` too. The route also needs the registry file of the private directory, with one entry for each model that you confirm:

```json
{"litellm-codex": {"codex-auto/luna": ["high"]}}
```

Give the file with `--registry` to `validate`, `plan` and `generate`. Without the entry, `validate` stops with `unsupported_model_thinking: overlay.modelRoutes.choice`. The plan then lists the gaps `credential_missing`, `gateway_upstream_unverified` and `provider_auth_unverified`, beside the gaps of the component. The gateway aliases are `codex-auto/luna`, `codex-auto/sol` and `codex-auto/astra` of the provider `litellm-codex`. Not verified: a reply through a real gateway with a profile of this kit.

## Optional modules in short

- **Memory** (`hermes`, `wiki`): three parts together enable a module: the ID in `selection.enable`, `consent.memoryCapture: true`, and a `memory` block. Consent alone enables nothing. The wizard starts with both modules unchecked. Selection and storage/recall consent are separate decisions. Both store text of the sessions on this machine. Before `wiki` goes on, run `python3 scripts/tenant_pi.py check-wiki-vault`: the profile uses an existing vault as it is. Read [memory modules](../memory-modules.md) first. Hermes with `backgroundReview: true` makes model calls on its own; the install flow writes `false`.
- **MCP** (`mcp`): the server list goes into `inputs/mcp-adapter.json` of the private directory. Every `validate`, `plan` and `generate` then needs `--local-dir "$HOME/.config/tenant-pi"`. The kit disables the native Pi MCP with `-builtin:mcp`. Read [workflow modules](../workflow-modules.md) first.
- **Owner packages and directories**: `ownerPackages` adds a Pi package that you maintain. `ownerResources` adds a skills or prompts directory. See [owner packages](../owner-packages.md) and [owner resources](../owner-resources.md). Each entry adds a permanent `owner_package_unqualified` or `owner_resource_unqualified` gap.
- **Agent fan-out**: no subagents module exists. Use the `herdr` component or the Herdr skill installer. Pi inside Herdr is not qualified. The Herdr application is a host tool that the kit does not install. Read [Herdr and the question tool](../herdr-setup.md) first.
- **Questions** (`questions`): the Pi extension with the `ask_user_question` tool. It needs an interactive session. Without it, a skill asks in plain text. It is not an extension for Claude Code.

## Herdr and the question tool

The `herdr` component holds the Herdr skill. The Herdr application is a separate host tool. Check the command before you enable the component:

```sh
python3 scripts/tenant_pi.py check-herdr
```

The output names `present` with the version, `missing` or `unparsed`. The action installs nothing and starts no Herdr session. With `missing`, install Herdr from the source that you reviewed, then run the action again. Do not upgrade a present Herdr as a part of this setup.

The `questions` component adds the Pi question extension to one profile. The plan then prints two more setup lines: `pi install` with the source of the extension, and the peer override. Run them in Stage 6 of [the setup guide](setup.md).

For an install on a remote Linux host, print the SSH command lines first. The action runs none of them:

```sh
python3 scripts/tenant_pi.py remote-plan --ssh-target build-host --remote-user deploy --remote-home /home/deploy
```

Read each line, then run the lines that you approve in your own terminal. The lines add no SSH option, so your SSH configuration and your known hosts stay in force. A remote install is not qualified.

For a profile in a container, print the files and the command lines of a Compose seat first. The action writes nothing without `--write`, and it runs no command:

```sh
python3 scripts/tenant_pi.py compose-plan --uid 1000 --gid 1000 --public-key /home/EXAMPLE_USER/.ssh/id_ed25519.pub --gateway-url https://gateway.example.invalid/v1 --private-dir /home/EXAMPLE_USER/.config/tenant-pi --model codex-auto/astra
```

Read the overlay, the env file lines and each command line. The key line of the env file is empty: you paste the key value yourself. A Compose seat is not qualified. See [the Compose seat](../../deploy/compose/README.md).

After `generate`, `inventory --dir` shows two more results under `coordination`: whether the Herdr skill file is readable, and whether the question extension is declared or installed. A working session and a working question dialog are separate live checks.

Both components are `unverified`. [Herdr and the question tool](../herdr-setup.md) lists what no test proves.

## Change a selection

1. Edit `selection.enable` and `selection.disable` in the overlay. `python3 scripts/tenant_pi.py components --select <ids>` prints the complete `selection` object, with each required component.
2. Run `validate`. The command shows the first rule that fails, for example `missing_dependency: overlay.selection.enable`.
3. Run `plan` and read the new gaps.
4. Generate into a new target. See [the candidate update guide](candidate-update.md).
